import type { Queryable } from './queryable.type';

/**
 * Пул `pg.Pool`: у него отбор и снятие ушли бы на РАЗНЫЕ соединения, поэтому
 * `terminateBackends` берёт из пула одно соединение на весь вызов.
 * Распознаётся по `connect()` и счётчику `totalCount`.
 */
export interface PgPool {
  readonly totalCount: number;
  connect(): Promise<Queryable & { release(error?: Error | boolean): void }>;
}
