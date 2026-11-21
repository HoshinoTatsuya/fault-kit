import { Client, Pool } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { BackendTerminationError } from './backend-termination.error';
import { holdSnapshot } from './hold-snapshot';
import { terminateBackends } from './terminate-backends';

describe('terminateBackends на настоящем Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let admin: Client;

  beforeEach(async () => {
    db = await freshDatabase();
    admin = new Client({ connectionString: db.url });
    await admin.connect();
  });

  afterEach(async () => {
    await admin.end();
    await db.drop();
  });

  const named = async (name: string): Promise<{ client: Client; pid: number; errors: Error[] }> => {
    const client = new Client({ connectionString: db.url, application_name: name });
    const errors: Error[] = [];
    client.on('error', (error) => errors.push(error));
    await client.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return { client, pid: rows[0]?.pid ?? -1, errors };
  };

  it('снимает ровно подходящих; соседа и своё соединение не трогает; снятые уже мертвы', async () => {
    // Имя уникально на прогон: соседние файлы спек ходят в тот же сервер.
    const name = `victim-${db.url.split('/').pop()}`;
    const victimA = await named(name);
    const victimB = await named(name);
    const bystander = await named(`bystander-${name}`);
    try {
      const killed = await terminateBackends(admin, { applicationName: name });
      expect(killed).toEqual([victimA.pid, victimB.pid].sort((a, b) => a - b));
      const { rows } = await admin.query('SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])', [
        [victimA.pid, victimB.pid],
      ]);
      expect(rows).toEqual([]);
      await expect(victimA.client.query('SELECT 1')).rejects.toThrow();
      expect((await bystander.client.query('SELECT 7 AS n')).rows).toEqual([{ n: 7 }]);
      expect((await admin.query('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    } finally {
      for (const each of [victimA, victimB, bystander]) {
        await each.client.end().catch(() => undefined);
      }
    }
  });

  it('фильтр по своему pid — своё соединение не снимается', async () => {
    const { rows } = await admin.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(await terminateBackends(admin, { pid: rows[0]?.pid ?? -1 })).toEqual([]);
    expect((await admin.query('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
  });

  it('снятый держатель: whenLost — событие, процесс жив, release разрешается', async () => {
    const holder = await holdSnapshot(db.url, { applicationName: 'held-victim' });
    const lost = holder.whenLost();
    expect(await terminateBackends(admin, { pid: [holder.pid], state: 'idle in transaction' })).toEqual([
      holder.pid,
    ]);
    expect((await lost).message).toMatch(/terminat/i);
    await expect(holder.release()).resolves.toBeUndefined();
  });

  it('пустой фильтр — отказ, а не «снять всех»', async () => {
    // Мимо типов (вызов из JavaScript): тип пустой фильтр не пропускает.
    await expect(terminateBackends(admin, {} as never)).rejects.toThrow('фильтр соединений пуст');
    await expect(terminateBackends(admin, { pid: 1 }, { waitMs: 0 })).rejects.toThrow(RangeError);
  });

  it('без прав — отказ (не видно чужих / сервер запретил), а не пустой список', async () => {
    const role = `fk_${db.url.split('/').pop()}`;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
    const victimName = `superuser-victim-${role}`;
    const victim = await named(victimName);
    const url = new URL(db.url);
    url.username = role;
    url.password = 'x';
    const weak = new Client({ connectionString: url.toString() });
    await weak.connect();
    try {
      await expect(terminateBackends(weak, { applicationName: victimName })).rejects.toMatchObject({
        code: '42501',
      });
      await expect(terminateBackends(weak, { pid: victim.pid, state: 'idle' })).rejects.toThrow(
        'роль не видит состояние',
      );
      expect((await victim.client.query('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    } finally {
      await weak.end();
      await victim.client.end();
      await admin.query(`DROP ROLE ${role}`).catch(() => undefined);
    }
  });

  it('по умолчанию — только текущая база: держатель соседней базы не снят; database / anyDatabase — снят', async () => {
    const other = await freshDatabase();
    try {
      const name = `neighbour-${other.url.split('/').pop()}`;
      const neighbour = await holdSnapshot(other.url, { applicationName: name });
      expect(await terminateBackends(admin, { applicationName: name })).toEqual([]);
      expect(neighbour.lostWith).toBeUndefined();
      await neighbour.release();
      const byName = await holdSnapshot(other.url, { applicationName: name });
      expect(
        await terminateBackends(admin, { applicationName: name, database: other.url.split('/').pop() ?? '' }),
      ).toEqual([byName.pid]);
      await byName.release();
      const anywhere = await holdSnapshot(other.url, { applicationName: name });
      expect(await terminateBackends(admin, { applicationName: name, anyDatabase: true })).toEqual([
        anywhere.pid,
      ]);
      await anywhere.release();
      await expect(
        terminateBackends(admin, { applicationName: name, database: 'x', anyDatabase: true } as never),
      ).rejects.toThrow('database и anyDatabase вместе');
    } finally {
      await other.drop();
    }
  });

  it('через пул: одно соединение на весь вызов — своё соединение пула не снято, вызов не падает 57P01', async () => {
    const name = `pool-${db.url.split('/').pop()}`;
    const pool = new Pool({ connectionString: db.url, application_name: name, max: 2 });
    pool.on('error', () => undefined);
    try {
      const busy = await pool.connect();
      busy.on('error', () => undefined);
      const idle = await pool.connect();
      const busyPid = (await busy.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const idlePid = (await idle.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      idle.release();
      const direct = jest.spyOn(pool, 'query');
      expect(await terminateBackends(pool, { applicationName: name })).toEqual([busyPid]);
      expect(direct).not.toHaveBeenCalled();
      const after = await pool.connect();
      expect((await after.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid).toBe(
        idlePid,
      );
      after.release();
      busy.release(true);
    } finally {
      await pool.end();
    }
  });

  it('отказ сервера посреди списка — BackendTerminationError с уже снятыми (они мертвы), а не потерянный результат', async () => {
    const role = `fkw_${db.url.split('/').pop()}`;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
    const url = new URL(db.url);
    url.username = role;
    url.password = 'x';
    const name = `mixed-${role}`;
    const own = new Client({ connectionString: url.toString(), application_name: name });
    own.on('error', () => undefined);
    await own.connect();
    const ownPid = (await own.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? -1;
    const foreign = await named(name);
    const weak = new Client({ connectionString: url.toString() });
    await weak.connect();
    try {
      expect(ownPid).toBeLessThan(foreign.pid);
      const failure = await terminateBackends(weak, { applicationName: name }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BackendTerminationError);
      expect(failure).toMatchObject({ code: '42501', terminated: [ownPid], failed: [foreign.pid] });
      const { rows } = await admin.query('SELECT pid FROM pg_stat_activity WHERE pid = $1', [ownPid]);
      expect(rows).toEqual([]);
      expect((await foreign.client.query('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    } finally {
      await weak.end();
      await own.end().catch(() => undefined);
      await foreign.client.end();
      await admin.query(`DROP ROLE ${role}`).catch(() => undefined);
    }
  });

  it('pid в фильтре: пустой список, NaN, дробь — отказ до запроса', async () => {
    for (const pid of [[], Number.NaN, 1.5, [0]] as never[]) {
      await expect(terminateBackends(admin, { pid })).rejects.toThrow('pid соединений — непустой список');
    }
  });

  it.each([['130012'], ['140019']])(
    'сервер старше 15 (%s) — отказ с объяснением: поддерживаются Postgres 15–18',
    async (version) => {
      const queries: string[] = [];
      const old = {
        query: async (text: string) => {
          queries.push(text);
          return { rows: [{ v: version }] };
        },
      };
      await expect(terminateBackends(old, { applicationName: 'x' })).rejects.toThrow(
        'требует Postgres 15+ (поддерживаются 15–18)',
      );
      expect(queries).toHaveLength(1);
    },
  );
});
