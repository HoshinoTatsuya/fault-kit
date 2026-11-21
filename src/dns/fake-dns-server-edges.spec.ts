import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { connect, createServer } from 'node:net';
import { expectPendingThrough } from '../assert/expect-pending-through';
import { nextTurn } from '../assert/next-turn';
import { roundTrips } from '../testing/round-trips';
import { settledResources } from '../testing/settled-resources';
import { addressToBytes } from './address-to-bytes';
import { dnsServerAddress } from './dns-server-address';
import { FakeDnsServer } from './fake-dns-server';
import { parseDnsQuery } from './parse-dns-query';

/** Запрос DNS: заголовок (id, RD, один вопрос) и вопрос `name`/`type`/класс IN. */
const query = (id: number, name: string, type = 1): Buffer => {
  const labels = name
    .split('.')
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
};

const framed = (message: Buffer): Buffer => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(message.length, 0);
  return Buffer.concat([prefix, message]);
};

/** Клиент TCP, собирающий кадры ответов: `frames` — тела ответов по порядку, `prefixes` — их длины из префикса. */
const tcpClient = async (port: number) => {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  const frames: Buffer[] = [];
  let waiters: Array<{ count: number; resolve(): void }> = [];
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
      frames.push(pending.subarray(2, 2 + pending.readUInt16BE(0)));
      pending = pending.subarray(2 + pending.readUInt16BE(0));
    }
    waiters = waiters.filter((waiter) => {
      if (frames.length >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return {
    socket,
    frames,
    whenFrames: (count: number) =>
      frames.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
  };
};

/** Сырой UDP-обмен: ответ или ничего (тогда — обещание, которое не разрешается). */
const udpExchange = async (
  port: number,
  message: Buffer,
): Promise<{ reply: Promise<Buffer>; close(): void }> => {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const reply = new Promise<Buffer>((resolve) => socket.once('message', resolve));
  socket.send(message, port, '127.0.0.1');
  return { reply, close: () => socket.close() };
};

describe('FakeDnsServer: края', () => {
  let server: FakeDnsServer;
  let witness: FakeDnsServer;
  const resolver = (target: FakeDnsServer, timeout = 10_000): Resolver => {
    const created = new Resolver({ timeout, tries: 1 });
    created.setServers([target.address]);
    return created;
  };
  const witnessAnswers = (count: number): Promise<void> => {
    const direct = resolver(witness);
    return roundTrips(count, () => direct.resolve4('witness.test'));
  };

  beforeEach(async () => {
    server = await FakeDnsServer.start({
      records: { 'Api.Test.': ['10.1.2.3', '2001:db8::7'] },
      ttlSeconds: 300,
    });
    witness = await FakeDnsServer.start({ records: { 'witness.test': ['10.9.9.9'] } });
  });

  afterEach(async () => {
    await server.close();
    await witness.close();
  });

  it('имя записи с точкой и в верхнем регистре; TTL записи — заданный', async () => {
    const exchange = await udpExchange(server.port, query(7, 'api.test'));
    try {
      const reply = await exchange.reply;
      expect(reply.readUInt16BE(0)).toBe(7);
      expect(reply.readUInt16BE(6)).toBe(1);
      const record = reply.subarray(query(7, 'api.test').length);
      expect({
        type: record.readUInt16BE(2),
        ttl: record.readUInt32BE(6),
        rdlength: record.readUInt16BE(10),
      }).toEqual({
        type: 1,
        ttl: 300,
        rdlength: 4,
      });
    } finally {
      exchange.close();
    }
  });

  it('тип запроса не A/AAAA (MX) у известного имени — NOERROR без записей, c-ares: ENODATA', async () => {
    await expect(resolver(server).resolveMx('api.test')).rejects.toMatchObject({ code: 'ENODATA' });
    const exchange = await udpExchange(server.port, query(9, 'api.test', 15));
    try {
      const reply = await exchange.reply;
      expect({ rcode: reply.readUInt16BE(2) & 0x000f, answers: reply.readUInt16BE(6) }).toEqual({
        rcode: 0,
        answers: 0,
      });
    } finally {
      exchange.close();
    }
    const unknown = await udpExchange(server.port, query(10, 'nobody.test', 15));
    try {
      expect((await unknown.reply).readUInt16BE(2) & 0x000f).toBe(3);
    } finally {
      unknown.close();
    }
  });

  it.each([
    ['короче заголовка', Buffer.alloc(11)],
    [
      'метка длиннее 63 (указатель сжатия)',
      Buffer.concat([query(1, 'a').subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]),
    ],
    ['метка за концом сообщения', Buffer.concat([query(1, 'a').subarray(0, 12), Buffer.from([5, 0x61])])],
    ['нет типа и класса', query(1, 'api.test').subarray(0, -3)],
  ])('битый запрос (%s): без ответа и не учтён; следующий целый — учтён', async (_name, broken) => {
    const exchange = await udpExchange(server.port, broken);
    try {
      await expectPendingThrough(exchange.reply, witnessAnswers(5), 'ответ на битый запрос');
      expect(server.queries()).toEqual([]);
      expect(await resolver(server).resolve4('api.test')).toEqual(['10.1.2.3']);
      expect(server.queries()).toHaveLength(1);
    } finally {
      exchange.close();
    }
  });

  it('TCP: два запроса одним куском — два ответа; запрос по одному байту — ответ; префикс — длина ответа', async () => {
    const client = await tcpClient(server.port);
    try {
      client.socket.write(Buffer.concat([framed(query(1, 'api.test')), framed(query(2, 'api.test'))]));
      await client.whenFrames(2);
      for (const byte of framed(query(3, 'api.test'))) {
        client.socket.write(Buffer.from([byte]));
        await roundTrips(1, () => witnessAnswers(1));
      }
      await client.whenFrames(3);
      expect(client.frames.map((frame) => frame.readUInt16BE(0))).toEqual([1, 2, 3]);
      expect(client.frames.map((frame) => frame.length)).toEqual(
        Array(3).fill(query(1, 'api.test').length + 16),
      );
      expect(server.queries().map((record) => record.transport)).toEqual(['tcp', 'tcp', 'tcp']);
    } finally {
      client.socket.destroy();
    }
  });

  it('TCP: молчание — запрос учтён, ответа нет, пока соседний сервер ответил 10 раз; задержка — ответ после', async () => {
    const client = await tcpClient(server.port);
    try {
      server.silence();
      client.socket.write(framed(query(4, 'api.test')));
      await server.waitForQueries(1);
      await expectPendingThrough(client.whenFrames(1), witnessAnswers(10), 'ответ по TCP под молчанием');
      server.respond();
      server.delay(60_000);
      client.socket.write(framed(query(5, 'api.test')));
      await server.waitForQueries(2);
      await expectPendingThrough(client.whenFrames(1), witnessAnswers(10), 'ответ по TCP под задержкой');
      server.delay(0);
      client.socket.write(framed(query(6, 'api.test')));
      await client.whenFrames(1);
      expect(client.frames.map((frame) => frame.readUInt16BE(0))).toEqual([6]);
    } finally {
      client.socket.destroy();
    }
  });

  it('TCP: клиент оборвал соединение (RST) — сервер жив и отвечает дальше', async () => {
    const client = await tcpClient(server.port);
    client.socket.write(framed(query(8, 'api.test')).subarray(0, 5));
    await roundTrips(3, () => witnessAnswers(1));
    client.socket.resetAndDestroy();
    await roundTrips(3, () => witnessAnswers(1));
    expect(await resolver(server).resolve4('api.test')).toEqual(['10.1.2.3']);
  });

  it('close уничтожает открытые TCP-соединения сервера', async () => {
    const probe = await FakeDnsServer.start();
    const client = await tcpClient(probe.port);
    const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
    await probe.close();
    await closed;
  }, 5000);

  it('close разрешается, когда соединения сервера ЗАКРЫТЫ (событие close), а не только начали закрываться', async () => {
    const probe = await FakeDnsServer.start();
    const client = await tcpClient(probe.port);
    // Клиент на паузе FIN сервера не замечает: его сокет стабильно открыт, и разница — ровно сокет сервера.
    client.socket.pause();
    for (let turn = 0; turn < 50; turn += 1) {
      await nextTurn();
    }
    const count = (): number =>
      process.getActiveResourcesInfo().filter((each) => each === 'TCPSocketWrap').length;
    const before = count();
    await probe.close();
    expect(count()).toBe(before - 1);
    client.socket.destroy();
  }, 5000);

  it("silence: неизвестный транспорт ('UDP', опечатка) — отказ, а не молча ничего", async () => {
    expect(() => server.silence('UDP' as never)).toThrow("транспорт — 'udp' или 'tcp', получено \"UDP\"");
    expect(() => server.silence('' as never)).toThrow(TypeError);
    expect(await resolver(server).resolve4('api.test')).toEqual(['10.1.2.3']);
  });

  it('waitForQueries: уже набранное — сразу; каждый ждущий — своего числа', async () => {
    const one = server.waitForQueries(1);
    const three = server.waitForQueries(3);
    await resolver(server).resolve4('api.test');
    await one;
    await expectPendingThrough(three, witnessAnswers(5), 'ждущий трёх запросов после одного');
    await expect(server.waitForQueries(1)).resolves.toBeUndefined();
    await resolver(server).resolve4('api.test');
    await resolver(server).resolve4('api.test');
    await three;
  });

  it('задержка и TTL: отрицательные и нечисловые — отказ', async () => {
    expect(() => server.delay(-1)).toThrow('задержка — число мс от 0 до 2147483647');
    // Больше потолка таймера Node setTimeout ставит 1 мс: «очень долго» стало бы «сразу».
    expect(() => server.delay(2 ** 31)).toThrow('потолок таймера Node; «никогда» — silence()');
    expect(() => server.delay(2 ** 31 - 1)).not.toThrow();
    server.respond();
    expect(() => server.delay(Number.NaN)).toThrow(RangeError);
    await expect(FakeDnsServer.start({ ttlSeconds: -1 })).rejects.toThrow('TTL — целое неотрицательное');
    await expect(FakeDnsServer.start({ ttlSeconds: 1.5 })).rejects.toThrow(RangeError);
    await expect(FakeDnsServer.start({ host: 'localhost' })).rejects.toThrow('сервер DNS слушает адрес IP');
  });

  /** TTL сверх 2³¹−1 (RFC 2181 §8) ронял ответ ERR_OUT_OF_RANGE уже при запросе — внутри обработчика сокета. */
  it('TTL сверх 2³¹−1 — отказ при старте, граница принимается', async () => {
    await expect(FakeDnsServer.start({ ttlSeconds: 2 ** 32 })).rejects.toThrow(
      'TTL — целое от 0 до 2147483647',
    );
    const edge = await FakeDnsServer.start({ records: { 'a.test': ['10.0.0.1'] }, ttlSeconds: 2 ** 31 - 1 });
    try {
      const answers = await resolver(edge).resolve4('a.test', { ttl: true });
      expect(answers).toEqual([{ address: '10.0.0.1', ttl: 2 ** 31 - 1 }]);
    } finally {
      await edge.close();
    }
  });

  it('QDCOUNT 0 — FORMERR без вопроса, а не молчание; запрос учтён', async () => {
    const empty = Buffer.alloc(12);
    empty.writeUInt16BE(77, 0);
    empty.writeUInt16BE(0x0100, 2);
    const exchange = await udpExchange(server.port, empty);
    try {
      const outcome = await Promise.race([exchange.reply, witnessAnswers(20).then(() => undefined)]);
      expect(outcome).toBeDefined();
      const reply = outcome as Buffer;
      expect([
        reply.readUInt16BE(0),
        reply.readUInt16BE(2) & 0x000f,
        reply.readUInt16BE(4),
        reply.length,
      ]).toEqual([77, 1, 0, 12]);
      expect(server.queries()).toEqual([{ name: '', type: 0, transport: 'udp' }]);
    } finally {
      exchange.close();
    }
  });

  /** Клиент ушёл, пока ответ ждал задержки: запись в закрытый сокет — не ошибка сервера. */
  it('TCP: клиент ушёл во время задержки ответа — errors() пуст', async () => {
    server.delay(300);
    const client = await tcpClient(server.port);
    const asked = server.waitForQueries(1);
    client.socket.write(framed(query(9, 'api.test')));
    await asked;
    const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
    client.socket.destroy();
    await closed;
    server.respond();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(server.errors()).toEqual([]);
  });

  it('занятый UDP-порт — отказ, и созданный сокет закрыт (ресурсы процесса как до вызова)', async () => {
    const busy = createSocket('udp4');
    await new Promise<void>((resolve) => busy.bind(0, '127.0.0.1', resolve));
    try {
      const baseline = await settledResources();
      await expect(FakeDnsServer.start({ port: busy.address().port })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(await settledResources()).toEqual(baseline);
    } finally {
      busy.close();
    }
  });

  it('занятый TCP-порт при заданном номере — отказ без висящих сокетов', async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    try {
      const address = busy.address();
      if (address === null || typeof address === 'string') {
        throw new Error('нет порта');
      }
      const baseline = await settledResources();
      await expect(FakeDnsServer.start({ port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await settledResources()).toEqual(baseline);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  it('Symbol.asyncDispose закрывает сервер', async () => {
    const baseline = await settledResources();
    {
      await using disposable = await FakeDnsServer.start();
      expect(disposable.port).toBeGreaterThan(0);
    }
    expect(await settledResources()).toEqual(baseline);
  });
});

describe('parseDnsQuery: границы', () => {
  const header = query(1, 'a').subarray(0, 12);

  it('метка ровно 63 байта — разбирается; имя в нижнем регистре, вопрос — байты 12..конец типа и класса', () => {
    const label = 'A'.repeat(63);
    const message = query(5, `${label}.Test`, 28);
    expect(parseDnsQuery(message)).toEqual({
      id: 5,
      flags: 0x0100,
      opcode: 0,
      questions: 1,
      name: `${'a'.repeat(63)}.test`,
      type: 28,
      qclass: 1,
      udpSize: 512,
      question: message.subarray(12),
    });
  });

  it('метка 64 байта и больше — отказ разбора', () => {
    expect(
      parseDnsQuery(
        Buffer.concat([header, Buffer.from([64]), Buffer.alloc(64, 0x61), Buffer.from([0, 0, 1, 0, 1])]),
      ),
    ).toBe(undefined);
  });

  it('метка ровно до конца сообщения, без завершающего нуля — отказ; ровно 4 байта типа и класса — разбор', () => {
    expect(parseDnsQuery(Buffer.concat([header, Buffer.from([1, 0x61])]))).toBe(undefined);
    expect(parseDnsQuery(Buffer.concat([header, Buffer.from([1, 0x61, 0, 0, 1, 0, 1])]))?.name).toBe('a');
    expect(parseDnsQuery(Buffer.concat([header, Buffer.from([1, 0x61, 0, 0, 1, 0])]))).toBe(undefined);
  });

  /** OPT (EDNS0) может стоять в дополнительной секции не первой (RFC 6891 §6.1.1). */
  it('OPT второй записью дополнительной секции — размер UDP из неё; без OPT — 512', () => {
    const base = query(5, 'api.test');
    const other = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 10, 0, 0, 1]);
    const opt = Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, 0, 0]);
    const withTwo = Buffer.concat([base, other, opt]);
    withTwo.writeUInt16BE(2, 10);
    expect(parseDnsQuery(withTwo)?.udpSize).toBe(4096);
    const withoutOpt = Buffer.concat([base, other]);
    withoutOpt.writeUInt16BE(1, 10);
    expect(parseDnsQuery(withoutOpt)?.udpSize).toBe(512);
  });

  it('лишние байты после вопроса не входят в вопрос', () => {
    const message = Buffer.concat([query(2, 'x.test'), Buffer.from([9, 9, 9])]);
    expect(parseDnsQuery(message)?.question).toEqual(query(2, 'x.test').subarray(12));
  });
});

describe('адреса', () => {
  it.each([
    ['::ffff:192.168.100.200', [...Array(10).fill(0), 0xff, 0xff, 192, 168, 100, 200]],
    ['64:ff9b::192.0.2.33', [0, 0x64, 0xff, 0x9b, ...Array(8).fill(0), 192, 0, 2, 33]],
    ['::', Array(16).fill(0)],
    ['1::', [0, 1, ...Array(14).fill(0)]],
    ['1:2:3:4:5:6:7::', [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 0]],
    ['::2:3:4:5:6:7:8', [0, 0, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]],
    ['2001:db8:0:0:0:0:2:1', [0x20, 0x01, 0x0d, 0xb8, ...Array(8).fill(0), 0, 2, 0, 1]],
    ['fe80::1%eth0', [0xfe, 0x80, ...Array(13).fill(0), 1]],
    ['2001:DB8::A', [0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 0x0a]],
  ])('%s', (address, bytes) => {
    expect([...addressToBytes(address)]).toEqual(bytes);
  });

  it('не адрес — отказ с самим значением', () => {
    expect(() => addressToBytes('10.0.0.256')).toThrow('не адрес IPv4/IPv6: 10.0.0.256');
  });

  it('адрес сервера для Resolver: IPv6 — в скобках', () => {
    expect([dnsServerAddress('127.0.0.1', 53), dnsServerAddress('::1', 5353)]).toEqual([
      '127.0.0.1:53',
      '[::1]:5353',
    ]);
  });
});
