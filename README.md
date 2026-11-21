# @hoshinotatsuya/fault-kit

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/fault-kit.svg)](https://www.npmjs.com/package/@hoshinotatsuya/fault-kit)
[![CI](https://github.com/HoshinoTatsuya/fault-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/fault-kit/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

Fault-injection primitives for specs — for the class of defects that "work until the network
freezes". A unit test with a mock does not see them, and neither does code review. They show up
only under a real fault: the socket is open but no bytes flow; DNS does not answer; a transaction
holds the vacuum horizon; the shell died and its child lives on.

It is a dev dependency. Every primitive releases what it took (`close()`/`release()`,
`Symbol.asyncDispose` for `await using`); the specs check that the process's open resources are
the same before and after.

| Entry | What is inside | Needs |
|---|---|---|
| `@hoshinotatsuya/fault-kit` | assertions without wall clocks: deadline and window, multisets, event-loop turns (`turnsDuring`) | — |
| `@hoshinotatsuya/fault-kit/tcp` | `FaultProxy`: `freeze`/`thaw`, `drop`, `latency`, `blackholeNew`, counters | — |
| `@hoshinotatsuya/fault-kit/dns` | `FakeDnsServer` (UDP + TCP): records, silence, delay; `dockerDnsArgs` for getaddrinfo | — |
| `@hoshinotatsuya/fault-kit/postgres` | `holdSnapshot`, `holdWriter`, `holdLock`, `idleInTransaction`, `terminateBackends`, `horizonAge` | `pg`, Postgres 15–18 |
| `@hoshinotatsuya/fault-kit/redis` | `RedisFaults.pause`/`killClients`, `slowRedis` | any client with `call()` (e.g. ioredis), Redis 6.2+ |
| `@hoshinotatsuya/fault-kit/process` | `spawnBehindShell`, `orphansOf`, `descendantsOf`, `SigtermIgnorer`, `waitForLine`/`LineReader` | Linux or macOS |

## Install

```sh
pnpm add -D @hoshinotatsuya/fault-kit
pnpm add -D pg @types/pg   # only for the /postgres entry (optional peers: pg ^8.11, @types/pg >=8.15)
```

The root, `/tcp`, `/dns`, `/process` and `/redis` load neither `pg` nor `ioredis` (`/redis` takes
any object with `call()`); a spec checks that, and that the declared dependencies match the
imports of the shipped code.

## Quick start: assert a fault without clocks

A time threshold ("answered within 200 ms") flakes on a busy machine, and "no answer for 2 s" passes
on broken code when the machine is slow. The window is bounded instead by a **witness event** or by
**event-loop turns**:

<!-- example: examples/assertions.spec.ts -->
```ts
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
  const { turns, longestTurnShare } = await turnsDuring(async () => {
    for (let batch = 0; batch < 10; batch += 1) {
      // Milliseconds of CPU per batch: thread CPU time is accounted in scheduler ticks.
      let sum = 0;
      for (let i = 0; i < 5_000_000; i += 1) sum += i % 7;
      if (sum < 0) throw new Error('unreachable');
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  expect(longestTurnShare).toBeLessThan(0.5);
  expect(turns).toBeGreaterThanOrEqual(10);
});
```

**The window must exist.** `expectPendingThrough` fails (`FaultAssertionError`) instead of passing
when there was no window: the witness rejected, resolved without giving the loop a single
macrotask, or is an event closed by the loop itself in fewer than two turns (`nextTurn()`), and
`{ turns: 0 }` is a `RangeError`. No network exchange fits in such a window, even with a server in
the same process. A witness resolved by I/O (a line from another process) is a real exchange even
within one turn. For work without I/O use `{ turns: N }`.

**The boundary is the moment of the event.** An outcome arriving through a microtask chain after the
boundary event is late for `expectSettlesBefore`. A thenable is called exactly once.

**`turnsDuring`** traces the work itself through `async_hooks`: `turns` — in how many loop turns its
code ran, `longestTurnShare` — the longest turn's share of its thread CPU time. Waiting on the
network does not add turns, so the recipe is "`longestTurnShare < 0.5` and `turns ≥` number of
batches" (a measured healthy shape is 0.1–0.2, a defective one above 0.9). Thread CPU time is accounted
in scheduler ticks (a few milliseconds on Linux): each measured batch must take longer than that, or a
few microseconds of work per turn read as one turn holding everything. `await
Promise.resolve()` is not a turn. Work queued before the call and foreign code it waits for are not
traced.

The assertions run on the real event loop (`setImmediate` from `node:timers`, the real
`process.nextTick`), so they work under `jest.useFakeTimers()`. They do not cancel the work: stop a
hung client by its own means (close it).

`membersDiff`/`expectSameMembers` compare with `util.isDeepStrictEqual` (pairwise, O(n·m)); pass a
string `key` for thousands of elements.

## TCP: the freezing proxy and DNS

<!-- example: examples/tcp-dns.spec.ts -->
```ts
// The freezing proxy's controls and the fake DNS server with Node's own resolver.
import { Resolver } from 'node:dns/promises';
import { dockerDnsArgs, FakeDnsServer } from '@hoshinotatsuya/fault-kit/dns';
import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';

it('proxy controls', async () => {
  await using proxy = await FaultProxy.start({ host: '127.0.0.1', port: 5432 });
  proxy.latency(500); // every event in both directions, closes included
  proxy.latency(0);
  proxy.drop(); // RST to current connections; drop('close') sends FIN
  proxy.blackholeNew(); // new connections are accepted and never served
  expect(proxy.stats()).toMatchObject({ accepted: 0, active: 0 });
});

it('DNS: records, NXDOMAIN, silence', async () => {
  await using dns = await FakeDnsServer.start({ records: { 'api.test': ['10.1.2.3', '2001:db8::7'] } });
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([dns.address]);

  expect(await resolver.resolve4('api.test')).toEqual(['10.1.2.3']);
  await expect(resolver.resolve4('missing.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });

  dns.silence(); // queries are received and never answered
  const pending = resolver.resolve4('api.test');
  await dns.waitForQueries(3); // "the query arrived" — an event, not a timer
  resolver.cancel(); // otherwise the query lives until the resolver's own timeout
  await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
});

// getaddrinfo reads only /etc/resolv.conf, so it is tested inside a container whose resolver points at the fake server.
export const dockerArgs = ['run', '--rm', ...dockerDnsArgs({ timeoutSeconds: 1, attempts: 1 }), 'node:24-bookworm-slim'];
```

- `freeze()` — nothing moves in either direction: no bytes, no FIN, no RST, no new upstream
  connection; sources are paused so the sender hits the TCP window. `thaw()` delivers the queue in
  order.
- `latency(ms)` delays every event in both directions (closes included), up to 2³¹−1 ms; `drop()`
  sends RST to current connections (`drop('close')` — FIN); `blackholeNew()` accepts new connections
  and never serves them; `stats()` → `{ accepted, active, blackholed, bytesToUpstream,
  bytesToClient, queuedToUpstream, queuedToClient }`.
- Backpressure is respected (a direction's queue above 1 MiB pauses the source); half-close passes
  through.
- **What the proxy is not.** No loss, corruption, reordering or jitter (TCP hides them from the
  application). It runs on the same machine, so the kernel ACKs everything the client sent: **TCP
  keepalive and retransmissions will not detect a freeze**, unlike real packet loss. Bytes already
  handed to the kernel before `freeze()` (hundreds of KB on loopback) still arrive.
- Proven by specs: ioredis and pg behind a frozen proxy get neither a reply nor an error while the
  same server answers 20 times directly; after `thaw()` the real result arrives.

`FakeDnsServer` answers A and AAAA over UDP and TCP (negative answers carry an SOA, oversized UDP
answers set TC, unsupported opcode/question count/class get NOTIMP/FORMERR/REFUSED); `silence()`
(also `'udp'`/`'tcp'` only), `delay(ms)`, `respond()`, `waitForQueries(n)`, `queries()`, `errors()`.
CNAME, PTR, MX and wildcards are not served. `dns.lookup` (getaddrinfo) reads only
`/etc/resolv.conf`, so it is tested in a container: start the server on `127.0.0.1:53` inside it and
pass `dockerDnsArgs()` (bridge network). Cancel pending resolver queries at the end of a test
(`resolver.cancel()`), or the process lives until the resolver's own timeout.

## Postgres: holders and terminations

<!-- example: examples/postgres.spec.ts -->
```ts
// Holders keep a transaction open on THEIR OWN connection until release(); release() waits for the ROLLBACK.
import { Pool } from 'pg';
import {
  holdLock,
  holdSnapshot,
  holdWriter,
  horizonAge,
  idleInTransaction,
  LOCK_MODE,
  terminateBackends,
} from '@hoshinotatsuya/fault-kit/postgres';

const url = process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:5432/postgres';

it('holders, horizon and backend termination', async () => {
  const pool = new Pool({ connectionString: url });
  await pool.query('CREATE TABLE IF NOT EXISTS events (id int); CREATE TABLE IF NOT EXISTS jobs (id int)');

  await using snapshot = await holdSnapshot(url); // REPEATABLE READ: VACUUM keeps rows that died after it
  await using writer = await holdWriter(url, 'events'); // ROW EXCLUSIVE + an xid: CREATE INDEX CONCURRENTLY waits
  await using lock = await holdLock(url, { schema: 'public', name: 'jobs' }, LOCK_MODE.accessExclusive, {
    lockTimeoutMs: 2000,
  });
  await using idle = await idleInTransaction(url, { applicationName: 'idle-worker' }); // does NOT hold the horizon

  const report = await horizonAge(pool);
  expect(report.holders.map((holder) => holder.id)).toContain(String(snapshot.pid));
  expect(writer.xid).toBeDefined();
  expect(lock.pid).toBeGreaterThan(0);

  // Terminates matching backends of the CURRENT database, never the caller's own connection.
  expect(await terminateBackends(pool, { applicationName: 'idle-worker' })).toEqual([idle.pid]);
  await expect(idle.whenLost()).resolves.toBeInstanceOf(Error);
  await pool.end();
});
```

- `holdSnapshot` (REPEATABLE READ, holds the horizon), `holdWriter` (ROW EXCLUSIVE + an xid, also
  holds the horizon), `holdLock` (any of the 8 `LOCK_MODE`s; partitions and children too unless
  `only: true`), `idleInTransaction` (explicit READ COMMITTED: idle in transaction **without** a
  snapshot). Each opens its own connection; `pid` and `applicationName` are read inside the holder's
  transaction (correct behind a transaction-mode pooler).
- Options: `applicationName`; `timeoutMs` (10 000) bounds opening and release — a holder behind a
  frozen `FaultProxy` fails instead of hanging; lock holders also take `lockTimeoutMs` (5000, at most
  half of `timeoutMs`; 0 — none) and `only`. Lock options on a non-lock holder are a type error and a
  `TypeError`.
- `whenLost()` resolves with the error the server terminated the connection with (also on FIN without
  ErrorResponse); after a clean `release()` it rejects.
- `terminateBackends(poolOrClient, filter)` — the **current** database by default (`database` or
  `anyDatabase: true` otherwise), never the caller's own connection, returns the terminated pids
  (each already dead), `BackendTerminationError` with `terminated`/`failed`/`code` on a partial
  failure. An empty filter or an empty string condition is refused; walsenders are never terminated.
  Needs `pg_signal_backend` or the victim's role.
- `horizonAge(pool)` → `{ age, holders }`: client backends of the current database, prepared
  transactions and slots (`includeBackground: true` adds autovacuum and workers). Under a role
  without `pg_read_all_stats` a foreign holder is still counted (`hidden: true`).
- Proven on Postgres 15, 16, 17 and 18: VACUUM removes 0 of 500 dead rows under `holdSnapshot` and
  all 500 after `release()`; `CREATE INDEX CONCURRENTLY` under `lock_timeout` fails with 55P03 under
  `holdWriter`; each lock mode is visible in `pg_locks` as itself.

## Redis: pause, kill, slow path

<!-- example: examples/redis.spec.ts -->
```ts
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
```

- `pause(ms, mode)` — the mode is required: `CLIENT PAUSE ALL` cannot be lifted early (`UNPAUSE`
  itself waits), so `unpause()`/`await using` wait the whole pause — keep it short; `WRITE` lifts at
  once. Under `WRITE`, commands that **may** write wait too (`EVAL` without `no-writes`, `PUBLISH`,
  `PFCOUNT`); expired keys are not readable but not removed until the pause ends.
- `killClients(filter)` by `name`, `id`, `addr`, `ip` (IPv6 with or without brackets) or `libName`
  (Redis 7.2+, refused when the server does not report it); returns the killed ids; the admin
  connection is never killed (`SKIPME`). No cluster mode: the faults act on the node the admin
  connection talks to.
- A killed ioredis client reconnects; close it after `ready` with `quit()` and wait for `end`.

## Processes: a shell without exec and orphans

<!-- example: examples/process.spec.ts -->
```ts
// A shell wrapper without exec and its orphans; a process that ignores SIGTERM. Linux or macOS.
import { SigtermIgnorer, spawnBehindShell } from '@hoshinotatsuya/fault-kit/process';

it('a signal to the shell only leaves the command an orphan', async () => {
  await using wrapped = spawnBehindShell('sleep', ['30'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const snapshot = await wrapped.descendants(); // while the tree runs, BEFORE the signal
  wrapped.signal('SIGTERM'); // only the shell — like a defective runner
  await wrapped.exited;
  expect(await wrapped.orphans(snapshot)).toHaveLength(1); // close() kills it on dispose
});

it('a process that ignores SIGTERM', async () => {
  await using ignorer = SigtermIgnorer.start();
  await ignorer.ready;
  const term = ignorer.nextTerm();
  process.kill(ignorer.pid, 'SIGTERM');
  await term; // delivered and ignored: the process is known to be alive
});
```

- `spawnBehindShell` leaves a real shell process between the caller and the command (its own process
  group); `descendants()` snapshots the tree; `orphans(snapshot)` finds live group members and
  snapshot entries (same pid and start time); `close()` kills the group and the matching snapshot
  entries one by one, and refuses (without a single signal) when the selection touches the spec
  process or its ancestors or exceeds `killLimit` (64).
- A pid that does not address one process (0, ±1, non-integers) is a `RangeError` before any
  `process.kill`. `SigtermIgnorer`/`sigtermIgnorerCommand()` — a process that survives SIGTERM.
- Wrappers and ignorers not closed by a failed spec are killed when the spec process exits (normally,
  on SIGTERM from jest-worker or SIGINT) — the listeners sit on the real Node process, not on jest's
  sandbox copy.
- `waitForLine(stream, pattern)`/`LineReader`: one reader per stream, streaming UTF-8 decoding, a
  cursor over lines, at most `LineReader.maxUnread` (10 000) unread lines.
- Linux (`/proc`) and macOS (`ps`, start time to the second). **Windows is not supported**
  (`UnsupportedPlatformError`). The macOS branch is not exercised by the package's specs: code that
  signals processes runs only in a Linux container here.

## Guarantees and limits

- Every primitive was checked by mutation: removing the mechanism turns its spec red by the number of
  failed tests.
- Postgres 15–18 and Redis 7.4/8 are verified; Redis 6.2 is the theoretical minimum
  (`CLIENT PAUSE WRITE`), not run.
- Failure messages are in Russian.

## Failure behaviour

Fail-closed: invalid options (ports, timers above 2³¹−1 ms, empty filters, empty patterns, values
without a prototype or with a throwing `toString`) are refused with the option's name before any
socket, connection or process is created; an undeterminable answer ("no window", "nothing found"
without a snapshot, unreadable `/proc`) is an error, never a green result.

## Compatibility

- Node.js ≥ 24; CommonJS package, consumers on CJS (node10 via `typesVersions`), node16, nodenext,
  ESM and `moduleResolution: bundler` (the consumer matrix checks each `exports` entry).
- `pg` ^8.11; any Redis client with `call()`; jest 30 (assertions work under fake timers).

## Testing and development

```sh
pnpm install
pnpm run typecheck            # tsc, examples/*.ts against the real API, README quotes equal examples
pnpm run lint                 # biome
pnpm test                     # real Postgres 17 and Redis 7.4 in throwaway containers (docker)
pnpm run test:examples        # the README examples against real Postgres and Redis
scripts/prepare-linux-deps.sh # once: a docker volume with jest's Linux resolver binding
pnpm run test:process         # process specs inside a throwaway Linux container without network
pnpm run test:examples:process
pnpm run test:docker          # getaddrinfo and /proc inside node:24-bookworm-slim
pnpm run test:consumers       # packed tarball in throwaway CJS/ESM consumer projects
```

`scripts/with-postgres.sh` and `scripts/with-redis.sh` start containers unless `PG_TEST_URL` and
`REDIS_TEST_URL` are set; `PG_TEST_IMAGE`/`REDIS_TEST_IMAGE` select other versions. All suites go
through jest-groups (≤300 tests per group, ≤2 workers). **Specs and mutations of code that sends
signals run only inside a throwaway Linux container**, never on the host: a mutated `pid ?? -1` once
became `process.kill(-1, 'SIGTERM')`, which signals every process of the user.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
