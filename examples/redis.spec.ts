// Redis pause and client kills on a dedicated admin connection, and a slow path through a latency proxy.
import { Redis } from 'ioredis';
import { REDIS_PAUSE_MODE, RedisFaults, slowRedis } from '@hoshinotatsuya/fault-kit/redis';

const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const port = Number(redis.port);

it('pause, kill, slow path', async () => {
  const admin = new Redis(port, redis.hostname);
  const faults = new RedisFaults(admin);
  {
    await using pause = await faults.pause(60_000, REDIS_PAUSE_MODE.write); // writes wait, reads go on
    expect(pause).toBeDefined();
  } // `await using` lifts a WRITE pause at once (an ALL pause cannot be lifted early)
  const worker = new Redis(port, redis.hostname, { connectionName: 'worker' });
  await worker.ping();
  expect(await faults.killClients({ name: 'worker' })).toHaveLength(1); // the admin connection is never killed

  await using slow = await slowRedis({ host: redis.hostname, port, latencyMs: 200 });
  const client = new Redis(slow.port, slow.host);
  await client.ping();
  client.disconnect();
  worker.disconnect();
  admin.disconnect();
});
