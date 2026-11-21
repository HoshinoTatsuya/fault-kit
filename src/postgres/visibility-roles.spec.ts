import { randomBytes } from 'node:crypto';

import { Client, type ClientConfig } from 'pg';

import { freshDatabase } from '../testing/fresh-database';
import { pgTarget } from '../testing/pg-target';
import { holdSnapshot } from './hold-snapshot';
import { horizonAge } from './horizon-age';
import { terminateBackends } from './terminate-backends';

/**
 * Под РОЛЬЮ ПРИЛОЖЕНИЯ, без `pg_read_all_stats`: чужие соединения такая роль
 * видит в `pg_stat_activity` без типа и состояния, но с `backend_xmin`.
 * Суперпользователь (адрес спек) этого не показывает — он видит всё.
 *
 * - `horizonAge`: держатель снимка чужой роли — держатель (`hidden: true`), а
 *   не «горизонт свободен»;
 * - `terminateBackends`: логический walsender клиентским соединением не
 *   считается ни у суперпользователя, ни у роли с `pg_signal_backend` —
 *   выборка не зависит от прав вызывающего;
 * - явный pid из другой базы — отказ, а не «уже мёртв».
 */
describe('видимость под ролями без pg_read_all_stats', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let admin: Client;
  const suffix = randomBytes(4).toString('hex');
  const roles = {
    holder: `fkh_${suffix}`,
    app: `fka_${suffix}`,
    signal: `fks_${suffix}`,
    repl: `fkr_${suffix}`,
  };
  const clients: Client[] = [];

  const as = (role: string, extra: Partial<ClientConfig> = {}): ClientConfig => {
    const url = new URL(db.url);
    url.username = role;
    url.password = 'x';
    return { connectionString: url.toString(), ...extra };
  };
  const connect = async (config: ClientConfig): Promise<Client> => {
    const client = new Client(config);
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    return client;
  };
  const pidOf = async (client: Client): Promise<number> =>
    (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? -1;

  beforeAll(async () => {
    db = await freshDatabase();
    admin = new Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(`CREATE ROLE ${roles.holder} LOGIN PASSWORD 'x'`);
    await admin.query(`CREATE ROLE ${roles.app} LOGIN PASSWORD 'x'`);
    await admin.query(`CREATE ROLE ${roles.signal} LOGIN PASSWORD 'x' IN ROLE pg_signal_backend`);
    await admin.query(`CREATE ROLE ${roles.repl} LOGIN REPLICATION PASSWORD 'x'`);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.end().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await admin.end();
    await db.drop();
    const cleaner = new Client({ connectionString: pgTarget().url });
    await cleaner.connect();
    try {
      for (const role of Object.values(roles)) {
        await cleaner.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await cleaner.end();
    }
  });

  it('роль вызова действительно не видит тип чужого соединения (предпосылка проверок)', async () => {
    const other = await connect(as(roles.holder));
    const app = await connect(as(roles.app));
    const { rows } = await app.query(
      'SELECT backend_type, state FROM pg_catalog.pg_stat_activity WHERE pid = $1',
      [await pidOf(other)],
    );
    expect(rows).toEqual([{ backend_type: null, state: null }]);
  });

  it('horizonAge: держатель снимка чужой роли виден роли приложения — hidden, а не «свободно»; после release — свободно', async () => {
    const app = await connect(as(roles.app));
    const held = await holdSnapshot(as(roles.holder), { applicationName: `holder-${suffix}` });
    try {
      const byApp = await horizonAge(app);
      expect(byApp.holders.map((holder) => ({ ...holder, age: typeof holder.age }))).toEqual([
        {
          kind: 'backend',
          id: String(held.pid),
          age: 'number',
          applicationName: `holder-${suffix}`,
          state: null,
          backendType: null,
          hidden: true,
        },
      ]);
      const bySuperuser = await horizonAge(admin);
      expect(bySuperuser.holders.map(({ id, backendType, hidden }) => ({ id, backendType, hidden }))).toEqual(
        [{ id: String(held.pid), backendType: 'client backend', hidden: false }],
      );
    } finally {
      await held.release();
    }
    expect(await horizonAge(app)).toEqual({ age: 0, holders: [] });
  });

  it('horizonAge: держатель своей же роли — не hidden (двойник)', async () => {
    const app = await connect(as(roles.app));
    const held = await holdSnapshot(as(roles.app));
    try {
      expect(
        (await horizonAge(app)).holders.map(({ id, backendType, hidden }) => ({ id, backendType, hidden })),
      ).toEqual([{ id: String(held.pid), backendType: 'client backend', hidden: false }]);
    } finally {
      await held.release();
    }
  });

  it('terminateBackends: логический walsender не клиентское соединение — одинаково у суперпользователя и у роли без pg_read_all_stats', async () => {
    const round = async (
      caller: Client,
    ): Promise<{ hiddenSeen: number; terminatedIsClient: boolean; walsenderAlive: boolean }> => {
      const walsender = await connect(as(roles.repl, { replication: 'database' } as Partial<ClientConfig>));
      const client = await connect(as(roles.repl, { application_name: `client-${suffix}` }));
      const clientPid = await pidOf(client);
      const walsenderPid = (
        await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND backend_type = 'walsender'",
          [roles.repl],
        )
      ).rows[0]?.pid;
      const hidden = await caller.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND backend_type IS NULL',
        [roles.repl],
      );
      const terminated = await terminateBackends(caller, { user: roles.repl });
      const { rows } = await admin.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1', [
        walsenderPid,
      ]);
      await walsender.end().catch(() => undefined);
      return {
        hiddenSeen: hidden.rows[0]?.n ?? -1,
        terminatedIsClient: terminated.length === 1 && terminated[0] === clientPid,
        walsenderAlive: walsenderPid !== undefined && rows.length === 1,
      };
    };
    expect(await round(admin)).toEqual({ hiddenSeen: 0, terminatedIsClient: true, walsenderAlive: true });
    // Роль с pg_signal_backend не видит типов обоих соединений (предпосылка) — и снимает то же самое.
    expect(await round(await connect(as(roles.signal)))).toEqual({
      hiddenSeen: 2,
      terminatedIsClient: true,
      walsenderAlive: true,
    });
  });

  it('terminateBackends: явный pid соединения другой базы без database/anyDatabase — отказ, а не пустой список', async () => {
    const other = await freshDatabase();
    try {
      const neighbour = await connect({ connectionString: other.url });
      const pid = await pidOf(neighbour);
      await expect(terminateBackends(admin, { pid })).rejects.toThrow('вне области вызова');
      expect(await terminateBackends(admin, { pid, anyDatabase: true })).toEqual([pid]);
      // Мёртвый pid — просто не в списке: отличать есть от чего.
      expect(await terminateBackends(admin, { pid })).toEqual([]);
    } finally {
      await other.drop();
    }
  });

  it.each([
    ['applicationName', { applicationName: '' }],
    ['user', { user: '' }],
    ['database', { database: '' }],
    ['state', { state: '' }],
  ])(
    'terminateBackends: пустая строка в %s — отказ без запросов (node-pg по умолчанию шлёт пустое имя)',
    async (field, filter) => {
      const queries: unknown[] = [];
      const spy = { query: async (text: string) => queries.push(text) as never };
      await expect(terminateBackends(spy as never, filter)).rejects.toThrow(`${field} — непустая строка`);
      expect(queries).toEqual([]);
    },
  );
});
