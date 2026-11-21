import { connect, createServer, type Server, type Socket } from 'node:net';
import { TIMER_CEILING_MS } from '../timer-ceiling-ms.constant';
import { valueText } from '../value-text';
import { DROP_MODE } from './drop-mode.constant';
import type { DropMode } from './drop-mode.type';
import type { FaultProxyOptions } from './fault-proxy-options.type';
import type { FaultProxyStats } from './fault-proxy-stats.type';
import { ProxyDirection } from './proxy-direction';
import type { ProxyState } from './proxy-state.type';

/**
 * TCP-прокси с управляемыми отказами — для спек, проверяющих поведение
 * клиента, когда сеть ведёт себя не как «работает» или «оборвалась»:
 *
 * - `freeze()` — ничего не идёт ни в одну сторону: ни байты, ни FIN, ни RST,
 *   ни новое подключение к цели, сокеты клиентов открыты. Так выглядит потеря
 *   пакетов, зависший узел, чёрная дыра маршрута: команда уходит и не получает
 *   ни ответа, ни ошибки. `thaw()` отпускает накопленное в исходном порядке;
 * - `drop()` — оборвать текущие соединения (RST или FIN), новые принимаются;
 * - `latency(ms)` — задержка каждого события в обе стороны (и закрытия тоже),
 *   порядок сохраняется;
 * - `blackholeNew()` — новые соединения принимаются и не обслуживаются: TCP
 *   установлен, ответа протокола нет никогда.
 *
 * Чем НЕ является. Замороженный прокси — процесс на этой же машине: ядро
 * подтверждает (ACK) отправленное клиентом, поэтому TCP keepalive и
 * ретрансмиссии клиента заморозку не обнаружат, в отличие от настоящей
 * потери пакетов. Спека «keepalive обнаружит мёртвый узел» на этом прокси
 * краснеет на исправном клиенте. `blackholeNew()` не теряет SYN: соединение
 * устанавливается, таймаут TCP-подключения клиента не проверяется — только
 * ожидание первого ответа протокола. Байты, уже отданные ядру до `freeze()`
 * (буферы сокетов, на loopback — сотни КБ), до получателя дойдут: прокси
 * останавливает только то, что ещё не отдал.
 */
export class FaultProxy implements AsyncDisposable {
  private readonly _state: ProxyState = { frozen: false, latencyMs: 0 };
  private readonly _sockets = new Map<Socket, Promise<void>>();
  private readonly _clients = new Set<Socket>();
  private readonly _waiting = new Set<Socket>();
  private readonly _directions = new Map<ProxyDirection, 'toUpstream' | 'toClient'>();
  private _blackhole = false;
  private _accepted = 0;
  private _blackholed = 0;
  private _bytesToUpstream = 0;
  private _bytesToClient = 0;
  private _closing: Promise<void> | undefined;

  private constructor(
    private readonly _target: { readonly host: string; readonly port: number },
    private readonly _server: Server,
  ) {}

  /** Запустить прокси к `host:port`; слушает `listenHost:listenPort` (по умолчанию свободный порт 127.0.0.1). */
  public static async start(options: FaultProxyOptions): Promise<FaultProxy> {
    // allowHalfOpen: FIN клиента — событие его направления, а не закрытие пары;
    // pauseOnConnect: байты клиента ждут в ядре, пока прокси не решил, куда их нести.
    if (typeof options.host !== 'string' || options.host === '') {
      throw new TypeError('адрес цели — непустая строка');
    }
    for (const [name, value, min] of [
      ['port', options.port, 1],
      ['listenPort', options.listenPort ?? 0, 0],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < min || value > 65_535) {
        throw new RangeError(`${name} — целое ${min}..65535, получено ${valueText(value)}`);
      }
    }
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const proxy = new FaultProxy({ host: options.host, port: options.port }, server);
    server.on('connection', (client) => proxy._accept(client));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.listenPort ?? 0, options.listenHost ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return proxy;
  }

  /** Адрес, на котором слушает прокси. */
  public get host(): string {
    return this._address().address;
  }

  public get port(): number {
    return this._address().port;
  }

  /**
   * Перестать передавать в обе стороны: данные, FIN и RST стоят в очередях,
   * соединения, принятые под заморозкой, не подключаются к цели. Сокеты
   * клиентов остаются открытыми.
   */
  public freeze(): void {
    this._state.frozen = true;
    // Источники — на паузу сразу, а не со следующим куском: в замёрзшей сети отправитель упирается в окно TCP.
    for (const direction of this._directions.keys()) {
      direction.pump();
    }
  }

  /** Возобновить передачу: накопленное за заморозку уходит в исходном порядке, ждавшие подключаются к цели. */
  public thaw(): void {
    this._state.frozen = false;
    for (const client of this._waiting) {
      this._waiting.delete(client);
      this._connectUpstream(client);
    }
    for (const direction of this._directions.keys()) {
      direction.pump();
    }
  }

  /**
   * Оборвать все текущие соединения (и клиентские, и к цели); новые
   * принимаются как обычно. `reset` — RST; `close` — FIN: непрочитанное
   * прокси вычитывается и выбрасывается (закрытие сокета с непрочитанными
   * байтами ядро превращает в RST), сокет закрывается, когда закроется
   * сторона-собеседник. Очереди не передаются. Возвращает, сколько клиентских
   * соединений оборвано.
   */
  public drop(mode: DropMode = DROP_MODE.reset): number {
    if (mode !== DROP_MODE.reset && mode !== DROP_MODE.close) {
      throw new RangeError(`неизвестный способ обрыва: ${valueText(mode)}`);
    }
    const dropped = this._clients.size;
    for (const direction of this._directions.keys()) {
      direction.dispose();
    }
    this._directions.clear();
    this._waiting.clear();
    for (const socket of this._sockets.keys()) {
      if (socket.destroyed) {
        continue;
      }
      if (socket.connecting) {
        socket.destroy();
      } else if (mode === DROP_MODE.reset) {
        socket.resetAndDestroy();
      } else {
        socket.on('data', () => undefined);
        socket.resume();
        socket.end();
      }
    }
    return dropped;
  }

  /**
   * Задержка каждого события в обе стороны, мс; 0 — без задержки. Действует и
   * на уже накопленное. Не больше 2³¹−1 мс: больше `setTimeout` молча ставит
   * 1 мс и перезаводил бы таймер без конца; «никогда» — это `freeze()`.
   */
  public latency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > TIMER_CEILING_MS) {
      throw new RangeError(
        `задержка — число мс от 0 до ${TIMER_CEILING_MS} (потолок таймера Node; «никогда» — freeze()), получено ${valueText(ms)}`,
      );
    }
    this._state.latencyMs = ms;
    for (const direction of this._directions.keys()) {
      direction.pump();
    }
  }

  /**
   * Новые соединения принимать и не обслуживать (`false` — снова обслуживать).
   * «Новые» — принятые прокси ПОСЛЕ вызова: клиент видит 'connect' раньше,
   * чем прокси принял соединение, так что только что открытое клиентом
   * соединение тоже может оказаться поглощённым. Уже поглощённые остаются
   * поглощёнными до `drop()` или `close()`.
   */
  public blackholeNew(enabled = true): void {
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`blackholeNew — true или false, получено ${valueText(enabled)}`);
    }
    this._blackhole = enabled;
  }

  public stats(): FaultProxyStats {
    let queuedToUpstream = 0;
    let queuedToClient = 0;
    for (const [direction, role] of this._directions) {
      if (role === 'toUpstream') {
        queuedToUpstream += direction.queuedBytes;
      } else {
        queuedToClient += direction.queuedBytes;
      }
    }
    return Object.freeze({
      accepted: this._accepted,
      active: this._clients.size,
      blackholed: this._blackholed,
      bytesToUpstream: this._bytesToUpstream,
      bytesToClient: this._bytesToClient,
      queuedToUpstream,
      queuedToClient,
    });
  }

  /** Перестать слушать, закрыть все соединения и таймеры; разрешается, когда закрыто всё. */
  public close(): Promise<void> {
    this._closing ??= (async () => {
      const listening = new Promise<void>((resolve) => this._server.close(() => resolve()));
      for (const direction of this._directions.keys()) {
        direction.dispose();
      }
      this._waiting.clear();
      for (const socket of this._sockets.keys()) {
        socket.destroy();
      }
      await Promise.all([listening, ...this._sockets.values()]);
    })();
    return this._closing;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private _accept(client: Socket): void {
    this._accepted += 1;
    this._track(client);
    this._clients.add(client);
    client.once('close', () => {
      this._clients.delete(client);
      this._waiting.delete(client);
    });
    if (this._blackhole || this._closing !== undefined) {
      this._blackholed += 1;
      return;
    }
    if (this._state.frozen) {
      // В замёрзшей сети SYN до цели не дошёл бы: подключение — после thaw().
      this._waiting.add(client);
      return;
    }
    this._connectUpstream(client);
  }

  private _connectUpstream(client: Socket): void {
    const upstream = connect({ host: this._target.host, port: this._target.port, allowHalfOpen: true });
    this._track(upstream);
    const toUpstream = new ProxyDirection(client, upstream, this._state, (bytes) => {
      this._bytesToUpstream += bytes;
    });
    const toClient = new ProxyDirection(upstream, client, this._state, (bytes) => {
      this._bytesToClient += bytes;
    });
    this._directions.set(toUpstream, 'toUpstream');
    this._directions.set(toClient, 'toClient');
    toUpstream.pump();
    toClient.pump();
    // Сторона закрылась целиком — у второй больше нет собеседника: закрыть её, когда ей доставлено всё,
    // что для неё стояло в очереди (иначе соединение к цели висело бы, пока цель сама не закроет).
    const closeWhenDelivered = (socket: Socket, direction: ProxyDirection) => () =>
      direction.afterFinal(() => {
        if (!socket.destroyed) {
          socket.destroySoon();
        }
      });
    client.once('close', closeWhenDelivered(upstream, toUpstream));
    upstream.once('close', closeWhenDelivered(client, toClient));
    const forget = (): void => {
      if (client.destroyed && upstream.destroyed) {
        this._directions.delete(toUpstream);
        this._directions.delete(toClient);
      }
    };
    client.once('close', forget);
    upstream.once('close', forget);
  }

  private _track(socket: Socket): void {
    socket.on('error', () => undefined);
    this._sockets.set(
      socket,
      new Promise<void>((resolve) =>
        socket.once('close', () => {
          this._sockets.delete(socket);
          resolve();
        }),
      ),
    );
  }

  private _address(): { address: string; port: number } {
    const address = this._server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('прокси не слушает TCP-порт');
    }
    return address;
  }
}
