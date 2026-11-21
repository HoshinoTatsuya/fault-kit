import { quoteIdent } from './quote-ident';
import type { TableRef } from './table-ref.type';

/** Таблица как текст SQL: `"имя"` или `"схема"."имя"`. */
export const tableSql = (table: TableRef): string =>
  typeof table === 'string' ? quoteIdent(table) : `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
