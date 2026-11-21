// Holders keep a transaction open on THEIR OWN connection until release(); release() waits for the ROLLBACK.
import { Pool } from 'pg';
import {
  holdLock,
  holdSnapshot,
  holdWriter,
  horizonAge,
  idleInTransaction,
  LOCK_MODE,
  terminateBackends,
} from '@hoshinotatsuya/fault-kit/postgres';

const url = process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:5432/postgres';

it('holders, horizon and backend termination', async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query('CREATE TABLE IF NOT EXISTS events (id int); CREATE TABLE IF NOT EXISTS jobs (id int)');

  await using snapshot = await holdSnapshot(url); // REPEATABLE READ: VACUUM keeps rows that died after it
  await using writer = await holdWriter(url, 'events'); // ROW EXCLUSIVE + an xid: CREATE INDEX CONCURRENTLY waits
  await using lock = await holdLock(url, { schema: 'public', name: 'jobs' }, LOCK_MODE.accessExclusive, {
    lockTimeoutMs: 2000,
  });
  await using idle = await idleInTransaction(url, { applicationName: 'idle-worker' }); // does NOT hold the horizon

  const report = await horizonAge(pool);
  expect(report.holders.map((holder) => holder.id)).toContain(String(snapshot.pid));
  expect(writer.xid).toBeDefined();
  expect(lock.pid).toBeGreaterThan(0);

  // Terminates matching backends of the CURRENT database, never the caller's own connection.
  expect(await terminateBackends(pool, { applicationName: 'idle-worker' })).toEqual([idle.pid]);
  await expect(idle.whenLost()).resolves.toBeInstanceOf(Error);
  await pool.end();
});
