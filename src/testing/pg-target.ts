import { requiredEnv } from './required-env';

/** Адрес тестового Postgres из PG_TEST_URL и его хост/порт — для прокси. */
export const pgTarget = (): { url: string; host: string; port: number } => {
  const url = requiredEnv('PG_TEST_URL');
  const parsed = new URL(url);
  return { url, host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(parsed.port || 5432) };
};
