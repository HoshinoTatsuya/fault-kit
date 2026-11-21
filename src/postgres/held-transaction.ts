import { Client, type ClientConfig } from 'pg';

import { holderTimeoutMs } from './holder-timeout-ms';
import type { PgConnection } from './pg-connection.type';

/**
 * Открытая транзакция на отдельном соединении, которую держат, пока спека не
 * отпустит. Соединение своё, а не из пула вызывающего: держатель — это другой
 * клиент базы, как и в отказе, который он изображает.
 *
 * `pid` и `applicationName` — то, что видит СЕРВЕР: оба читаются внутри
 * транзакции держателя последним запросом (за пулером в режиме транзакций
 * запрос до BEGIN попал бы на другой серверный процесс), имя ставится
 * `set_config(…, true)` — локально в транзакции, соседям по пулеру не
 * достаётся.
 *
 * `release()` — ROLLBACK и закрытие соединения; разрешается, когда сервер
 * подтвердил откат, то есть горизонт и блокировки к этому моменту уже
 * отпущены (закрыть сокет без отката недостаточно: сервер заметит разрыв
 * позже, и следующий шаг спеки увидит держателя ещё живым). Повторный вызов —
 * тот же результат. Не уложился в `timeoutMs` (держатель за замёрзшим
 * прокси) — соединение разорвано, отказ: откат не подтверждён. Соединение,
 * оборванное сервером (`terminateBackends`,
 * `idle_in_transaction_session_timeout`), не роняет процесс: ошибка видна в
 * `lostWith`, `release()` его просто закрывает.
 */
export class HeldTransaction implements AsyncDisposable {
  private _lostWith: Error | undefined;
  private _released: Promise<void> | undefined;
  private readonly _lost: Promise<Error>;
  private _notLost: (error: Error) => void = () => undefined;

  private constructor(
    private readonly _client: Client,
    public readonly pid: number,
    public readonly applicationName: string,
    /** Номер транзакции, если он выдан (`holdWriter`); у держателя без записи — `undefined`. */
    public readonly xid: string | undefined,
    private readonly _timeoutMs: number,
  ) {
    this._lost = new Promise<Error>((resolve, reject) => {
      this._notLost = reject;
      const lose = (error: Error): void => {
        // Ошибка или закрытие во время своего release() — не обрыв сервером.
        if (this._released === undefined) {
          this._lostWith ??= error;
          resolve(error);
        }
      };
      // pg сам превращает закрытие без ErrorResponse (FIN сервера или балансировщика) в 'error'
      // «Connection terminated unexpectedly» — это проверено спекой, второй подписки не нужно.
      _client.on('error', lose);
    });
    this._lost.catch(() => undefined);
  }

  /**
   * Открыть соединение, начать транзакцию `begin`, поставить имя приложения и
   * выполнить `statements` по порядку; отказ любого шага или потолок
   * `timeoutMs` — соединение закрыто (или разорвано), отказ наружу. Имя:
   * явное `applicationName.explicit`, иначе то, что сервер получил из
   * настроек соединения, иначе `applicationName.fallback`.
   */
  public static async open(
    connection: PgConnection,
    applicationName: { readonly explicit: string | undefined; readonly fallback: string },
    begin: string,
    statements: readonly string[],
    timeoutMs?: number,
  ): Promise<HeldTransaction> {
    const ceiling = holderTimeoutMs(timeoutMs);
    const base: ClientConfig = typeof connection === 'string' ? { connectionString: connection } : connection;
    const client = new Client(base);
    client.on('error', () => undefined);
    const opening = (async () => {
      await client.connect();
      await client.query(begin);
      await client.query(
        "SELECT pg_catalog.set_config('application_name', coalesce($1::text, nullif(pg_catalog.current_setting('application_name'), ''), $2::text), true)",
        [applicationName.explicit ?? null, applicationName.fallback],
      );
      for (const statement of statements) {
        await client.query(statement);
      }
      const { rows } = await client.query<{ pid: number; name: string; xid: string | null }>(
        "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_setting('application_name') AS name, pg_catalog.pg_current_xact_id_if_assigned()::text AS xid",
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('pg_backend_pid() не вернул строку');
      }
      return new HeldTransaction(client, row.pid, row.name, row.xid ?? undefined, ceiling);
    })();
    try {
      return await HeldTransaction._within(
        opening,
        ceiling,
        client,
        `держатель не открылся за ${ceiling} мс`,
      );
    } catch (error) {
      await HeldTransaction._within(client.end(), ceiling, client, 'закрытие').catch(() => undefined);
      throw error;
    }
  }

  /** Ошибка, с которой сервер оборвал соединение держателя; `undefined` — соединение живо. */
  public get lostWith(): Error | undefined {
    return this._lostWith;
  }

  /**
   * Событие «сервер оборвал соединение держателя» (ошибкой или закрытием без
   * ErrorResponse) — для утверждений вида «таймаут простаивающей транзакции
   * сработал» без опроса. Держатель освобождён `release()` без обрыва —
   * отказ, а не вечное ожидание: закрытие по нашей инициативе — не обрыв.
   */
  public whenLost(): Promise<Error> {
    return this._lost;
  }

  public release(): Promise<void> {
    this._released ??= HeldTransaction._within(
      (async () => {
        if (this._lostWith === undefined) {
          await this._client.query('ROLLBACK').catch(() => undefined);
        }
        await this._client.end().catch(() => undefined);
        this._notLost(new Error(`держатель ${this.pid} освобождён: обрыва не было`));
      })(),
      this._timeoutMs,
      this._client,
      `откат держателя ${this.pid} не подтверждён за ${this._timeoutMs} мс: соединение разорвано`,
    );
    return this._released;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.release();
  }

  /** Работа под потолком: не уложилась — сокет соединения разорван (иначе `end()` ждал бы вечно), отказ с `message`. */
  private static _within<T>(work: Promise<T>, ms: number, client: Client, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const ceiling = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        (
          client as unknown as { connection?: { stream?: { destroy(): void } } }
        ).connection?.stream?.destroy();
        reject(new Error(message));
      }, ms);
    });
    work.catch(() => undefined);
    return Promise.race([work, ceiling]).finally(() => clearTimeout(timer));
  }
}
