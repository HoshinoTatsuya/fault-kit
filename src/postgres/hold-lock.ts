import { valueText } from '../value-text';
import { HeldTransaction } from './held-transaction';
import type { LockHoldOptions } from './lock-hold-options.type';
import { LOCK_MODE } from './lock-mode.constant';
import type { LockMode } from './lock-mode.type';
import { lockTargetSql } from './lock-target-sql';
import type { PgConnection } from './pg-connection.type';
import type { TableRef } from './table-ref.type';

/**
 * Транзакция, держащая `LOCK TABLE … IN <mode> MODE` до `release()`. Изоляция
 * READ COMMITTED задана явно: снимка держатель блокировки не берёт и горизонт
 * не держит при любом уровне по умолчанию. Секции и наследники блокируются
 * тоже (`only: true` — только сама таблица). Неизвестный режим — отказ до
 * подключения.
 */
export const holdLock = async (
  connection: PgConnection,
  table: TableRef,
  mode: LockMode,
  options: LockHoldOptions = {},
): Promise<HeldTransaction> => {
  if (!Object.values(LOCK_MODE).includes(mode)) {
    throw new RangeError(`неизвестный режим блокировки: ${valueText(mode)}`);
  }
  return HeldTransaction.open(
    connection,
    { explicit: options.applicationName, fallback: 'fault-kit:lock' },
    'BEGIN ISOLATION LEVEL READ COMMITTED',
    lockTargetSql(table, mode, options),
    options.timeoutMs,
  );
};
