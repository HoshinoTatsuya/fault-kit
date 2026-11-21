import { deepFreeze } from '../deep-freeze';

/** Режимы `LOCK TABLE` (таблица конфликтов — документация Postgres, «Table-Level Locks»). */
export const LOCK_MODE = deepFreeze({
  accessShare: 'ACCESS SHARE',
  rowShare: 'ROW SHARE',
  rowExclusive: 'ROW EXCLUSIVE',
  shareUpdateExclusive: 'SHARE UPDATE EXCLUSIVE',
  share: 'SHARE',
  shareRowExclusive: 'SHARE ROW EXCLUSIVE',
  exclusive: 'EXCLUSIVE',
  accessExclusive: 'ACCESS EXCLUSIVE',
} as const);
