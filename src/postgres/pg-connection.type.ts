import type { ClientConfig } from 'pg';

/** Адрес (строка подключения) или настройки `pg.Client`. Держатель открывает по нему СВОЁ соединение. */
export type PgConnection = string | ClientConfig;
