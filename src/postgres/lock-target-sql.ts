import { valueText } from '../value-text';
import { holderTimeoutMs } from './holder-timeout-ms';
import type { LockHoldOptions } from './lock-hold-options.type';
import { lockTimeoutSql } from './lock-timeout-sql';
import type { TableRef } from './table-ref.type';
import { tableSql } from './table-sql';

/**
 * `SET LOCAL lock_timeout` и `LOCK TABLE [ONLY] … IN <mode> MODE` из настроек
 * держателя блокировки. Без `lockTimeoutMs` — 5000, но не больше половины
 * `timeoutMs` (меньше 1 мс — 0, без своего потолка); заданный явно обязан
 * быть меньше `timeoutMs`.
 */
export const lockTargetSql = (table: TableRef, mode: string, options: LockHoldOptions): readonly string[] => {
  if (options.only !== undefined && typeof options.only !== 'boolean') {
    throw new TypeError(`only — true или false, получено ${valueText(options.only)}`);
  }
  const timeoutMs = holderTimeoutMs(options.timeoutMs);
  // Умолчание выводится из потолка держателя: заданный timeoutMs 3000 не должен ломаться о 5000 по умолчанию.
  const lockTimeoutMs = options.lockTimeoutMs ?? Math.min(5000, Math.floor(timeoutMs / 2));
  // Форма — до сравнения: сравнение приводит значение к числу и на значении без прототипа бросило бы TypeError.
  const lockTimeout = lockTimeoutSql(lockTimeoutMs);
  if (lockTimeoutMs > 0 && lockTimeoutMs >= timeoutMs) {
    throw new RangeError(
      `lockTimeoutMs (${lockTimeoutMs}) не меньше timeoutMs (${timeoutMs}): держатель упал бы по общему потолку раньше, чем по lock_timeout`,
    );
  }
  return [
    lockTimeout,
    `LOCK TABLE ${options.only === true ? 'ONLY ' : ''}${tableSql(table)} IN ${mode} MODE`,
  ];
};
