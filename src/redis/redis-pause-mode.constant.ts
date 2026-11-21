import { deepFreeze } from '../deep-freeze';

/**
 * Режим `CLIENT PAUSE` (Redis 6.2+).
 * - `all` — стоят все команды всех клиентов, включая того, кто поставил
 *   паузу: досрочно её не снять (`CLIENT UNPAUSE` тоже ждёт конца).
 * - `write` — стоят записи, чтение и `CLIENT UNPAUSE` проходят. Стоят и
 *   команды, которые МОГУТ писать: `EVAL`/`EVALSHA` любого скрипта без флага
 *   `no-writes`, `PUBLISH`, `PFCOUNT`; истечение ключей и вытеснение тоже
 *   остановлены — ключ с истёкшим сроком невидим для чтения, но не удалён
 *   (занимает память, считается в `DBSIZE`), пока пауза не снята.
 */
export const REDIS_PAUSE_MODE = deepFreeze({ all: 'ALL', write: 'WRITE' } as const);
