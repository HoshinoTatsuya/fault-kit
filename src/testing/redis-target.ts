import { requiredEnv } from './required-env';

/** Адрес тестового Redis из REDIS_TEST_URL. */
export const redisTarget = (): { host: string; port: number } => {
  const url = new URL(requiredEnv('REDIS_TEST_URL'));
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port || 6379) };
};
