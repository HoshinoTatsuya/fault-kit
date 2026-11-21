import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { dropDatabase } from './drop-database';
import { pgTarget } from './pg-target';

/**
 * Своя база на файл спек. Горизонт VACUUM обычных таблиц считается по
 * соединениям ЭТОЙ базы, поэтому держатель снимка соседней спеки (воркеры
 * jest идут параллельно) не меняет здесь ни VACUUM, ни `horizonAge`.
 * `drop()` (и `await using`) — `DROP DATABASE … WITH (FORCE)`, Postgres 13+:
 * забытое соединение не оставит базу.
 */
export const freshDatabase = async (): Promise<{
  url: string;
  drop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}> => {
  const { url } = pgTarget();
  const name = `fault_kit_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const own = new URL(url);
  own.pathname = `/${name}`;
  const drop = async (): Promise<void> => {
    const cleaner = new Client({ connectionString: url });
    await cleaner.connect();
    try {
      await dropDatabase(cleaner, name);
    } finally {
      await cleaner.end();
    }
  };
  return { url: own.toString(), drop, [Symbol.asyncDispose]: drop };
};
