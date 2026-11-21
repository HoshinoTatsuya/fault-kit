import { deepFreeze } from '../deep-freeze';

/**
 * Как `FaultProxy.drop()` рвёт текущие соединения: `reset` — RST (клиент видит
 * ECONNRESET, как при падении узла или сброшенном состоянии балансировщика),
 * `close` — FIN (сервер штатно закрыл соединение).
 */
export const DROP_MODE = deepFreeze({ reset: 'reset', close: 'close' } as const);
