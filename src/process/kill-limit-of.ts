import { valueText } from '../value-text';

/**
 * `killLimit` из настроек → число; неверное значение — RangeError с текстом.
 * Вызывается ДО запуска оболочки (`spawnBehindShell`): отказ после `spawn`
 * оставлял бы живую оболочку с командой, на которую у вызывающего нет ссылки.
 */
export function killLimitOf(value: unknown): number {
  // Не задан — 64 поштучных SIGKILL при уборке.
  const limit = value ?? 64;
  if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
    throw new RangeError(`killLimit — целое неотрицательное, получено ${valueText(limit)}`);
  }
  return limit as number;
}
