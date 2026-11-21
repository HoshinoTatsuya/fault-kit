import type { Socket } from 'node:net';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { startEchoServer } from '../testing/echo-server';
import { loggedClient as client } from '../testing/logged-client';
import { roundTrips } from '../testing/round-trips';
import { settledResources } from '../testing/settled-resources';
import { DROP_MODE } from './drop-mode.constant';
import { FaultProxy } from './fault-proxy';

describe('FaultProxy (эхо-сервер за прокси)', () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>>;
  let proxy: FaultProxy;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    echo = await startEchoServer();
    proxy = await FaultProxy.start({ host: '127.0.0.1', port: echo.port });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await proxy.close();
    await echo.close();
  });

  const open = async () => {
    const opened = await client(proxy.port);
    sockets.push(opened.socket);
    return opened;
  };

  it('без отказов — прозрачен; счётчики считают переданные байты', async () => {
    const c = await open();
    c.socket.write('hello');
    expect(await c.receive(5)).toBe('hello');
    expect(proxy.stats()).toEqual({
      accepted: 1,
      active: 1,
      blackholed: 0,
      bytesToUpstream: 5,
      bytesToClient: 5,
      queuedToUpstream: 0,
      queuedToClient: 0,
    });
  });

  it('freeze: ни ответа, ни ошибки, ни закрытия, пока сервер напрямую отвечает 20 раз; thaw — отдаёт накопленное', async () => {
    const c = await open();
    c.socket.write('a');
    await c.receive(1);
    proxy.freeze();
    const before = proxy.stats();
    c.socket.write('frozen');
    await expectPendingThrough(c.receive(7), roundTrips(20, echo.roundTrip), 'эхо за замёрзшим прокси');
    expect(c.events).toEqual([]);
    expect(proxy.stats()).toEqual(before);
    proxy.thaw();
    expect(await c.receive(7)).toBe('afrozen');
    expect(c.events).toEqual([]);
  });

  it('freeze действует и на соединения, открытые во время заморозки', async () => {
    proxy.freeze();
    const c = await open();
    c.socket.write('new');
    await expectPendingThrough(c.receive(3), roundTrips(20, echo.roundTrip));
    expect(proxy.stats().bytesToUpstream).toBe(0);
    proxy.thaw();
    expect(await c.receive(3)).toBe('new');
  });

  it('drop(reset): клиент получает ECONNRESET; новые соединения работают', async () => {
    const c = await open();
    c.socket.write('x');
    await c.receive(1);
    const closed = new Promise((resolve) => c.socket.once('close', resolve));
    expect(proxy.drop()).toBe(1);
    await closed;
    expect(c.events).toEqual(['error:ECONNRESET', 'close']);
    const next = await open();
    next.socket.write('again');
    expect(await next.receive(5)).toBe('again');
  });

  it('drop(close): клиент получает FIN без ошибки', async () => {
    const c = await open();
    c.socket.write('x');
    await c.receive(1);
    const closed = new Promise((resolve) => c.socket.once('close', resolve));
    proxy.drop(DROP_MODE.close);
    await closed;
    expect(c.events).toEqual(['end', 'close']);
  });

  it('drop с неизвестным способом — отказ', () => {
    expect(() => proxy.drop('rst' as never)).toThrow(RangeError);
  });

  it('latency: ответ задержан, пока сервер напрямую отвечает 20 раз; снятие задержки отпускает накопленное', async () => {
    const c = await open();
    proxy.latency(60_000);
    c.socket.write('slow');
    await expectPendingThrough(c.receive(4), roundTrips(20, echo.roundTrip));
    proxy.latency(0);
    expect(await c.receive(4)).toBe('slow');
  });

  it('latency: уменьшение задержки на ходу не переставляет куски местами', async () => {
    const c = await open();
    proxy.latency(200);
    c.socket.write('first-');
    // Кусок 'first-' дошёл до прокси и стоит в очереди задержки: эхо не пришло.
    await roundTrips(5, echo.roundTrip);
    proxy.latency(1);
    c.socket.write('second');
    expect(await c.receive(12)).toBe('first-second');
  });

  it('latency: отрицательная или нечисловая — отказ', () => {
    expect(() => proxy.latency(-1)).toThrow(RangeError);
    expect(() => proxy.latency(Number.NaN)).toThrow(RangeError);
  });

  it('latency больше потолка таймера Node (2³¹−1) — отказ: setTimeout поставил бы 1 мс и перезаводил таймер', () => {
    expect(() => proxy.latency(2 ** 31)).toThrow('задержка — число мс от 0 до 2147483647');
    expect(() => proxy.latency(2 ** 31 - 1)).not.toThrow();
    proxy.latency(0);
  });

  it('blackholeNew: не булево — отказ, а не молча включённое поглощение', () => {
    expect(() => proxy.blackholeNew('false' as never)).toThrow('blackholeNew — true или false');
    expect(() => proxy.blackholeNew(0 as never)).toThrow(TypeError);
  });

  it('blackholeNew: новое соединение установлено и не обслуживается; старое работает; выключение — снова обслуживает', async () => {
    const old = await open();
    // 'connect' у клиента раньше, чем прокси принял соединение: без обмена
    // старое соединение могло бы быть принято уже после blackholeNew().
    old.socket.write('1');
    await old.receive(1);
    proxy.blackholeNew();
    const swallowed = await open();
    swallowed.socket.write('nobody');
    await expectPendingThrough(swallowed.receive(6), roundTrips(20, echo.roundTrip));
    expect(swallowed.events).toEqual([]);
    old.socket.write('old');
    expect(await old.receive(4)).toBe('1old');
    proxy.blackholeNew(false);
    const served = await open();
    served.socket.write('back');
    expect(await served.receive(4)).toBe('back');
    expect(proxy.stats()).toMatchObject({ accepted: 3, active: 3, blackholed: 1 });
  });

  it('close: разрешается, когда закрыто всё, включая задержанные (висящий таймер) и поглощённые соединения', async () => {
    const baseline = await settledResources(echo.whenConnections(1));
    const frozen = await FaultProxy.start({ host: '127.0.0.1', port: echo.port });
    const a = await client(frozen.port);
    a.socket.write('held');
    await a.receive(4);
    frozen.latency(60_000);
    a.socket.write('delayed');
    await roundTrips(3, echo.roundTrip);
    expect(frozen.stats()).toMatchObject({ bytesToUpstream: 4, blackholed: 0 });
    frozen.blackholeNew();
    const b = await client(frozen.port);
    expect(b.events).toEqual([]);
    // Без freeze: заморозка перекачивает очередь и снимает таймер задержки, а
    // проверить надо именно то, что close снимает ВИСЯЩИЙ таймер задержки.
    await roundTrips(3, echo.roundTrip);
    const closed = Promise.all([a, b].map((c) => new Promise((resolve) => c.socket.once('close', resolve))));
    await frozen.close();
    await closed;
    expect(await settledResources(echo.whenConnections(1))).toEqual(baseline);
    await expect(frozen.close()).resolves.toBeUndefined();
  });

  it('close замороженного прокси с накопленным — тоже без остатка', async () => {
    const baseline = await settledResources(echo.whenConnections(1));
    const frozen = await FaultProxy.start({ host: '127.0.0.1', port: echo.port });
    const a = await client(frozen.port);
    frozen.freeze();
    a.socket.write('held');
    await roundTrips(3, echo.roundTrip);
    const closed = new Promise((resolve) => a.socket.once('close', resolve));
    await frozen.close();
    await closed;
    expect(await settledResources(echo.whenConnections(1))).toEqual(baseline);
  });

  it('Symbol.asyncDispose закрывает прокси', async () => {
    const baseline = await settledResources(echo.whenConnections(1));
    {
      await using disposable = await FaultProxy.start({ host: '127.0.0.1', port: echo.port });
      const c = await client(disposable.port);
      c.socket.write('z');
      await c.receive(1);
      const closed = new Promise((resolve) => c.socket.once('close', resolve));
      c.socket.destroy();
      await closed;
    }
    expect(await settledResources(echo.whenConnections(1))).toEqual(baseline);
  });
});
