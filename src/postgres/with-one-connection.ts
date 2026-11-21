import type { PgPool } from './pg-pool.type';
import type { Queryable } from './queryable.type';

/**
 * Выполнить работу на ОДНОМ соединении: у пула — взятом из него на всё время
 * работы, у соединения (`Client`, `PoolClient`) — на нём самом.
 */
export const withOneConnection = async <T>(
  connection: Queryable | PgPool,
  work: (queryable: Queryable) => Promise<T>,
): Promise<T> => {
  if ('totalCount' in connection && typeof connection.connect === 'function') {
    const client = await connection.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  return work(connection as Queryable);
};
