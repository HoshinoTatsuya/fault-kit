import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { horizonAge } from './horizon-age';
import { idleInTransaction } from './idle-in-transaction';

describe('idleInTransaction на настоящем Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: Client;

  beforeEach(async () => {
    db = await freshDatabase();
    client = new Client({ connectionString: db.url });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
    await db.drop();
  });

  it('состояние idle in transaction, транзакция открыта, снимка нет — горизонт НЕ держит', async () => {
    await using idle = await idleInTransaction(db.url);
    const { rows } = await client.query(
      'SELECT state, xact_start IS NOT NULL AS open, backend_xmin IS NULL AS no_snapshot FROM pg_stat_activity WHERE pid = $1',
      [idle.pid],
    );
    expect(rows).toEqual([{ state: 'idle in transaction', open: true, no_snapshot: true }]);
    expect((await horizonAge(client)).holders.map((h) => h.id)).not.toContain(String(idle.pid));
  });

  it('idle_in_transaction_session_timeout сервера обрывает его: whenLost — событие, release не падает', async () => {
    const idle = await idleInTransaction({
      connectionString: db.url,
      options: '-c idle_in_transaction_session_timeout=200',
    });
    const lost = await idle.whenLost();
    expect(lost.message).toMatch(/idle-in-transaction timeout|terminat/i);
    expect(idle.lostWith).toBe(lost);
    await expect(idle.release()).resolves.toBeUndefined();
  });
});
