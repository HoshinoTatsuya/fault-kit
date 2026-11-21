/** То, через что выполнить запрос: `pg.Client`, `pg.Pool`, `PoolClient`. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
