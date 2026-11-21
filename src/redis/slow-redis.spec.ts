import { Redis } from 'ioredis';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { redisTarget } from '../testing/redis-target';
import { roundTrips } from '../testing/round-trips';
import { slowRedis } from './slow-redis';

describe('slowRedis на настоящем Redis', () => {
  it('ответ задержан, пока сервер напрямую ответил 20 раз; снятие задержки — верный ответ', async () => {
    const target = redisTarget();
    const direct = new Redis(target.port, target.host);
    await using proxy = await slowRedis({ ...target, latencyMs: 0 });
    const slow = new Redis(proxy.port, proxy.host);
    try {
      await direct.set('fault-kit:slow', 'v');
      await slow.ping();
      proxy.latency(60_000);
      const read = slow.get('fault-kit:slow');
      await expectPendingThrough(
        read,
        roundTrips(20, () => direct.ping()),
        'GET через медленный путь',
      );
      proxy.latency(0);
      expect(await read).toBe('v');
    } finally {
      slow.disconnect();
      direct.disconnect();
    }
  });

  it('под задержкой 200 конвейерных INCR возвращают 1..200 по порядку', async () => {
    const target = redisTarget();
    await using proxy = await slowRedis({ ...target, latencyMs: 3 });
    const slow = new Redis(proxy.port, proxy.host);
    try {
      const key = `fault-kit:incr:${process.pid}`;
      await slow.del(key);
      const pipeline = slow.pipeline();
      for (let index = 0; index < 200; index += 1) {
        pipeline.incr(key);
      }
      const results =
        (await pipeline.exec())?.map(([error, value]) => (error === null ? value : error)) ?? [];
      expect(results).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    } finally {
      slow.disconnect();
    }
  });

  it('отрицательная задержка — отказ, прокси закрыт', async () => {
    await expect(slowRedis({ ...redisTarget(), latencyMs: -5 })).rejects.toThrow(RangeError);
  });
});
