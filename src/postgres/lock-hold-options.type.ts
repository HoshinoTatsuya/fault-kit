import type { HolderBaseOptions } from './holder-base-options.type';

/**
 * Настройки держателей блокировки (`holdLock`, `holdWriter`).
 * `lockTimeoutMs` — сколько ждать саму блокировку, если таблицу уже держит
 * кто-то другой (0 — без потолка, тогда ожидание ограничивает `timeoutMs`);
 * заданный явно, обязан быть меньше `timeoutMs`. `only` — `LOCK TABLE
 * ONLY`: только сама таблица, без секций и наследников (по умолчанию
 * блокируются и они — так же, как их заблокировал бы DDL по родителю).
 * Без `lockTimeoutMs` — 5000, но не больше половины `timeoutMs` (при
 * `timeoutMs` меньше 2 — без своего потолка).
 */
export interface LockHoldOptions extends HolderBaseOptions {
  readonly lockTimeoutMs?: number;
  readonly only?: boolean;
}
