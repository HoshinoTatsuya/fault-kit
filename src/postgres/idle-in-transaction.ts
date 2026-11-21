import { assertNoLockOptions } from './assert-no-lock-options';
import { HeldTransaction } from './held-transaction';
import type { HolderOptions } from './holder-options.type';
import type { PgConnection } from './pg-connection.type';

/**
 * Соединение в состоянии `idle in transaction`: BEGIN, один запрос, тишина.
 * Изоляция READ COMMITTED задана явно: при `default_transaction_isolation`
 * REPEATABLE READ или SERIALIZABLE (роль, база, параметры соединения) первый
 * запрос взял бы снимок на всю транзакцию. Снимка между запросами нет,
 * поэтому горизонт он НЕ держит (`backend_xmin` пуст — проверено спекой при
 * любом уровне по умолчанию), — для этого есть `holdSnapshot`. Нужен для
 * проверок `idle_in_transaction_session_timeout`, мониторинга и пулеров,
 * считающих такие соединения.
 */
export const idleInTransaction = async (
  connection: PgConnection,
  options: HolderOptions = {},
): Promise<HeldTransaction> => {
  assertNoLockOptions(options, 'idleInTransaction');
  return HeldTransaction.open(
    connection,
    { explicit: options.applicationName, fallback: 'fault-kit:idle-in-transaction' },
    'BEGIN ISOLATION LEVEL READ COMMITTED',
    ['SELECT 1'],
    options.timeoutMs,
  );
};
