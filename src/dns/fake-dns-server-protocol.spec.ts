import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { roundTrips } from '../testing/round-trips';
import { dockerDnsArgs } from './docker-dns-args';
import { FakeDnsServer } from './fake-dns-server';

/** Запрос: id, флаги (opcode в битах 11–14), число вопросов, класс; `udpSize` — запись OPT (EDNS0). */
const query = (
  name: string,
  options: { id?: number; opcode?: number; questions?: number; qclass?: number; udpSize?: number } = {},
): Buffer => {
  const labels = name
    .split('.')
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(options.id ?? 1, 0);
  header.writeUInt16BE(0x0100 | ((options.opcode ?? 0) << 11), 2);
  header.writeUInt16BE(options.questions ?? 1, 4);
  header.writeUInt16BE(options.udpSize === undefined ? 0 : 1, 10);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(1, 1);
  tail.writeUInt16BE(options.qclass ?? 1, 3);
  const opt = Buffer.alloc(11);
  if (options.udpSize !== undefined) {
    opt.writeUInt16BE(41, 1);
    opt.writeUInt16BE(options.udpSize, 3);
  }
  return Buffer.concat([header, ...labels, tail, options.udpSize === undefined ? Buffer.alloc(0) : opt]);
};

const udpAsk = async (port: number, message: Buffer): Promise<Buffer> => {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    const reply = new Promise<Buffer>((resolve) => socket.once('message', resolve));
    socket.send(message, port, '127.0.0.1');
    return await reply;
  } finally {
    socket.close();
  }
};

const tcpAsk = (port: number, message: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(message.length, 0);
    const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.concat([prefix, message])));
    let data = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 2 && data.length >= 2 + data.readUInt16BE(0)) {
        socket.destroy();
        resolve(data.subarray(2));
      }
    });
    socket.on('error', reject);
  });

const header = (reply: Buffer) => ({
  rcode: reply.readUInt16BE(2) & 0x000f,
  tc: (reply.readUInt16BE(2) & 0x0200) !== 0,
  answers: reply.readUInt16BE(6),
  authority: reply.readUInt16BE(8),
});

const addresses = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`);

describe('FakeDnsServer: протокол', () => {
  let server: FakeDnsServer;
  let witness: FakeDnsServer;

  beforeEach(async () => {
    server = await FakeDnsServer.start({
      records: {
        'api.test': ['10.1.2.3'],
        'many.test': addresses(120),
        'forty.test': addresses(40),
        'twenty.test': addresses(20),
      },
      ttlSeconds: 30,
    });
    witness = await FakeDnsServer.start({ records: { 'witness.test': ['10.9.9.9'] } });
  });

  afterEach(async () => {
    await server.close();
    await witness.close();
  });

  const witnessAnswers = (count: number): Promise<void> => {
    const direct = new Resolver({ timeout: 10_000, tries: 1 });
    direct.setServers([witness.address]);
    return roundTrips(count, () => direct.resolve4('witness.test'));
  };

  it('NXDOMAIN и NODATA несут SOA в полномочиях (minimum = TTL); положительный ответ — без SOA', async () => {
    const nx = await udpAsk(server.port, query('missing.test'));
    const nodata = await udpAsk(
      server.port,
      Buffer.from(query('api.test').map((byte, index) => (index === 23 ? 28 : byte))),
    );
    const positive = await udpAsk(server.port, query('api.test'));
    expect([header(nx), header(nodata), header(positive)]).toEqual([
      { rcode: 3, tc: false, answers: 0, authority: 1 },
      { rcode: 0, tc: false, answers: 0, authority: 1 },
      { rcode: 0, tc: false, answers: 1, authority: 0 },
    ]);
    const soa = nx.subarray(query('missing.test').length);
    expect({
      type: soa.readUInt16BE(2),
      ttl: soa.readUInt32BE(6),
      minimum: soa.readUInt32BE(soa.length - 4),
    }).toEqual({
      type: 6,
      ttl: 30,
      minimum: 30,
    });
  });

  it('UDP без EDNS: ответ больше 512 байт — бит TC без записей; по TCP — полностью; меньше 512 — без усечения', async () => {
    expect(header(await udpAsk(server.port, query('forty.test')))).toEqual({
      rcode: 0,
      tc: true,
      answers: 0,
      authority: 0,
    });
    expect(header(await tcpAsk(server.port, query('forty.test')))).toEqual({
      rcode: 0,
      tc: false,
      answers: 40,
      authority: 0,
    });
    expect(header(await udpAsk(server.port, query('twenty.test')))).toEqual({
      rcode: 0,
      tc: false,
      answers: 20,
      authority: 0,
    });
  });

  it('UDP с EDNS0: размер из OPT — 4096 вмещает 120 адресов; c-ares на усечении повторяет по TCP', async () => {
    expect(header(await udpAsk(server.port, query('many.test', { udpSize: 4096 })))).toMatchObject({
      tc: false,
      answers: 120,
    });
    expect(header(await udpAsk(server.port, query('many.test', { udpSize: 1232 })))).toMatchObject({
      tc: true,
      answers: 0,
    });
    const resolver = new Resolver({ timeout: 10_000, tries: 1 });
    resolver.setServers([server.address]);
    const before = server.queries().length;
    expect(await resolver.resolve4('many.test')).toHaveLength(120);
    expect(
      server
        .queries()
        .slice(before)
        .map((record) => record.transport),
    ).toEqual(['udp', 'tcp']);
  });

  it.each([
    ['код операции не QUERY', { opcode: 4 }, 4],
    ['два вопроса', { questions: 2 }, 1],
    ['класс не IN (CH)', { qclass: 3 }, 5],
    ['обычный запрос (двойник)', {}, 0],
  ] as const)('%s — код ответа %i', async (_name, options, rcode) => {
    expect(header(await udpAsk(server.port, query('api.test', options))).rcode).toBe(rcode);
  });

  it('silence("udp"): UDP молчит, TCP отвечает; respond снимает', async () => {
    server.silence('udp');
    const socket = createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    try {
      const reply = new Promise<Buffer>((resolve) => socket.once('message', resolve));
      socket.send(query('api.test'), server.port, '127.0.0.1');
      await expectPendingThrough(reply, witnessAnswers(10), 'UDP под silence("udp")');
      expect(header(await tcpAsk(server.port, query('api.test'))).answers).toBe(1);
      server.respond();
      expect(header(await udpAsk(server.port, query('api.test'))).answers).toBe(1);
    } finally {
      socket.close();
    }
  });

  it('waitForQueries: число — целое не меньше 1', async () => {
    await expect(server.waitForQueries(0)).rejects.toThrow('число запросов — целое не меньше 1');
    await expect(server.waitForQueries(Number.NaN)).rejects.toThrow(RangeError);
  });

  it('ошибка сокета сервера после старта не роняет процесс спеки и видна в errors()', async () => {
    const udp = (server as unknown as { _udp: NodeJS.EventEmitter })._udp;
    udp.emit('error', new Error('ENOBUFS'));
    expect(server.errors().map((error) => error.message)).toEqual(['ENOBUFS']);
    expect(header(await udpAsk(server.port, query('api.test'))).answers).toBe(1);
  });
});

describe('dockerDnsArgs: ndots и домены поиска', () => {
  it('ndots и search попадают в аргументы; неверные — отказ', () => {
    expect(dockerDnsArgs({ ndots: 0, search: ['svc.test', 'test'] })).toEqual([
      '--dns',
      '127.0.0.1',
      '--dns-option',
      'ndots:0',
      '--dns-search',
      'svc.test',
      '--dns-search',
      'test',
    ]);
    expect(() => dockerDnsArgs({ ndots: 16 })).toThrow(RangeError);
    expect(() => dockerDnsArgs({ search: ['bad domain'] })).toThrow('домен поиска');
  });
});
