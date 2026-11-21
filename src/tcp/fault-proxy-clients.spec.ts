import { Redis } from 'ioredis';
import { Client } from 'pg';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { pgTarget } from '../testing/pg-target';
import { redisTarget } from '../testing/redis-target';
import { roundTrips } from '../testing/round-trips';
import { FaultProxy } from './fault-proxy';

/**
 * Доказательство заморозки на настоящих клиентах: ioredis и pg за замёрзшим
 * прокси не получают ни ответа, ни ошибки (ни события `error`, ни `close`),
 * пока тот же сервер напрямую отвечает двадцать раз. После оттаивания
 * команда завершается своим настоящим результатом.
 */
describe('FaultProxy: настоящие клиенты за замёрзшим прокси', () => {
  it('ioredis: GET без ответа и без ошибки; thaw — значение', async () => {
    const target = redisTarget();
    await using proxy = await FaultProxy.start(target);
    const direct = new Redis(target.port, target.host);
    const behind = new Redis(proxy.port, proxy.host);
    const events: string[] = [];
    for (const name of ['error', 'close', 'reconnecting', 'end']) {
      behind.on(name, () => events.push(name));
    }
    try {
      await direct.set('fault-kit:frozen', 'value');
      expect(await behind.get('fault-kit:frozen')).toBe('value');
      proxy.freeze();
      const pending = behind.get('fault-kit:frozen');
      await expectPendingThrough(
        pending,
        roundTrips(20, () => direct.ping()),
        'GET за замёрзшим прокси',
      );
      expect(events).toEqual([]);
      proxy.thaw();
      expect(await pending).toBe('value');
      expect(events).toEqual([]);
    } finally {
      behind.disconnect();
      direct.disconnect();
    }
  });

  it('ioredis: drop — клиент видит обрыв и переподключается', async () => {
    const target = redisTarget();
    await using proxy = await FaultProxy.start(target);
    const behind = new Redis(proxy.port, proxy.host);
    try {
      await behind.ping();
      const reconnecting = new Promise((resolve) => behind.once('reconnecting', resolve));
      expect(proxy.drop()).toBe(1);
      await reconnecting;
      expect(await behind.ping()).toBe('PONG');
      expect(proxy.stats().accepted).toBe(2);
    } finally {
      behind.disconnect();
    }
  });

  it('pg: SELECT без ответа и без ошибки; thaw — результат', async () => {
    const target = pgTarget();
    await using proxy = await FaultProxy.start(target);
    const direct = new Client({ connectionString: target.url });
    const url = new URL(target.url);
    url.hostname = proxy.host;
    url.port = String(proxy.port);
    const behind = new Client({ connectionString: url.toString() });
    const events: string[] = [];
    behind.on('error', () => events.push('error'));
    behind.on('end', () => events.push('end'));
    await direct.connect();
    await behind.connect();
    try {
      proxy.freeze();
      const pending = behind.query<{ answer: number }>('SELECT 42 AS answer');
      await expectPendingThrough(
        pending,
        roundTrips(20, () => direct.query('SELECT 1')),
        'SELECT за замёрзшим прокси',
      );
      expect(events).toEqual([]);
      proxy.thaw();
      expect((await pending).rows).toEqual([{ answer: 42 }]);
    } finally {
      await behind.end().catch(() => undefined);
      await direct.end();
    }
  });

  it('pg: drop посреди запроса — запрос отклонён, а не завис', async () => {
    const target = pgTarget();
    await using proxy = await FaultProxy.start(target);
    const url = new URL(target.url);
    url.hostname = proxy.host;
    url.port = String(proxy.port);
    const behind = new Client({ connectionString: url.toString() });
    behind.on('error', () => undefined);
    await behind.connect();
    proxy.freeze();
    const pending = behind.query('SELECT 1');
    proxy.drop();
    await expect(pending).rejects.toThrow();
    await behind.end().catch(() => undefined);
  });
});
