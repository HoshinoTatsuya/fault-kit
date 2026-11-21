import { assertNoLockOptions } from './assert-no-lock-options';
import { HeldTransaction } from './held-transaction';
import type { HolderOptions } from './holder-options.type';
import type { PgConnection } from './pg-connection.type';

/**
 * Держатель горизонта: транзакция REPEATABLE READ со снимком, взятым при
 * открытии. Пока она открыта, VACUUM не убирает строки, умершие после снимка,
 * — так выглядит длинный отчёт, забытая транзакция в пуле, реплика с
 * `hot_standby_feedback`. Строки, удалённые ДО вызова, VACUUM уберёт: снимок
 * их уже не видит.
 */
export const holdSnapshot = async (
  connection: PgConnection,
  options: HolderOptions = {},
): Promise<HeldTransaction> => {
  assertNoLockOptions(options, 'holdSnapshot');
  return HeldTransaction.open(
    connection,
    { explicit: options.applicationName, fallback: 'fault-kit:snapshot' },
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    ['SELECT 1'],
    options.timeoutMs,
  );
};
