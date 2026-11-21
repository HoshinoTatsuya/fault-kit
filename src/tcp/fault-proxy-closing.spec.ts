import { createServer, type Server, type Socket } from 'node:net';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { expectSettlesBefore } from '../assert/expect-settles-before';
import { startEchoServer } from '../testing/echo-server';
import { loggedClient } from '../testing/logged-client';
import { roundTrips } from '../testing/round-trips';
import { settledResources } from '../testing/settled-resources';
import { DROP_MODE } from './drop-mode.constant';
import { FaultProxy } from './fault-proxy';

/**
 * Цель, которой спека управляет: сокеты на стороне сервера видны (`sockets`),
 * `accepted` — сколько подключений дошло. `onSocket` — поведение на каждое.
 */
const startTarget = async (
  onSocket: (socket: Socket) => void = () => undefined,
): Promise<{ port: number; sockets: Socket[]; accepted(): number; close(): Promise<void> }> => {
  const sockets: Socket[] = [];
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('цель без порта');
  }
  return {
    port: address.port,
    sockets,
    accepted: () => sockets.length,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** Порт, на котором заведомо никто не слушает. */
const deadPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('нет порта');
  }
  return address.port;
};

describe('FaultProxy: закрытие стороны — событие в очереди направления', () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>>;
  const cleanup: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    echo = await startEchoServer();
  });

  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
      await step();
    }
    await echo.close();
  });

  const target = async (onSocket?: (socket: Socket) => void) => {
    const started = await startTarget(onSocket);
    cleanup.push(() => started.close());
    return started;
  };

  const proxyTo = async (port: number): Promise<FaultProxy> => {
    const proxy = await FaultProxy.start({ host: '127.0.0.1', port });
    cleanup.push(() => proxy.close());
    return proxy;
  };

  const open = async (port: number, allowHalfOpen = false) => {
    const client = await loggedClient(port, { allowHalfOpen });
    cleanup.push(() => {
      client.socket.destroy();
    });
    return client;
  };

  /** Цель «запрос + FIN, ответ + FIN» (HTTP/1.0, nc): отвечает после FIN клиента и закрывает. */
  const replyOnFin = (size: number) => (socket: Socket) => {
    socket.on('data', () => undefined);
    socket.on('end', () => socket.end(Buffer.alloc(size, 0x61)));
  };

  it.each([0, 50])(
    'цель ответила и закрыла соединение (задержка %i мс): клиент получает ВЕСЬ ответ, затем FIN',
    async (latencyMs) => {
      const server = await target(replyOnFin(16));
      const proxy = await proxyTo(server.port);
      proxy.latency(latencyMs);
      const client = await open(proxy.port, true);
      client.socket.end('request');
      await client.closed;
      expect({ got: client.received().length, events: client.events }).toEqual({
        got: 16,
        events: ['end', 'close'],
      });
    },
  );

  it('цель ответила и оборвала соединение (RST) под задержкой: сначала ответ, потом ECONNRESET', async () => {
    const server = await target((socket) =>
      socket.once('data', () => {
        socket.write('reply', () => socket.resetAndDestroy());
      }),
    );
    const proxy = await proxyTo(server.port);
    proxy.latency(30);
    const client = await open(proxy.port);
    client.socket.write('q');
    await client.closed;
    expect({ got: client.received(), events: client.events }).toEqual({
      got: 'reply',
      events: ['error:ECONNRESET', 'close'],
    });
  });

  it('полузакрытие: FIN клиента доходит до цели, ответ после него доходит до клиента', async () => {
    const server = await target(replyOnFin(3));
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port, true);
    client.socket.end('q');
    expect(await client.receive(3)).toBe('aaa');
    await client.closed;
    expect(client.events).toEqual(['end', 'close']);
  });

  it('полузакрытие со стороны цели: после её FIN данные клиента всё ещё доходят до цели', async () => {
    const received: string[] = [];
    const server = await target((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk.toString()));
      socket.end('bye');
    });
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port, true);
    expect(await client.receive(3)).toBe('bye');
    await roundTrips(3, echo.roundTrip);
    expect(client.events).toEqual(['end']);
    const arrived = new Promise<void>((resolve) => server.sockets[0]?.once('end', () => resolve()));
    client.socket.end('late');
    await arrived;
    expect(received.join('')).toBe('late');
  });

  it('freeze: RST цели не доходит до клиента, пока сервер напрямую отвечает 20 раз; thaw — доходит', async () => {
    const server = await target((socket) => socket.pipe(socket));
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port);
    client.socket.write('x');
    await client.receive(1);
    proxy.freeze();
    server.sockets[0]?.resetAndDestroy();
    await expectPendingThrough(client.closed, roundTrips(20, echo.roundTrip), 'RST под заморозкой');
    expect(client.events).toEqual([]);
    proxy.thaw();
    await client.closed;
    expect(client.events).toEqual(['error:ECONNRESET', 'close']);
  });

  it('freeze: FIN цели с данными стоит в очереди; thaw — данные, затем FIN', async () => {
    const server = await target((socket) => socket.pipe(socket));
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port);
    client.socket.write('x');
    await client.receive(1);
    proxy.freeze();
    server.sockets[0]?.end('bye');
    await expectPendingThrough(client.receive(4), roundTrips(20, echo.roundTrip), 'данные под заморозкой');
    expect(client.events).toEqual([]);
    proxy.thaw();
    await client.closed;
    expect({ got: client.received(), events: client.events }).toEqual({
      got: 'xbye',
      events: ['end', 'close'],
    });
  });

  it('freeze: соединение, принятое под заморозкой, к цели не подключается; thaw — подключается, данные доходят', async () => {
    const server = await target((socket) => socket.pipe(socket));
    const proxy = await proxyTo(server.port);
    proxy.freeze();
    const client = await open(proxy.port);
    client.socket.write('early');
    await expectPendingThrough(client.receive(5), roundTrips(20, echo.roundTrip), 'эхо под заморозкой');
    expect({ accepted: server.accepted(), events: client.events }).toEqual({ accepted: 0, events: [] });
    proxy.thaw();
    expect(await client.receive(5)).toBe('early');
    expect(server.accepted()).toBe(1);
  });

  it('freeze: цель недоступна — клиент не видит ничего; thaw — ECONNRESET', async () => {
    const proxy = await proxyTo(await deadPort());
    proxy.freeze();
    const client = await open(proxy.port);
    client.socket.write('hello');
    await expectPendingThrough(
      client.closed,
      roundTrips(20, echo.roundTrip),
      'недоступная цель под заморозкой',
    );
    expect(client.events).toEqual([]);
    proxy.thaw();
    await client.closed;
    expect(client.events).toEqual(['error:ECONNRESET', 'close']);
  });

  it('цель недоступна без заморозки — ECONNRESET сразу', async () => {
    const proxy = await proxyTo(await deadPort());
    const client = await open(proxy.port);
    await client.closed;
    expect(client.events).toEqual(['error:ECONNRESET', 'close']);
  });

  /** Байты, записанные в ещё не подключённый к цели сокет, цели не переданы: счётчик — по факту записи. */
  it('цель недоступна: байты клиента, написанные до отказа подключения, не считаются переданными цели', async () => {
    const proxy = await proxyTo(await deadPort());
    const client = await open(proxy.port);
    client.socket.write(Buffer.alloc(1000, 7));
    await client.closed;
    expect(proxy.stats()).toMatchObject({ bytesToUpstream: 0, queuedToUpstream: 0 });
  });

  it.each(['обычное', 'принятое под заморозкой', 'поглощённое blackholeNew'])(
    "drop('close') — FIN, даже если клиент успел написать непрочитанное (%s)",
    async (variant) => {
      const server = await target((socket) => socket.on('data', () => undefined));
      const proxy = await proxyTo(server.port);
      if (variant === 'принятое под заморозкой') {
        proxy.freeze();
      }
      if (variant === 'поглощённое blackholeNew') {
        proxy.blackholeNew();
      }
      const client = await open(proxy.port);
      client.socket.write('payload-not-read-by-proxy');
      await roundTrips(5, echo.roundTrip);
      expect(proxy.drop(DROP_MODE.close)).toBe(1);
      await client.closed;
      expect(client.events).toEqual(['end', 'close']);
    },
  );

  it("drop('reset') соединения, принятого под заморозкой, — ECONNRESET", async () => {
    const server = await target();
    const proxy = await proxyTo(server.port);
    proxy.freeze();
    const client = await open(proxy.port);
    await roundTrips(3, echo.roundTrip);
    expect(proxy.drop()).toBe(1);
    await client.closed;
    expect(client.events).toEqual(['error:ECONNRESET', 'close']);
    proxy.thaw();
    expect(server.accepted()).toBe(0);
  });

  it('прокси слушает заданный порт; по умолчанию — 127.0.0.1; после close адреса нет', async () => {
    const port = await deadPort();
    const proxy = await FaultProxy.start({ host: '127.0.0.1', port: echo.port, listenPort: port });
    expect({ host: proxy.host, port: proxy.port }).toEqual({ host: '127.0.0.1', port });
    await proxy.close();
    expect(() => proxy.port).toThrow('прокси не слушает TCP-порт');
  });

  it('занятый порт — отказ старта без висящих ресурсов', async () => {
    const busy = await FaultProxy.start({ host: '127.0.0.1', port: echo.port });
    cleanup.push(() => busy.close());
    const baseline = await settledResources();
    await expect(
      FaultProxy.start({ host: '127.0.0.1', port: echo.port, listenPort: busy.port }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await settledResources()).toEqual(baseline);
  });

  it('неверные адрес и порты — отказ старта, а не падение на первом подключении', async () => {
    await expect(FaultProxy.start({ host: '', port: echo.port })).rejects.toThrow(
      'адрес цели — непустая строка',
    );
    for (const port of [0, 70_000, 1.5]) {
      await expect(FaultProxy.start({ host: '127.0.0.1', port })).rejects.toThrow(
        `port — целое 1..65535, получено ${port}`,
      );
    }
    await expect(FaultProxy.start({ host: '127.0.0.1', port: echo.port, listenPort: -1 })).rejects.toThrow(
      'listenPort — целое 0..65535',
    );
  });

  it('freeze ставит источники на паузу сразу: записанное клиентом под заморозкой прокси не вычитывает', async () => {
    const server = await target((socket) => socket.on('data', () => undefined));
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port);
    client.socket.write('x');
    await roundTrips(5, echo.roundTrip);
    proxy.freeze();
    client.socket.write(Buffer.alloc(4 << 20));
    await roundTrips(20, echo.roundTrip);
    expect(proxy.stats()).toMatchObject({ bytesToUpstream: 1, queuedToUpstream: 0 });
  });

  it('счётчики очередей: под задержкой — стоящие байты, после неё — ноль', async () => {
    const proxy = await proxyTo(echo.port);
    const client = await open(proxy.port);
    proxy.latency(60_000);
    client.socket.write('12345');
    await roundTrips(5, echo.roundTrip);
    expect(proxy.stats()).toMatchObject({ queuedToUpstream: 5, queuedToClient: 0 });
    proxy.latency(0);
    expect(await client.receive(5)).toBe('12345');
    expect(proxy.stats()).toMatchObject({ queuedToUpstream: 0, queuedToClient: 0 });
  });

  it('клиент сначала полузакрыл, потом ушёл совсем — прокси закрывает своё соединение к цели, хотя цель FIN игнорирует', async () => {
    let targetClosed: Promise<void> = new Promise(() => undefined);
    const server = await target((socket) => {
      targetClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      // Цель держит полуоткрытое соединение: на FIN клиента не закрывается.
      socket.on('data', () => undefined);
    });
    const proxy = await proxyTo(server.port);
    const client = await open(proxy.port, true);
    client.socket.end('q');
    await roundTrips(5, echo.roundTrip);
    client.socket.resetAndDestroy();
    await client.closed;
    // Ответ цели упирается в ушедшего клиента: прокси узнаёт об этом ошибкой записи.
    server.sockets[0]?.write('reply');
    for (let turn = 0; turn < 200 && proxy.stats().active > 0; turn += 1) {
      await echo.roundTrip();
    }
    expect(proxy.stats().active).toBe(0);
    // Соединение прокси к цели закрыто: запись цели получает RST, следующая — EPIPE, и её сокет закрывается.
    // Без закрытия обе записи уходили бы в живой сокет прокси.
    server.sockets[0]?.write('again');
    await roundTrips(5, echo.roundTrip);
    server.sockets[0]?.write('again and again');
    await expectSettlesBefore(targetClosed, roundTrips(200, echo.roundTrip), 'закрытие соединения к цели');
  });

  it("drop('close'): непрочитанное прокси вычитывает — сокет прокси закрывается, когда клиент закрылся", async () => {
    const server = await target((socket) => socket.on('data', () => undefined));
    const proxy = await proxyTo(server.port);
    proxy.freeze();
    const client = await open(proxy.port);
    // Принято под заморозкой: сокет прокси не читает, байты клиента лежат в ядре непрочитанными.
    client.socket.write('payload-not-read-by-proxy');
    await roundTrips(5, echo.roundTrip);
    expect(proxy.drop(DROP_MODE.close)).toBe(1);
    await client.closed;
    expect(client.events).toEqual(['end', 'close']);
    // Без вычитывания сокет прокси на паузе не увидел бы FIN клиента и висел бы открытым.
    for (let turn = 0; turn < 200 && proxy.stats().active > 0; turn += 1) {
      await echo.roundTrip();
    }
    expect(proxy.stats().active).toBe(0);
  });

  it('close: разрешается, когда сокеты прокси ЗАКРЫТЫ (событие close), а не только начали закрываться', async () => {
    // Цель и клиент на паузе (не читают): FIN/RST прокси они не замечают, их сокеты стабильно открыты, и
    // разница счётчиков открытых ресурсов — ровно сокеты прокси.
    const paused: Socket[] = [];
    const server = await target((socket) => {
      socket.pause();
      paused.push(socket);
    });
    const proxy = await FaultProxy.start({ host: '127.0.0.1', port: server.port });
    const client = await open(proxy.port);
    client.socket.write('x');
    for (let turn = 0; turn < 200 && server.accepted() === 0; turn += 1) {
      await echo.roundTrip();
    }
    client.socket.pause();
    const count = (kind: string): number =>
      process.getActiveResourcesInfo().filter((each) => each === kind).length;
    const before = count('TCPSocketWrap');
    await proxy.close();
    // Сразу после close, без единого оборота: соединение клиента и соединение к цели у прокси закрыты.
    // (Слушающий сокет закрывается без события о конце закрытия: порт освобождён сразу, ручка — в фазе
    // закрытия цикла; его здесь не считаем.)
    expect(count('TCPSocketWrap')).toBe(before - 2);
    expect(paused).toHaveLength(1);
  });

  it('close: соединение к цели, ещё доставляющее очередь после ухода клиента, тоже закрыто к разрешению close', async () => {
    const server = await target((socket) => socket.pause());
    const proxy = await FaultProxy.start({ host: '127.0.0.1', port: server.port });
    const client = await open(proxy.port);
    client.socket.write('x');
    for (let turn = 0; turn < 200 && server.accepted() === 0; turn += 1) {
      await echo.roundTrip();
    }
    proxy.latency(60_000);
    client.socket.write('queued');
    await roundTrips(3, echo.roundTrip);
    client.socket.resetAndDestroy();
    await client.closed;
    for (let turn = 0; turn < 200 && proxy.stats().active > 0; turn += 1) {
      await echo.roundTrip();
    }
    // Клиента у прокси нет, соединение к цели держит очередь под задержкой.
    const count = (): number =>
      process.getActiveResourcesInfo().filter((each) => each === 'TCPSocketWrap').length;
    const before = count();
    await proxy.close();
    expect(count()).toBe(before - 1);
  });

  it('pauseOnConnect: RST клиента, принятого под заморозкой, прокси не видит до thaw (замёрзшая сеть его не донесла)', async () => {
    const server = await target();
    const proxy = await proxyTo(server.port);
    proxy.freeze();
    const client = await open(proxy.port);
    client.socket.write('x');
    await roundTrips(5, echo.roundTrip);
    expect(proxy.stats().active).toBe(1);
    client.socket.resetAndDestroy();
    await client.closed;
    await roundTrips(20, echo.roundTrip);
    // Сокет прокси не читает (pauseOnConnect): RST клиента лежит в ядре, соединение для прокси живо.
    expect(proxy.stats().active).toBe(1);
    proxy.thaw();
    for (let turn = 0; turn < 200 && proxy.stats().active > 0; turn += 1) {
      await echo.roundTrip();
    }
    expect(proxy.stats().active).toBe(0);
  });
});
