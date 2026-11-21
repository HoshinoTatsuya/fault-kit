import type { HolderBaseOptions } from './holder-base-options.type';

/**
 * Настройки держателей без блокировки таблицы (`holdSnapshot`,
 * `idleInTransaction`). `lockTimeoutMs` и `only` здесь — ошибка типа (и
 * `TypeError` в рантайме): настройки держателя блокировки (`LockHoldOptions`)
 * сюда не передаются молча проигнорированными.
 */
export interface HolderOptions extends HolderBaseOptions {
  readonly lockTimeoutMs?: never;
  readonly only?: never;
}
