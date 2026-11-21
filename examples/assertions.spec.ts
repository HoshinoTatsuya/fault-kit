// Asserting a fault without wall clocks: the window is bounded by a witness event or loop turns.
import { Redis } from 'ioredis';
import { expectPendingThrough, expectSameMembers, expectSettlesBefore, turnsDuring } from '@hoshinotatsuya/fault-kit';
import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';

const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const redisPort = Number(redis.port);

it('a GET through a frozen network gets neither a reply nor an error', async () => {
  await using proxy = await FaultProxy.start({ host: redis.hostname, port: redisPort });
  const viaProxy = new Redis(proxy.port, proxy.host);
  const direct = new Redis(redisPort, redis.hostname);
  await viaProxy.ping();

  proxy.freeze();
  const reply = viaProxy.get('k');
  // The window: the same server answered 20 times directly. A slow machine slows both sides.
  const witness = (async () => {
    for (let i = 0; i < 20; i += 1) await direct.ping();
  })();
  await expectPendingThrough(reply, witness);

  proxy.thaw(); // queued bytes go on in their original order
  expect(await reply).toBeNull();
  viaProxy.disconnect();
  direct.disconnect();
});

it('settles before a deadline event or within N loop turns', async () => {
  const work = Promise.reject(new Error('aborted'));
  await expect(expectSettlesBefore(work, { turns: 10 })).rejects.toThrow('aborted');
});

it('concurrent deliveries are compared as multisets', () => {
  expectSameMembers(['job-2', 'job-1', 'job-3'], ['job-1', 'job-2', 'job-3']);
});

it('the work yields the event loop between batches', async () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => i);
  const { turns, longestTurnShare } = await turnsDuring(async () => {
    for (let batch = 0; batch < 10; batch += 1) {
      rows.slice(batch * 1000, (batch + 1) * 1000).reduce((a, b) => a + b, 0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  expect(longestTurnShare).toBeLessThan(0.5);
  expect(turns).toBeGreaterThanOrEqual(10);
});
