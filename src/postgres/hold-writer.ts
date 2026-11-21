import { HeldTransaction } from './held-transaction';
import type { LockHoldOptions } from './lock-hold-options.type';
import { lockTargetSql } from './lock-target-sql';
import type { PgConnection } from './pg-connection.type';
import type { TableRef } from './table-ref.type';

/**
 * Открытая пишущая транзакция по таблице: блокировка ROW EXCLUSIVE (ту же
 * берёт любой INSERT/UPDATE/DELETE) и выданный номер транзакции. Строк не
 * пишет — схема таблицы держателю не нужна. На ней ждут и падают по
 * `lock_timeout` `CREATE INDEX CONCURRENTLY` (оставляя INVALID-индекс),
 * `ALTER TABLE`, `VACUUM FULL`; горизонт она тоже держит (номером транзакции).
 */
export const holdWriter = async (
  connection: PgConnection,
  table: TableRef,
  options: LockHoldOptions = {},
): Promise<HeldTransaction> =>
  HeldTransaction.open(
    connection,
    { explicit: options.applicationName, fallback: 'fault-kit:writer' },
    'BEGIN ISOLATION LEVEL READ COMMITTED',
    [...lockTargetSql(table, 'ROW EXCLUSIVE', options), 'SELECT pg_catalog.pg_current_xact_id()'],
    options.timeoutMs,
  );
