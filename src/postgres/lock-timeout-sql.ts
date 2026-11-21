import { valueText } from '../value-text';

/** `SET LOCAL lock_timeout` из настроек держателя; по умолчанию 5000 мс. */
export const lockTimeoutSql = (lockTimeoutMs = 5000): string => {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new RangeError(
      `lockTimeoutMs — целое неотрицательное число мс, получено ${valueText(lockTimeoutMs)}`,
    );
  }
  return `SET LOCAL lock_timeout = ${lockTimeoutMs}`;
};
