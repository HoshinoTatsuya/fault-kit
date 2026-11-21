import type { AtLeastOne } from '../at-least-one.type';
import type { BackendConditions } from './backend-conditions.type';

/**
 * Какие соединения снять. Хотя бы одно условие обязательно — и типом, и
 * отказом в рантайме: пустой фильтр не означает «все».
 *
 * Область — ТЕКУЩАЯ база соединения, через которое идёт вызов: держатели
 * соседней базы (своя база на файл спек, воркеры jest параллельно) не
 * снимаются. Другая база — `database: '<имя>'`; весь кластер — явно,
 * `anyDatabase: true` (вместе с `database` — ошибка типа и отказ).
 */
export type BackendFilter =
  | (AtLeastOne<BackendConditions> & { readonly anyDatabase?: never })
  | (AtLeastOne<Omit<BackendConditions, 'database'>> & {
      readonly anyDatabase: true;
      readonly database?: never;
    });
