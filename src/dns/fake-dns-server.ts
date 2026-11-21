import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, isIPv4, isIPv6, type Server, type Socket } from 'node:net';
import { TIMER_CEILING_MS } from '../timer-ceiling-ms.constant';
import { valueText } from '../value-text';
import { buildDnsResponse } from './build-dns-response';
import type { DnsQuery } from './dns-query.type';
import type { DnsQueryRecord } from './dns-query-record.type';
import { DNS_RCODE } from './dns-rcode.constant';
import { DNS_RECORD_TYPE } from './dns-record-type.constant';
import { dnsServerAddress } from './dns-server-address';
import type { FakeDnsServerOptions } from './fake-dns-server-options.type';
import { parseDnsQuery } from './parse-dns-query';

/**
 * Локальный DNS-сервер для спек (UDP и TCP на одном порту): отдаёт заданные
 * адреса, молчит (`silence()`), отвечает с задержкой (`delay(ms)`).
 *
 * Для `dns.Resolver` (c-ares): `resolver.setServers([server.address])`.
 * `dns.lookup` (getaddrinfo) читает только `/etc/resolv.conf`, а там порт не
 * задаётся — для него сервер запускают на 127.0.0.1:53 внутри контейнера,
 * которому `dockerDnsArgs()` указал этот адрес.
 *
 * Молчание — запрос принят и забыт: как сеть, теряющая пакеты, а не сервер,
 * отвечающий отказом. Запросы считаются и в молчании: `waitForQueries(n)` —
 * событие «запрос дошёл и остался без ответа» для утверждений без часов.
 */
export class FakeDnsServer implements AsyncDisposable {
  private _records = new Map<string, readonly string[]>();
  private readonly _silent = new Set<'udp' | 'tcp'>();
  private readonly _errors: Error[] = [];
  private _delayMs = 0;
  private readonly _log: DnsQueryRecord[] = [];
  private readonly _waiters = new Set<{ count: number; resolve(): void; reject(error: Error): void }>();
  private readonly _timers = new Set<NodeJS.Timeout>();
  private readonly _connections = new Map<Socket, Promise<void>>();
  private _closing: Promise<void> | undefined;

  private constructor(
    private readonly _udp: UdpSocket,
    private readonly _tcp: Server,
    private readonly _ttlSeconds: number,
  ) {}

  /** Потолок TTL записи: 2³¹−1 с (RFC 2181 §8). */
  public static readonly MAX_TTL_SECONDS = 2_147_483_647;

  public static async start(options: FakeDnsServerOptions = {}): Promise<FakeDnsServer> {
    const host = options.host ?? '127.0.0.1';
    if (typeof host !== 'string' || (!isIPv4(host) && !isIPv6(host))) {
      throw new TypeError(`сервер DNS слушает адрес IP, получено ${valueText(host)}`);
    }
    const ttl = options.ttlSeconds ?? 0;
    // Больше 2³¹−1 резолверы считают нулём (RFC 2181 §8), а больше 2³²−1 не влезает в поле
    // ответа: ERR_OUT_OF_RANGE падал бы уже при запросе, внутри обработчика сокета.
    if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > FakeDnsServer.MAX_TTL_SECONDS) {
      throw new RangeError(
        `TTL — целое от 0 до ${FakeDnsServer.MAX_TTL_SECONDS} секунд (TTL — целое неотрицательное), получено ${valueText(ttl)}`,
      );
    }
    const requested = options.port ?? 0;
    // Свободный порт выбирает UDP; TCP на том же номере может оказаться занят —
    // тогда другой номер. Заданный порт не перебирается: занят — отказ.
    for (let attempt = 0; ; attempt += 1) {
      const udp = createSocket(isIPv4(host) ? 'udp4' : 'udp6');
      try {
        await new Promise<void>((resolve, reject) => {
          udp.once('error', reject);
          udp.bind(requested, host, () => {
            udp.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        // Сокет создан, но не привязан: без close он остаётся открытым дескриптором.
        udp.close();
        throw error;
      }
      const tcp = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          tcp.once('error', reject);
          tcp.listen(udp.address().port, host, () => {
            tcp.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        await new Promise<void>((resolve) => udp.close(() => resolve()));
        if (requested !== 0 || attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
        continue;
      }
      const server = new FakeDnsServer(udp, tcp, ttl);
      server.answer(options.records ?? {});
      // Постоянные слушатели ошибок: ошибка отправки ответа или сокета не роняет процесс спеки, а видна в errors().
      udp.on('error', (error: Error) => server._errors.push(error));
      tcp.on('error', (error: Error) => server._errors.push(error));
      udp.on('message', (message, peer) =>
        server._handle(message, 'udp', (reply) =>
          udp.send(reply, peer.port, peer.address, (error) => {
            if (error !== null) {
              server._errors.push(error);
            }
          }),
        ),
      );
      tcp.on('connection', (socket) => server._serveTcp(socket));
      return server;
    }
  }

  public get host(): string {
    return this._udp.address().address;
  }

  public get port(): number {
    return this._udp.address().port;
  }

  /** `host:port` (IPv6 — в скобках) — для `Resolver.setServers`. */
  public get address(): string {
    return dnsServerAddress(this.host, this.port);
  }

  /** Заменить записи. Имя без учёта регистра и завершающей точки; адреса проверяются сразу. */
  public answer(records: Readonly<Record<string, readonly string[]>>): void {
    const next = new Map<string, readonly string[]>();
    for (const [name, addresses] of Object.entries(records)) {
      for (const address of addresses) {
        if (!isIPv4(address) && !isIPv6(address)) {
          throw new TypeError(`не адрес IPv4/IPv6 для ${name}: ${address}`);
        }
      }
      next.set(name.toLowerCase().replace(/\.$/, ''), [...addresses]);
    }
    this._records = next;
  }

  /**
   * Принимать запросы и не отвечать (до `respond()`); `transport` — молчать
   * только по UDP или только по TCP (например: UDP молчит, а повтор по TCP
   * отвечает). Уже отложенные ответы уйдут.
   */
  public silence(transport?: 'udp' | 'tcp'): void {
    if (transport !== undefined && transport !== 'udp' && transport !== 'tcp') {
      // 'UDP' или опечатка молча не делали ничего — а спека считала бы сервер молчащим.
      throw new TypeError(`транспорт — 'udp' или 'tcp', получено ${JSON.stringify(transport)}`);
    }
    for (const each of transport === undefined ? (['udp', 'tcp'] as const) : [transport]) {
      this._silent.add(each);
    }
  }

  /** Ошибки сокетов сервера (отправка ответа, сокет клиента): видны, но процесс спеки не роняют. */
  public errors(): readonly Error[] {
    return Object.freeze([...this._errors]);
  }

  /**
   * Отвечать с задержкой `ms` (0 — сразу). Задержка берётся на момент запроса.
   * Не больше 2³¹−1 мс: больше `setTimeout` молча ставит 1 мс, и «очень
   * долго» стало бы «сразу»; «никогда» — это `silence()`.
   */
  public delay(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > TIMER_CEILING_MS) {
      throw new RangeError(
        `задержка — число мс от 0 до ${TIMER_CEILING_MS} (потолок таймера Node; «никогда» — silence()), получено ${valueText(ms)}`,
      );
    }
    this._delayMs = ms;
  }

  /** Снова отвечать сразу: снять молчание и задержку. Запросы, пришедшие в молчании, остаются без ответа. */
  public respond(): void {
    this._silent.clear();
    this._delayMs = 0;
  }

  /** Запросы, дошедшие до сервера, в порядке прихода. */
  public queries(): readonly DnsQueryRecord[] {
    return Object.freeze([...this._log]);
  }

  /** Разрешается, когда до сервера дошло не меньше `count` запросов с момента старта. */
  public waitForQueries(count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) {
      return Promise.reject(
        new RangeError(`число запросов — целое не меньше 1, получено ${valueText(count)}`),
      );
    }
    if (this._log.length >= count) {
      return Promise.resolve();
    }
    if (this._closing !== undefined) {
      return Promise.reject(new Error('сервер DNS закрыт'));
    }
    return new Promise<void>((resolve, reject) => this._waiters.add({ count, resolve, reject }));
  }

  /** Закрыть UDP, TCP, соединения и отложенные ответы; ожидающие `waitForQueries` получают отказ. */
  public close(): Promise<void> {
    this._closing ??= (async () => {
      for (const timer of this._timers) {
        clearTimeout(timer);
      }
      this._timers.clear();
      for (const waiter of this._waiters) {
        waiter.reject(new Error('сервер DNS закрыт'));
      }
      this._waiters.clear();
      const udpClosed = new Promise<void>((resolve) => this._udp.close(() => resolve()));
      const tcpClosed = new Promise<void>((resolve) => this._tcp.close(() => resolve()));
      for (const socket of this._connections.keys()) {
        socket.destroy();
      }
      await Promise.all([udpClosed, tcpClosed, ...this._connections.values()]);
    })();
    return this._closing;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private _handle(message: Buffer, transport: 'udp' | 'tcp', reply: (response: Buffer) => void): void {
    const query = parseDnsQuery(message);
    if (query === undefined) {
      return;
    }
    this._log.push({ name: query.name, type: query.type, transport });
    for (const waiter of this._waiters) {
      if (this._log.length >= waiter.count) {
        this._waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (this._silent.has(transport)) {
      return;
    }
    const response = this._respond(query, transport);
    // Ответ — всегда таймером (0 — следующий оборот): у задержки и её отсутствия один путь, и close снимает оба.
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      reply(response);
    }, this._delayMs);
    this._timers.add(timer);
  }

  private _respond(query: DnsQuery, transport: 'udp' | 'tcp'): Buffer {
    const rcode =
      query.opcode !== 0
        ? DNS_RCODE.notImp
        : query.questions !== 1
          ? DNS_RCODE.formErr
          : query.qclass !== 1
            ? DNS_RCODE.refused
            : this._records.has(query.name)
              ? DNS_RCODE.noError
              : DNS_RCODE.nxDomain;
    const addresses = rcode === DNS_RCODE.noError ? (this._records.get(query.name) ?? []) : [];
    const family =
      query.type === DNS_RECORD_TYPE.A ? isIPv4 : query.type === DNS_RECORD_TYPE.AAAA ? isIPv6 : () => false;
    const answers = addresses
      .filter((address) => family(address))
      .map((address) => ({ type: query.type, address }));
    const full = buildDnsResponse(query, rcode, answers, this._ttlSeconds);
    // По UDP ответ больше, чем клиент примет (512 или размер из EDNS0), — бит TC без записей: клиент повторит по TCP.
    return transport === 'udp' && full.length > query.udpSize
      ? buildDnsResponse(query, rcode, answers, this._ttlSeconds, { truncated: true })
      : full;
  }

  private _serveTcp(socket: Socket): void {
    socket.on('error', (error: Error) => this._errors.push(error));
    this._connections.set(
      socket,
      new Promise<void>((resolve) =>
        socket.once('close', () => {
          this._connections.delete(socket);
          resolve();
        }),
      ),
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);
        if (pending.length < 2 + length) {
          break;
        }
        const message = pending.subarray(2, 2 + length);
        pending = pending.subarray(2 + length);
        this._handle(message, 'tcp', (response) => {
          // Клиент мог уйти раньше ответа: запись в закрытый сокет — 'error', а он погашен выше.
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length, 0);
          socket.write(Buffer.concat([prefix, response]));
        });
      }
    });
  }
}
