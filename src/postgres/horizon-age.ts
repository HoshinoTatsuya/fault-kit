import type { HorizonHolder } from './horizon-holder.type';
import type { HorizonReport } from './horizon-report.type';
import type { Queryable } from './queryable.type';

/**
 * Насколько отстал горизонт VACUUM текущей базы и кто его держит: КЛИЕНТСКИЕ
 * соединения этой базы со снимком или номером транзакции, подготовленные
 * транзакции, слоты репликации. Соединение самого запроса не считается (у
 * него снимок этого же запроса). Для утверждений «держатель действительно
 * держит» и «после release горизонт свободен» — без замера распухания.
 *
 * Фоновые процессы сервера (autovacuum, параллельные воркеры, walsender)
 * горизонт тоже держат, но сами по себе и в случайный момент: утверждение
 * `{ age: 0, holders: [] }` флакало бы на каждом проходе autovacuum. Поэтому
 * по умолчанию они не считаются; `includeBackground: true` — считать и их
 * (`backendType` у держателя покажет, кто это).
 *
 * Роль без `pg_read_all_stats` видит чужие соединения без типа и состояния
 * (`backend_type`, `state` пусты), но `backend_xmin` видит. Такие соединения
 * с ролью считаются держателями с `hidden: true`: отбросить их значило бы
 * сказать «горизонт свободен», когда его держит соединение чужой роли.
 * Скрытые процессы репликации (pid из `pg_stat_replication`) и процессы без
 * роли — фоновые, как и видимые. Скрытый держатель может оказаться и
 * параллельным воркером чужой роли: точный тип — под ролью с
 * `pg_read_all_stats`.
 */
export const horizonAge = async (
  queryable: Queryable,
  options: { readonly includeBackground?: boolean } = {},
): Promise<HorizonReport> => {
  const { rows } = await queryable.query(
    `SELECT kind, id, age, application_name AS "applicationName", state, backend_type AS "backendType", hidden FROM (
       SELECT 'backend' AS kind, pid::text AS id,
              greatest(pg_catalog.age(backend_xmin), pg_catalog.age(backend_xid))::int AS age, application_name, state, backend_type,
              backend_type IS NULL AS hidden
         FROM pg_catalog.pg_stat_activity
        WHERE pid <> pg_catalog.pg_backend_pid()
          AND (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL)
          AND (datname = pg_catalog.current_database() OR datname IS NULL)
          AND ($1::boolean OR backend_type = 'client backend'
               OR (backend_type IS NULL AND usename IS NOT NULL
                   AND pid NOT IN (SELECT pid FROM pg_catalog.pg_stat_replication WHERE pid IS NOT NULL)))
       UNION ALL
       SELECT 'prepared', gid, pg_catalog.age(transaction)::int, NULL, NULL, NULL, false
         FROM pg_catalog.pg_prepared_xacts WHERE database = pg_catalog.current_database()
       UNION ALL
       SELECT 'slot', slot_name::text, greatest(pg_catalog.age(xmin), pg_catalog.age(catalog_xmin))::int, NULL, NULL, NULL, false
         FROM pg_catalog.pg_replication_slots
        WHERE (xmin IS NOT NULL OR catalog_xmin IS NOT NULL)
          AND (database IS NULL OR database = pg_catalog.current_database())
     ) holders
     ORDER BY age DESC, kind, id`,
    [options.includeBackground === true],
  );
  const holders = Object.freeze((rows as HorizonHolder[]).map((row) => Object.freeze({ ...row })));
  return Object.freeze({ age: holders[0]?.age ?? 0, holders });
};
