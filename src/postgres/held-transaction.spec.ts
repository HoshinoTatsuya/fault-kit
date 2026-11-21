import { Client } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { settledResources } from '../testing/settled-resources';
import { holdLock } from './hold-lock';
import { holdSnapshot } from './hold-snapshot';
import { holdWriter } from './hold-writer';
import { idleInTransaction } from './idle-in-transaction';
import { LOCK_MODE } from './lock-mode.constant';

describe('держатели освобождают всё', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;

  beforeAll(async () => {
    db = await freshDatabase();
    const setup = new Client({ connectionString: db.url });
    await setup.connect();
    await setup.query('CREATE TABLE t (id int)');
    await setup.end();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('после release всех держателей — ни сокетов, ни таймеров процесса, ни соединений на сервере', async () => {
    const baseline = await settledResources();
    const holders = [
      await holdSnapshot(db.url, { applicationName: 'fk-res' }),
      await holdWriter(db.url, 't', { applicationName: 'fk-res' }),
      await holdLock(db.url, 't', LOCK_MODE.accessShare, { applicationName: 'fk-res' }),
      await idleInTransaction(db.url, { applicationName: 'fk-res' }),
    ];
    await Promise.all(holders.map((holder) => holder.release()));
    expect(await settledResources()).toEqual(baseline);
    const check = new Client({ connectionString: db.url });
    await check.connect();
    const { rows } = await check.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'fk-res'",
    );
    await check.end();
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('имя приложения: явное > из настроек соединения > по умолчанию', async () => {
    await using byDefault = await holdSnapshot(db.url);
    await using fromConfig = await holdSnapshot({
      connectionString: db.url,
      application_name: 'from-config',
    });
    await using explicit = await holdSnapshot(
      { connectionString: db.url, application_name: 'from-config' },
      { applicationName: 'explicit' },
    );
    expect([byDefault.applicationName, fromConfig.applicationName, explicit.applicationName]).toEqual([
      'fault-kit:snapshot',
      'from-config',
      'explicit',
    ]);
  });

  it('недоступный сервер — отказ подключения, без висящих ресурсов', async () => {
    const baseline = await settledResources();
    await expect(holdSnapshot('postgres://x:y@127.0.0.1:1/none')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect(await settledResources()).toEqual(baseline);
  });
});
