import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { holdSnapshot } from './hold-snapshot';
import { horizonAge } from './horizon-age';

/** VACUUM VERBOSE таблицы: сколько мёртвых строк убрано и сколько осталось неубираемыми. */
const vacuum = async (client: Client, table: string): Promise<{ removed: number; notRemovable: number }> => {
  const notices: string[] = [];
  const listener = (notice: { message?: string | undefined }): void => {
    notices.push(notice.message ?? '');
  };
  client.on('notice', listener);
  try {
    await client.query(`VACUUM (VERBOSE) ${table}`);
  } finally {
    client.off('notice', listener);
  }
  const line = notices
    .join('\n')
    .match(/tuples: (\d+) removed, \d+ remain, (\d+) are dead but not yet removable/);
  if (line === null) {
    throw new Error(`в выводе VACUUM VERBOSE нет строки tuples: ${notices.join(' | ')}`);
  }
  return { removed: Number(line[1]), notRemovable: Number(line[2]) };
};

describe('holdSnapshot — держатель горизонта на настоящем Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: Client;

  beforeEach(async () => {
    db = await freshDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE TABLE bloat (id int) WITH (autovacuum_enabled = false)');
  });

  afterEach(async () => {
    await client.end();
    await db.drop();
  });

  const refill = async (): Promise<void> => {
    await client.query('INSERT INTO bloat SELECT generate_series(1, 500)');
  };

  it('контроль: без держателя VACUUM убирает все 500 мёртвых строк', async () => {
    await refill();
    await client.query('DELETE FROM bloat');
    expect(await vacuum(client, 'bloat')).toEqual({ removed: 500, notRemovable: 0 });
  });

  it('с держателем мёртвые строки НЕ убираются; после release — убираются все', async () => {
    await refill();
    const holder = await holdSnapshot(db.url);
    try {
      await client.query('DELETE FROM bloat');
      expect(await vacuum(client, 'bloat')).toEqual({ removed: 0, notRemovable: 500 });
    } finally {
      await holder.release();
    }
    expect(await vacuum(client, 'bloat')).toEqual({ removed: 500, notRemovable: 0 });
  });

  it('horizonAge: держатель виден по pid, возраст растёт с каждой выданной транзакцией; после release — свободно', async () => {
    const holder = await holdSnapshot(db.url, { applicationName: 'snapshot-under-test' });
    try {
      const before = await horizonAge(client);
      for (let index = 0; index < 25; index += 1) {
        await client.query('SELECT pg_current_xact_id()');
      }
      const after = await horizonAge(client);
      expect(
        after.holders.map((h) => ({ kind: h.kind, id: h.id, app: h.applicationName, state: h.state })),
      ).toContainEqual({
        kind: 'backend',
        id: String(holder.pid),
        app: 'snapshot-under-test',
        state: 'idle in transaction',
      });
      expect(after.age - before.age).toBeGreaterThanOrEqual(25);
      expect(after.age).toBe(after.holders[0]?.age);
    } finally {
      await holder.release();
    }
    // База своя, таблица без автоочистки: после release горизонт не держит никто.
    expect(await horizonAge(client)).toEqual({ age: 0, holders: [] });
  });

  it('release повторно — то же обещание; asyncDispose отпускает', async () => {
    const holder = await holdSnapshot(db.url);
    const first = holder.release();
    expect(holder.release()).toBe(first);
    await first;
    {
      await using disposable = await holdSnapshot(db.url, { applicationName: 'disposable-snapshot' });
      expect(disposable.pid).toBeGreaterThan(0);
    }
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'disposable-snapshot'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});
