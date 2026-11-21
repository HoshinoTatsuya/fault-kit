/**
 * Таблица: имя (ищется по `search_path`) или схема и имя. Части берутся как
 * идентификаторы в кавычках: `'public.t'` — таблица с точкой в имени, а не
 * таблица `t` схемы `public`.
 */
export type TableRef = string | { readonly schema: string; readonly name: string };
