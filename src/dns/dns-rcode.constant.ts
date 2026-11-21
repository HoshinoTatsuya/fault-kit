import { deepFreeze } from '../deep-freeze';

/**
 * Коды ответа DNS (RFC 1035 §4.1.1), которые выдаёт сервер: имя есть — NOERROR,
 * имени нет — NXDOMAIN; вопросов не ровно один — FORMERR; код операции не
 * QUERY — NOTIMP; класс вопроса не IN — REFUSED.
 */
export const DNS_RCODE = deepFreeze({ noError: 0, formErr: 1, nxDomain: 3, notImp: 4, refused: 5 } as const);
