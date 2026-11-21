import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { holdLock } from './hold-lock';
import { LOCK_MODE } from './lock-mode.constant';

/** Имя режима в pg_locks: 'ROW EXCLUSIVE' → 'RowExclusiveLock'. */
const lockName = (mode: string): string =>
  `${mode
    .toLowerCase()
    .split(' ')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join('')}Lock`;

describe('holdLock — блокировка таблицы на настоящем Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE TABLE locked (id int)');
    await client.query("SET lock_timeout = '300ms'");
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  it.each(Object.values(LOCK_MODE))('режим %s — именно он в pg_locks', async (mode) => {
    await using held = await holdLock(db.url, 'locked', mode);
    const { rows } = await client.query(
      "SELECT mode, granted FROM pg_locks WHERE pid = $1 AND relation = 'locked'::regclass",
      [held.pid],
    );
    expect(rows).toEqual([{ mode: lockName(mode), granted: true }]);
  });

  it('ACCESS EXCLUSIVE — читатель падает по lock_timeout; ACCESS SHARE — читатель проходит, ALTER падает', async () => {
    {
      await using exclusive = await holdLock(db.url, 'locked', LOCK_MODE.accessExclusive);
      expect(exclusive.pid).toBeGreaterThan(0);
      await expect(client.query('SELECT count(*) FROM locked')).rejects.toMatchObject({ code: '55P03' });
    }
    {
      await using shared = await holdLock(db.url, 'locked', LOCK_MODE.accessShare);
      expect(shared.pid).toBeGreaterThan(0);
      expect((await client.query('SELECT count(*)::int AS n FROM locked')).rows).toEqual([{ n: 0 }]);
      await expect(client.query('ALTER TABLE locked ADD COLUMN extra int')).rejects.toMatchObject({
        code: '55P03',
      });
    }
  });

  it('таблица занята другим — держатель падает по своему lockTimeoutMs, а не висит', async () => {
    await using first = await holdLock(db.url, 'locked', LOCK_MODE.accessExclusive);
    expect(first.pid).toBeGreaterThan(0);
    await expect(
      holdLock(db.url, 'locked', LOCK_MODE.accessShare, { lockTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: '55P03' });
  });

  it('неизвестный режим — отказ до подключения', async () => {
    await expect(holdLock(db.url, 'locked', 'TOTAL' as never)).rejects.toThrow(
      'неизвестный режим блокировки',
    );
    await expect(holdLock(db.url, 'locked', LOCK_MODE.share, { lockTimeoutMs: -1 })).rejects.toThrow(
      RangeError,
    );
  });
});
