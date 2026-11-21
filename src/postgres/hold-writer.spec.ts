import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { holdWriter } from './hold-writer';
import { horizonAge } from './horizon-age';

describe('holdWriter — открытая пишущая транзакция на настоящем Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: Client;

  beforeEach(async () => {
    db = await freshDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE TABLE events (id int)');
    await client.query('INSERT INTO events SELECT generate_series(1, 100)');
  });

  afterEach(async () => {
    await client.end();
    await db.drop();
  });

  const indexValid = async (): Promise<boolean[]> => {
    const { rows } = await client.query<{ valid: boolean }>(
      "SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'events_id_idx'",
    );
    return rows.map((row) => row.valid);
  };

  it('держит ROW EXCLUSIVE на таблице и номер транзакции (горизонт тоже)', async () => {
    await using writer = await holdWriter(db.url, 'events');
    const { rows } = await client.query(
      "SELECT mode, granted FROM pg_locks WHERE pid = $1 AND relation = 'events'::regclass",
      [writer.pid],
    );
    expect(rows).toEqual([{ mode: 'RowExclusiveLock', granted: true }]);
    expect((await horizonAge(client)).holders.map((h) => h.id)).toContain(String(writer.pid));
  });

  it('CREATE INDEX CONCURRENTLY под lock_timeout падает (55P03) и оставляет INVALID-индекс; после release — строится', async () => {
    const writer = await holdWriter(db.url, 'events');
    try {
      await client.query("SET lock_timeout = '300ms'");
      await expect(
        client.query('CREATE INDEX CONCURRENTLY events_id_idx ON events (id)'),
      ).rejects.toMatchObject({
        code: '55P03',
      });
      expect(await indexValid()).toEqual([false]);
    } finally {
      await writer.release();
    }
    await client.query('DROP INDEX events_id_idx');
    await client.query('CREATE INDEX CONCURRENTLY events_id_idx ON events (id)');
    expect(await indexValid()).toEqual([true]);
  });

  it('таблица со схемой и кавычкой в имени', async () => {
    await client.query('CREATE SCHEMA "odd schema"');
    await client.query('CREATE TABLE "odd schema"."we""ird" (id int)');
    await using writer = await holdWriter(db.url, { schema: 'odd schema', name: 'we"ird' });
    const { rows } = await client.query(
      `SELECT mode FROM pg_locks WHERE pid = $1 AND relation = '"odd schema"."we""ird"'::regclass`,
      [writer.pid],
    );
    expect(rows).toEqual([{ mode: 'RowExclusiveLock' }]);
  });

  it('таблицы нет — отказ при открытии, соединение не утекает', async () => {
    await expect(holdWriter(db.url, 'missing', { applicationName: 'writer-missing' })).rejects.toMatchObject({
      code: '42P01',
    });
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'writer-missing'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});
