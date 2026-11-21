import { deepFreeze } from '../deep-freeze';

/** Типы записей, на которые сервер отвечает адресами. Остальные типы — ответ без записей. */
export const DNS_RECORD_TYPE = deepFreeze({ A: 1, AAAA: 28 } as const);
