import { shownValue } from '../shown-value';
import { valueText } from '../value-text';
import type { BackendFilter } from './backend-filter.type';
import { BackendTerminationError } from './backend-termination.error';
import type { PgPool } from './pg-pool.type';
import type { Queryable } from './queryable.type';
import { withOneConnection } from './with-one-connection';

/**
 * Оборвать клиентские соединения, подходящие под фильтр, — как рестарт
 * сервера, failover или убийца долгих транзакций. Область по умолчанию —
 * текущая база (см. `BackendFilter`). Соединение, через которое идёт вызов,
 * не трогается никогда: отбор и снятие идут по ОДНОМУ соединению (у пула —
 * взятому из него на весь вызов), и оно исключено из отбора. Прежде отбор и
 * снятие через пул шли разными соединениями, и вызов снимал сам себя (57P01).
 *
 * Возвращает pid снятых соединений по возрастанию. Каждое снято НА САМОМ
 * ДЕЛЕ: `pg_terminate_backend(pid, waitMs)` ждёт выхода процесса (Postgres
 * 14+), поэтому следующий шаг спеки уже не увидит его живым. Снятие — по
 * одному соединению за запрос: отказ сервера на одном (нет прав, 42501) или
 * не вышедшее за `waitMs` — `BackendTerminationError` со списком уже снятых,
 * а не потерянный результат. Пустой фильтр — отказ: «снять всех» должно быть
 * написано явно, условием.
 *
 * Права. Роль без `pg_read_all_stats` видит чужие соединения в
 * `pg_stat_activity` без типа и состояния (`backend_type` и `state` пусты).
 * Отбор по одному «клиентскому» типу молча выбросил бы их, и пустой список
 * читался бы как «снимать было некого». Поэтому скрытые соединения,
 * подходящие под видимые условия, тоже идут на снятие — и сервер отвечает
 * отказом прав (42501), если снимать их роли нельзя; а фильтр по `state`,
 * который у скрытых не проверить, при таких соединениях — отказ с
 * объяснением. Скрытые процессы репликации (walsender, в том числе
 * логический — у него есть роль) клиентскими не считаются: их pid
 * `pg_stat_replication` показывает любой роли, и выборка не зависит от прав
 * вызывающего. Без роли (`usename` пуст) — фоновые процессы сервера.
 *
 * Явный `pid` соединения из другой базы без `database`/`anyDatabase` —
 * отказ, а не пустой список: «не снят, потому что в другой базе» иначе
 * неотличимо от «уже мёртв». Сервер старше 15 — отказ (поддерживаются
 * Postgres 15–18).
 */
export const terminateBackends = async (
  connection: Queryable | PgPool,
  filter: BackendFilter,
  options: { readonly waitMs?: number } = {},
): Promise<readonly number[]> => {
  const conditions = [filter.pid, filter.applicationName, filter.user, filter.database, filter.state];
  if (conditions.every((condition) => condition === undefined)) {
    throw new TypeError('фильтр соединений пуст: задайте pid, applicationName, user, database или state');
  }
  for (const [field, value] of Object.entries({
    applicationName: filter.applicationName,
    user: filter.user,
    database: filter.database,
    state: filter.state,
  })) {
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      // Пустая строка — не условие: applicationName '' совпал бы со всеми соединениями без имени.
      throw new TypeError(`${field} — непустая строка, получено ${shownValue(value)}`);
    }
  }
  if (filter.anyDatabase === true && filter.database !== undefined) {
    throw new TypeError('database и anyDatabase вместе противоречат друг другу');
  }
  const waitMs = options.waitMs ?? 5000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1) {
    throw new RangeError(`waitMs — целое положительное число мс, получено ${valueText(waitMs)}`);
  }
  const pids =
    filter.pid === undefined
      ? null
      : typeof filter.pid === 'number'
        ? [filter.pid]
        : // Не список из JavaScript мимо типов (BigInt, строка) — пустой набор, то есть отказ ниже с текстом, а не «is not iterable».
          typeof filter.pid === 'object' &&
            filter.pid !== null &&
            typeof (filter.pid as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
          ? [...filter.pid]
          : [];
  if (pids !== null && (pids.length === 0 || !pids.every((pid) => Number.isSafeInteger(pid) && pid >= 1))) {
    throw new TypeError(
      `pid соединений — непустой список целых положительных, получено ${shownValue(filter.pid)}`,
    );
  }
  return withOneConnection(connection, async (queryable) => {
    const version = Number(
      (
        (await queryable.query("SELECT pg_catalog.current_setting('server_version_num') AS v")).rows[0] as {
          v: string;
        }
      )?.v,
    );
    if (!(version >= 150_000)) {
      throw new Error(`terminateBackends требует Postgres 15+ (поддерживаются 15–18), сервер ${version}`);
    }
    const candidates = (
      await queryable.query(
        `SELECT pid, backend_type IS NULL AS hidden
           FROM pg_catalog.pg_stat_activity
          WHERE pid <> pg_catalog.pg_backend_pid()
            AND (backend_type = 'client backend'
                 OR (backend_type IS NULL AND usename IS NOT NULL
                     AND pid NOT IN (SELECT pid FROM pg_catalog.pg_stat_replication WHERE pid IS NOT NULL)))
            AND ($1::int[] IS NULL OR pid = ANY($1::int[]))
            AND ($2::text IS NULL OR application_name = $2)
            AND ($3::text IS NULL OR usename = $3)
            AND ($6::boolean OR datname = coalesce($4::text, pg_catalog.current_database()))
            AND ($5::text IS NULL OR state = $5 OR backend_type IS NULL)
          ORDER BY pid`,
        [
          pids,
          filter.applicationName ?? null,
          filter.user ?? null,
          filter.database ?? null,
          filter.state ?? null,
          filter.anyDatabase === true,
        ],
      )
    ).rows as ReadonlyArray<{ pid: number; hidden: boolean }>;
    if (pids !== null && filter.anyDatabase !== true) {
      const found = new Set(candidates.map((row) => row.pid));
      const elsewhere = (
        await queryable.query(
          `SELECT pid, datname FROM pg_catalog.pg_stat_activity
            WHERE pid = ANY($1::int[]) AND datname IS DISTINCT FROM coalesce($2::text, pg_catalog.current_database())
            ORDER BY pid`,
          [pids.filter((pid) => !found.has(pid)), filter.database ?? null],
        )
      ).rows as ReadonlyArray<{ pid: number; datname: string | null }>;
      if (elsewhere.length > 0) {
        throw new TypeError(
          `соединения ${elsewhere.map((row) => `${row.pid} (база ${row.datname ?? 'нет'})`).join(', ')} вне области вызова: ` +
            'задайте database или anyDatabase — иначе «не снят» неотличимо от «уже мёртв»',
        );
      }
    }
    const hidden = candidates.filter((row) => row.hidden).map((row) => row.pid);
    if (filter.state !== undefined && hidden.length > 0) {
      throw new Error(
        `роль не видит состояние соединений ${hidden.join(', ')}: фильтр по state молча пропустил бы их — ` +
          'нужна роль pg_read_all_stats (или фильтр без state)',
      );
    }
    const terminated: number[] = [];
    const survived: number[] = [];
    for (const { pid } of candidates) {
      let done: boolean;
      try {
        const { rows } = await queryable.query(
          'SELECT pg_catalog.pg_terminate_backend($1, $2::bigint) AS done',
          [pid, waitMs],
        );
        done = (rows[0] as { done: boolean } | undefined)?.done === true;
      } catch (error) {
        // Отказ соединения вызывающего — любое значение (null, без прототипа): текст не бросает.
        const raw = (error as { code?: unknown } | null | undefined)?.code;
        const code = typeof raw === 'string' ? raw : undefined;
        throw new BackendTerminationError(
          `сервер отказал в снятии соединения ${pid} (${code ?? 'без кода'}): ${error instanceof Error ? error.message : valueText(error)}; уже сняты: [${terminated.join(', ')}]`,
          Object.freeze([...terminated]),
          Object.freeze([pid]),
          code,
          { cause: error },
        );
      }
      if (done) {
        terminated.push(pid);
        continue;
      }
      // Не снят: вышел сам между отбором и снятием (тогда просто не в списке) или не уложился в waitMs.
      const { rows } = await queryable.query(
        'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1) AS alive',
        [pid],
      );
      if ((rows[0] as { alive: boolean } | undefined)?.alive === true) {
        survived.push(pid);
      }
    }
    if (survived.length > 0) {
      throw new BackendTerminationError(
        `соединения не завершились за ${waitMs} мс: ${survived.join(', ')}; сняты: [${terminated.join(', ')}]`,
        Object.freeze([...terminated]),
        Object.freeze(survived),
        undefined,
      );
    }
    return Object.freeze(terminated);
  });
};
