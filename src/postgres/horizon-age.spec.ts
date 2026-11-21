import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { holdSnapshot } from './hold-snapshot';
import { horizonAge } from './horizon-age';
import type { Queryable } from './queryable.type';

/**
 * Фоновый держатель горизонта (autovacuum) появляется в случайный момент —
 * поэтому он подставлен: временное представление поверх настоящего
 * `pg_stat_activity` добавляет строку autovacuum worker со снимком, а
 * обёртка запроса направляет `pg_catalog.pg_stat_activity` в него. Всё
 * остальное — настоящий сервер.
 */
describe('horizonAge: фоновые процессы', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: Client;
  let withAutovacuum: Queryable;

  beforeAll(async () => {
    db = await freshDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query(`CREATE TEMP VIEW activity_with_autovacuum AS
      SELECT pid, backend_xmin, backend_xid, application_name, state, datname, backend_type, usename FROM pg_catalog.pg_stat_activity
      UNION ALL
      SELECT 999999, (pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())::text)::xid, NULL::xid, '', 'active',
             pg_catalog.current_database(), 'autovacuum worker', NULL::name`);
    withAutovacuum = {
      query: (text, values) =>
        client.query(
          text.replaceAll('pg_catalog.pg_stat_activity', 'pg_temp.activity_with_autovacuum'),
          values,
        ),
    };
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  it('autovacuum со снимком не считается держателем по умолчанию; includeBackground — считается', async () => {
    expect(await horizonAge(withAutovacuum)).toEqual({ age: 0, holders: [] });
    const all = await horizonAge(withAutovacuum, { includeBackground: true });
    expect(all.holders.map((holder) => ({ id: holder.id, backendType: holder.backendType }))).toEqual([
      { id: '999999', backendType: 'autovacuum worker' },
    ]);
  });

  it('клиентский держатель виден с типом client backend', async () => {
    await using held = await holdSnapshot(db.url);
    const report = await horizonAge(client);
    expect(report.holders.map((holder) => ({ id: holder.id, backendType: holder.backendType }))).toEqual([
      { id: String(held.pid), backendType: 'client backend' },
    ]);
  });

  it('системные представления — из pg_catalog при любом search_path', async () => {
    await using held = await holdSnapshot(db.url);
    const hijacked = new Client({ connectionString: db.url });
    await hijacked.connect();
    try {
      await hijacked.query('CREATE SCHEMA IF NOT EXISTS shadow');
      await hijacked.query(
        'CREATE OR REPLACE VIEW shadow.pg_stat_activity AS SELECT * FROM pg_catalog.pg_stat_activity WHERE false',
      );
      await hijacked.query('SET search_path = shadow, pg_catalog');
      expect((await horizonAge(hijacked)).holders.map((holder) => holder.id)).toEqual([String(held.pid)]);
    } finally {
      await hijacked.end();
    }
  });
});
