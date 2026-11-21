import { Client } from 'pg';

import { DROP_MODE } from '../tcp/drop-mode.constant';
import { FaultProxy } from '../tcp/fault-proxy';
import { freshDatabase } from '../testing/fresh-database';
import { settledResources } from '../testing/settled-resources';
import { holdLock } from './hold-lock';
import { holdSnapshot } from './hold-snapshot';
import { holdWriter } from './hold-writer';
import { idleInTransaction } from './idle-in-transaction';
import { LOCK_MODE } from './lock-mode.constant';
import { terminateBackends } from './terminate-backends';

describe('держатели: имя, изоляция, потолки, область блокировки', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let admin: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    admin = new Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(
      'CREATE TABLE parted (id int) PARTITION BY RANGE (id); ' +
        'CREATE TABLE parted_1 PARTITION OF parted FOR VALUES FROM (0) TO (10); ' +
        'CREATE TABLE parted_2 PARTITION OF parted FOR VALUES FROM (10) TO (20)',
    );
  });

  afterAll(async () => {
    await admin.end();
    await db.drop();
  });

  const serverName = async (pid: number): Promise<string | undefined> =>
    (
      await admin.query<{ name: string }>(
        'SELECT application_name AS name FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
    ).rows[0]?.name;

  const withParam = (name: string): string => {
    const url = new URL(db.url);
    url.searchParams.set('application_name', name);
    return url.toString();
  };

  it('application_name из строки подключения: держатель сообщает то, что видит сервер, и снимается по нему', async () => {
    const held = await holdSnapshot(withParam('from-url'));
    try {
      expect({ reported: held.applicationName, server: await serverName(held.pid) }).toEqual({
        reported: 'from-url',
        server: 'from-url',
      });
      expect(await terminateBackends(admin, { applicationName: held.applicationName })).toEqual([held.pid]);
    } finally {
      await held.release();
    }
  });

  it('явное имя побеждает строку подключения — и на сервере тоже', async () => {
    await using held = await holdSnapshot(withParam('from-url'), { applicationName: 'explicit' });
    expect({ reported: held.applicationName, server: await serverName(held.pid) }).toEqual({
      reported: 'explicit',
      server: 'explicit',
    });
  });

  it('ClientConfig с application_name и строкой с другим именем — сообщается то, что выбрал сервер', async () => {
    await using held = await holdSnapshot({
      connectionString: withParam('from-url'),
      application_name: 'cfg',
    });
    expect(held.applicationName).toBe(await serverName(held.pid));
  });

  it('pid и имя читаются ВНУТРИ транзакции держателя, последним запросом', async () => {
    await using held = await holdLock(db.url, 'parted', LOCK_MODE.accessShare);
    const { rows } = await admin.query<{ query: string; open: boolean }>(
      'SELECT query, xact_start IS NOT NULL AS open FROM pg_stat_activity WHERE pid = $1',
      [held.pid],
    );
    expect(rows).toEqual([
      {
        query:
          "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_setting('application_name') AS name, pg_catalog.pg_current_xact_id_if_assigned()::text AS xid",
        open: true,
      },
    ]);
  });

  it.each(['repeatable read', 'serializable'])(
    'idleInTransaction и holdLock при default_transaction_isolation=%s горизонт не держат',
    async (isolation) => {
      const connection = {
        connectionString: db.url,
        options: `-c default_transaction_isolation=${isolation.replace(' ', '\\ ')}`,
      };
      await using idle = await idleInTransaction(connection);
      await using lock = await holdLock(connection, 'parted', LOCK_MODE.accessShare);
      const { rows } = await admin.query(
        'SELECT pid, backend_xmin IS NULL AS no_snapshot FROM pg_stat_activity WHERE pid = ANY($1::int[]) ORDER BY pid',
        [[idle.pid, lock.pid]],
      );
      expect(rows).toEqual(
        [idle.pid, lock.pid].sort((a, b) => a - b).map((pid) => ({ pid, no_snapshot: true })),
      );
    },
  );

  it('holdLock по секционированной таблице блокирует и секции; only — только саму таблицу', async () => {
    const locked = async (only: boolean): Promise<string[]> => {
      await using held = await holdLock(db.url, 'parted', LOCK_MODE.share, { only });
      const { rows } = await admin.query<{ rel: string }>(
        "SELECT relation::regclass::text AS rel FROM pg_locks WHERE pid = $1 AND locktype = 'relation' AND relation::regclass::text LIKE 'parted%' ORDER BY 1",
        [held.pid],
      );
      return rows.map((row) => row.rel);
    };
    expect(await locked(false)).toEqual(['parted', 'parted_1', 'parted_2']);
    expect(await locked(true)).toEqual(['parted']);
    await using writer = await holdWriter(db.url, 'parted', { only: true });
    const { rows } = await admin.query(
      "SELECT relation::regclass::text AS rel FROM pg_locks WHERE pid = $1 AND locktype = 'relation' AND relation::regclass::text LIKE 'parted%'",
      [writer.pid],
    );
    expect(rows).toEqual([{ rel: 'parted' }]);
  });

  it('настройки блокировки у держателей без блокировки — отказ, а не молчаливое игнорирование', async () => {
    await expect(holdSnapshot(db.url, { lockTimeoutMs: 100 } as never)).rejects.toThrow(
      'lockTimeoutMs не действует на holdSnapshot',
    );
    await expect(idleInTransaction(db.url, { only: true } as never)).rejects.toThrow(
      'only не действует на idleInTransaction',
    );
  });

  it('потолки: timeoutMs — целое положительное; lockTimeoutMs обязан быть меньше timeoutMs', async () => {
    await expect(holdSnapshot(db.url, { timeoutMs: 0 })).rejects.toThrow('timeoutMs — целое от 1 до');
    await expect(
      holdLock(db.url, 'parted', LOCK_MODE.share, { lockTimeoutMs: 500, timeoutMs: 500 }),
    ).rejects.toThrow('lockTimeoutMs (500) не меньше timeoutMs (500)');
    await using unlimitedLock = await holdLock(db.url, 'parted', LOCK_MODE.share, {
      lockTimeoutMs: 0,
      timeoutMs: 500,
    });
    expect(unlimitedLock.pid).toBeGreaterThan(0);
  });

  it('timeoutMs больше потолка таймера Node (2³¹−1) — отказ до подключения, а не «не открылся» через 1 мс', async () => {
    for (const open of [
      () => holdSnapshot(db.url, { timeoutMs: 2 ** 31 }),
      () => idleInTransaction(db.url, { timeoutMs: 2 ** 31 }),
      () => holdLock(db.url, 'parted', LOCK_MODE.share, { timeoutMs: 2 ** 31 }),
      () => holdWriter(db.url, 'parted', { timeoutMs: 2 ** 31 }),
    ]) {
      await expect(open()).rejects.toThrow('timeoutMs — целое от 1 до 2147483647 мс');
    }
    await using longest = await holdSnapshot(db.url, { timeoutMs: 2 ** 31 - 1 });
    expect(longest.pid).toBeGreaterThan(0);
  });

  it('timeoutMs меньше 5000 без lockTimeoutMs: умолчание блокировки выводится из него, а не RangeError', async () => {
    await admin.query(
      'CREATE TABLE IF NOT EXISTS cfg_a (id int); CREATE TABLE IF NOT EXISTS cfg_b (id int); CREATE TABLE IF NOT EXISTS cfg_c (id int)',
    );
    await using lock = await holdLock(db.url, 'cfg_a', LOCK_MODE.share, { timeoutMs: 3000 });
    await using writer = await holdWriter(db.url, 'cfg_b', { timeoutMs: 5000 });
    expect([lock.pid, writer.pid].every((pid) => pid > 0)).toBe(true);
    // Умолчание — половина потолка: чужую блокировку держатель ждёт 1500 мс и отказывает по lock_timeout (55P03),
    // а не по своему потолку 3000 мс.
    await using exclusive = await holdLock(db.url, 'cfg_c', LOCK_MODE.accessExclusive);
    const baseline = await settledResources();
    await expect(holdLock(db.url, 'cfg_c', LOCK_MODE.share, { timeoutMs: 3000 })).rejects.toMatchObject({
      code: '55P03',
    });
    // Отказ сервера при открытии: соединение держателя закрыто, его потолок снят — ресурсы как до вызова.
    expect(await settledResources()).toEqual(baseline);
    expect(exclusive.pid).toBeGreaterThan(0);
  });

  it('открытие через поглощающий прокси: отказ по timeoutMs, без висящих ресурсов', async () => {
    const target = new URL(db.url);
    const baseline = await settledResources();
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port || 5432) });
    proxy.blackholeNew();
    const url = new URL(db.url);
    url.hostname = proxy.host;
    url.port = String(proxy.port);
    await expect(holdSnapshot(url.toString(), { timeoutMs: 300 })).rejects.toThrow(
      'держатель не открылся за 300 мс',
    );
    await proxy.close();
    expect(await settledResources()).toEqual(baseline);
  });

  /**
   * Потолок открытия — один на весь отказ: после него закрытие разорванного
   * соединения не должно ждать ещё одного такого же потолка (`client.end()`
   * на уничтоженном сокете не дождался бы 'end'). Срок сверяется гонкой с
   * таймером в полтора потолка, а не часами.
   */
  it('открытие через поглощающий прокси: отказ раньше полутора потолков, а не через два', async () => {
    const target = new URL(db.url);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port || 5432) });
    proxy.blackholeNew();
    const url = new URL(db.url);
    url.hostname = proxy.host;
    url.port = String(proxy.port);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        holdSnapshot(url.toString(), { timeoutMs: 600 }).then(
          () => 'открылся',
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('дольше полутора потолков'), 900);
        }),
      ]);
      expect(outcome).toBe('держатель не открылся за 600 мс');
    } finally {
      clearTimeout(timer);
      await proxy.close();
    }
  });

  it('release через замёрзший прокси: отказ по timeoutMs (откат не подтверждён), соединение разорвано', async () => {
    const target = new URL(db.url);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port || 5432) });
    try {
      const url = new URL(db.url);
      url.hostname = proxy.host;
      url.port = String(proxy.port);
      const held = await holdSnapshot(url.toString(), { timeoutMs: 300 });
      proxy.freeze();
      await expect(held.release()).rejects.toThrow(`откат держателя ${held.pid} не подтверждён за 300 мс`);
      // Разрыв по своему потолку — ошибка pg во время release(), но не обрыв сервером.
      await expect(held.whenLost()).rejects.toThrow('освобождён: обрыва не было');
      expect(held.lostWith).toBeUndefined();
      proxy.thaw();
    } finally {
      await proxy.close();
    }
  });

  const viaProxy = async (): Promise<{ proxy: FaultProxy; url: string }> => {
    const target = new URL(db.url);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port || 5432) });
    const url = new URL(db.url);
    url.hostname = proxy.host;
    url.port = String(proxy.port);
    return { proxy, url: url.toString() };
  };

  it('whenLost: закрытие соединения без ошибки сервера (FIN балансировщика) — тоже обрыв', async () => {
    const { proxy, url } = await viaProxy();
    try {
      const held = await holdSnapshot(url);
      const lost = held.whenLost();
      proxy.drop(DROP_MODE.close);
      expect((await lost).message).toBe('Connection terminated unexpectedly');
      expect(held.lostWith).toBe(await lost);
      await held.release();
    } finally {
      await proxy.close();
    }
  });

  it('whenLost после release без обрыва — отказ, а не вечное ожидание; ошибки своего закрытия — не обрыв', async () => {
    const held = await holdSnapshot(db.url);
    const lost = held.whenLost();
    await held.release();
    await expect(lost).rejects.toThrow(`держатель ${held.pid} освобождён: обрыва не было`);
    expect(held.lostWith).toBeUndefined();
  });

  it('holdWriter отдаёт выданный номер транзакции; держатель без записи — undefined', async () => {
    await using writer = await holdWriter(db.url, 'parted', { only: true });
    await using snapshot = await holdSnapshot(db.url);
    const { rows } = await admin.query<{ xid: string }>(
      'SELECT backend_xid::text AS xid FROM pg_stat_activity WHERE pid = $1',
      [writer.pid],
    );
    expect({ writer: writer.xid, snapshot: snapshot.xid }).toEqual({
      writer: rows[0]?.xid,
      snapshot: undefined,
    });
    expect(writer.xid).toMatch(/^\d+$/);
  });

  it('имя таблицы длиннее 63 байт и only не булево — отказ до подключения; настройки null — отказ', async () => {
    await expect(holdLock(db.url, 'т'.repeat(32), LOCK_MODE.share)).rejects.toThrow('длиннее 63 байт (64)');
    await expect(holdLock(db.url, 'parted', LOCK_MODE.share, { only: 'yes' as never })).rejects.toThrow(
      'only — true или false',
    );
    await expect(holdSnapshot(db.url, null as never)).rejects.toThrow('настройки holdSnapshot — объект');
    await using unset = await holdSnapshot(db.url, { lockTimeoutMs: undefined } as never);
    expect(unset.pid).toBeGreaterThan(0);
  });

  it('freshDatabase: await using удаляет базу', async () => {
    let name = '';
    {
      await using scratch = await freshDatabase();
      name = new URL(scratch.url).pathname.slice(1);
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toHaveLength(
        1,
      );
    }
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
  });
});
