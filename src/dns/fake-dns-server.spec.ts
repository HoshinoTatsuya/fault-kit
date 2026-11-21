import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { resourcesLeft } from '../testing/resources-left';
import { roundTrips } from '../testing/round-trips';
import { settledResources } from '../testing/settled-resources';
import { addressToBytes } from './address-to-bytes';
import { dockerDnsArgs } from './docker-dns-args';
import { FakeDnsServer } from './fake-dns-server';

/** Резолверы спеки: после теста их запросы отменяются (`cancel()`), иначе запрос к молчащему серверу живёт до потолка. */
const resolvers = new Set<Resolver>();

/** Резолвер c-ares на заданный сервер: одна попытка, потолок `timeout` мс. */
const resolverFor = (server: FakeDnsServer, timeout = 10_000): Resolver => {
  const resolver = new Resolver({ timeout, tries: 1 });
  resolver.setServers([server.address]);
  resolvers.add(resolver);
  return resolver;
};

/** Запрос A по TCP руками: c-ares идёт в TCP только при усечении, а TCP-путь сервера тоже надо проверить. */
const queryOverTcp = (port: number, name: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const labels = name
      .split('.')
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
    const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    const message = Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
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

describe('FakeDnsServer', () => {
  let server: FakeDnsServer;
  let witness: FakeDnsServer;
  let baseline: Record<string, number>;

  beforeEach(async () => {
    baseline = await settledResources();
    server = await FakeDnsServer.start({ records: { 'api.test': ['10.1.2.3', '2001:db8::7'] } });
    witness = await FakeDnsServer.start({ records: { 'witness.test': ['10.9.9.9'] } });
  });

  afterEach(async () => {
    for (const resolver of resolvers) {
      resolver.cancel();
    }
    resolvers.clear();
    await server.close();
    await witness.close();
    // Тест освобождает всё, что открыл, включая запросы своих резолверов: запрос к
    // молчащему серверу держал воркер jest до потолка резолвера (до 120 с) после файла.
    expect(resourcesLeft(baseline, await settledResources())).toEqual({});
  });

  /** Свидетель окна: соседний сервер ответил N раз. */
  const witnessAnswers = (count: number): Promise<void> => {
    const resolver = resolverFor(witness);
    return roundTrips(count, () => resolver.resolve4('witness.test'));
  };

  it('отдаёт заданные адреса: A — IPv4, AAAA — IPv6; регистр и точка в конце не важны', async () => {
    const resolver = resolverFor(server);
    expect(await resolver.resolve4('api.test')).toEqual(['10.1.2.3']);
    expect(await resolver.resolve6('API.test.')).toEqual(['2001:db8::7']);
    expect(server.queries()).toEqual([
      { name: 'api.test', type: 1, transport: 'udp' },
      { name: 'api.test', type: 28, transport: 'udp' },
    ]);
  });

  it('неизвестное имя — NXDOMAIN (ENOTFOUND); имя без адресов семейства — ENODATA', async () => {
    server.answer({ 'v4only.test': ['10.0.0.1'] });
    const resolver = resolverFor(server);
    await expect(resolver.resolve4('missing.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(resolver.resolve6('v4only.test')).rejects.toMatchObject({ code: 'ENODATA' });
  });

  it('silence: запрос дошёл (событие), ответа нет, пока соседний сервер ответил 10 раз', async () => {
    server.silence();
    const pending = resolverFor(server).resolve4('api.test');
    await server.waitForQueries(1);
    await expectPendingThrough(pending, witnessAnswers(10), 'resolve4 у молчащего сервера');
    expect(server.queries()).toHaveLength(1);
    pending.catch(() => undefined);
  });

  it('silence: резолвер с потолком получает ETIMEOUT, а не ответ', async () => {
    server.silence();
    await expect(resolverFor(server, 200).resolve4('api.test')).rejects.toMatchObject({ code: 'ETIMEOUT' });
    expect(server.queries().length).toBeGreaterThanOrEqual(1);
  });

  it('respond после silence — снова отвечает', async () => {
    server.silence();
    await expect(resolverFor(server, 100).resolve4('api.test')).rejects.toMatchObject({ code: 'ETIMEOUT' });
    server.respond();
    expect(await resolverFor(server).resolve4('api.test')).toEqual(['10.1.2.3']);
  });

  it('delay: ответ задержан, пока соседний сервер ответил 10 раз; малая задержка — верный ответ', async () => {
    server.delay(60_000);
    const pending = resolverFor(server, 120_000).resolve4('api.test');
    await server.waitForQueries(1);
    await expectPendingThrough(pending, witnessAnswers(10), 'resolve4 у медленного сервера');
    pending.catch(() => undefined);
    server.delay(5);
    expect(await resolverFor(server).resolve4('api.test')).toEqual(['10.1.2.3']);
  });

  it('TCP: тот же порт, ответ с длиной впереди', async () => {
    const response = await queryOverTcp(server.port, 'api.test');
    expect(response.readUInt16BE(0)).toBe(0x1234);
    expect(response.readUInt16BE(2) & 0x000f).toBe(0);
    expect(response.readUInt16BE(6)).toBe(1);
    expect([...response.subarray(-4)]).toEqual([10, 1, 2, 3]);
    expect(server.queries()).toEqual([{ name: 'api.test', type: 1, transport: 'tcp' }]);
  });

  it('answer: не адрес — отказ сразу, а не «нет записи»', () => {
    expect(() => server.answer({ 'x.test': ['10.0.0.256'] })).toThrow('не адрес');
  });

  it('waitForQueries после close — отказ, а не вечное ожидание', async () => {
    const waiting = server.waitForQueries(5);
    await server.close();
    await expect(waiting).rejects.toThrow('сервер DNS закрыт');
    await expect(server.waitForQueries(1)).rejects.toThrow('сервер DNS закрыт');
  });

  it('close: отложенные ответы, TCP-соединения и сокеты освобождены', async () => {
    const baseline = await settledResources();
    const probe = await FakeDnsServer.start({ records: { 'a.test': ['10.0.0.1'] } });
    probe.delay(60_000);
    const resolver = resolverFor(probe, 120_000);
    const pending = resolver.resolve4('a.test');
    pending.catch(() => undefined);
    await probe.waitForQueries(1);
    const tcp = connect(probe.port, '127.0.0.1');
    tcp.on('error', () => undefined);
    await new Promise((resolve) => tcp.once('connect', resolve));
    const tcpClosed = new Promise((resolve) => tcp.once('close', resolve));
    await probe.close();
    await tcpClosed;
    resolver.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(await settledResources()).toEqual(baseline);
  });
});

describe('addressToBytes', () => {
  it.each([
    ['1.2.3.4', [1, 2, 3, 4]],
    ['::1', [...Array(15).fill(0), 1]],
    ['2001:db8::7', [0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 7]],
    ['::ffff:10.0.0.1', [...Array(10).fill(0), 0xff, 0xff, 10, 0, 0, 1]],
    ['fe80::1:2', [0xfe, 0x80, ...Array(10).fill(0), 0, 1, 0, 2]],
  ])('%s', (address, bytes) => {
    expect([...addressToBytes(address)]).toEqual(bytes);
  });

  it('не адрес — отказ', () => {
    expect(() => addressToBytes('example.test')).toThrow(TypeError);
  });
});

describe('dockerDnsArgs', () => {
  it('по умолчанию — 127.0.0.1 внутри контейнера, без опций', () => {
    expect(dockerDnsArgs()).toEqual(['--dns', '127.0.0.1']);
  });

  it('опции resolv.conf и свой адрес', () => {
    expect(dockerDnsArgs({ nameserver: '10.255.255.1', timeoutSeconds: 1, attempts: 2 })).toEqual([
      '--dns',
      '10.255.255.1',
      '--dns-option',
      'timeout:1',
      '--dns-option',
      'attempts:2',
    ]);
  });

  it('не IP и неположительные числа — отказ', () => {
    expect(() => dockerDnsArgs({ nameserver: 'dns.test' })).toThrow(TypeError);
    expect(() => dockerDnsArgs({ attempts: 0 })).toThrow(RangeError);
    expect(() => dockerDnsArgs({ timeoutSeconds: 1.5 })).toThrow(RangeError);
  });
});
