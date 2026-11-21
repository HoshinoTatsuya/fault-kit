# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning
with the pre-1.0 rule that a minor version may break the API (each such version has a
**Migration** section).

## [0.3.2] — 2026-11-21

### Changed
- First public release as `@hoshinotatsuya/fault-kit`, MIT; documentation in English and
  Russian.
- The process-global registry of the exit guard is keyed by the new package name
  (`Symbol.for('@hoshinotatsuya/fault-kit/exit-guard@1')`). A process that loads both an older
  differently-scoped copy and this one keeps two registries; each still kills its own forgotten
  processes on exit.
- Development tooling raised: architecture gates `^0.12.2`, grouped test runner `^0.7.2`.
- CI moved to GitHub Actions; README examples live in `examples/`, are type-checked and run
  against real Postgres and Redis (`test:examples`; the process example in a Linux container,
  `test:examples:process`).

## [0.3.1]

### Fixed
- `spawnBehindShell` validates `killLimit` before spawning: an invalid value used to be rejected
  by the wrapper's constructor after the shell had already started, leaving it running without a
  reference.
- `terminateBackends`: an invalid filter is a `TypeError` with the value's text; string fields and
  `pid` were shown with `JSON.stringify` (which throws on BigInt and cycles), and a `pid` that is
  neither a number nor an iterable crashed with "is not iterable".
- Option refusals no longer throw a `TypeError` on a value without a prototype or with a throwing
  `toString`/`Symbol.toPrimitive` (`FaultProxy`, `FakeDnsServer`, `dockerDnsArgs`, holders,
  `terminateBackends`, `RedisFaults.pause`, `expectSettlesBefore`/`expectPendingThrough`,
  `ShellWrappedProcess`); `terminateBackends` gives `BackendTerminationError` when the caller's
  connection rejects with `null`.

## [0.3.0]

### Changed
- `ShellWrappedProcess.close()` decides "was the shell reaped" after reading the process table;
  `orphansOf(pid, { exited })` accepts a function.
- `LineReader`/`waitForLine` reject when the stream was destroyed or ended before the reader.
- `turnsDuring`: a check-phase section and the following timer or I/O are different turns.
- `expectSettlesBefore` and `{ turns: N }`: an outcome arriving through microtasks fits the window.
- `FakeDnsServer`: a query without a question gets FORMERR; OPT anywhere in the additional
  section; `ttlSeconds` above 2³¹−1 is refused at start.
- `FaultProxy.stats()` byte counters count completed writes only.

### Migration
- A spec asserting silence of `FakeDnsServer` on a question-less query must expect FORMERR; exact
  `turnsDuring` turn counts for work yielding by a timer after `setImmediate` grow.

## [0.2.1]

### Fixed
- jest 30.5: the exit guard subscribes to the real process again (jest 30.5 intercepted
  `process.getBuiltinModule`).

## [0.2.0]

### Migration
- `RedisFaults.pause(ms, mode)`: the mode is required (`REDIS_PAUSE_MODE.all` was the default).
- `terminateBackends`: only the current database by default (`database`, `anyDatabase`);
  partial failures are `BackendTerminationError`; Postgres 15+.
- `horizonAge`: client backends only by default (`includeBackground`); holders have
  `backendType` and `hidden`.
- Holder options split into `HolderOptions` and `LockHoldOptions` (`HoldOptions` removed).
- `expectPendingThrough` refuses windows that did not exist; `macrotasksDuring` replaced by
  `turnsDuring` (`{ value, turns, longestTurnShare }`).
- Empty filters and empty patterns are refused; `orphansOf(pid, { exited: true })` needs a
  snapshot; `membersDiff` uses deep equality; `ioredis` removed from peers.

### Added
- `killClients({ ip })`, `FakeDnsServer.silence('udp' | 'tcp')`, `errors()`, EDNS0 and TC,
  `dockerDnsArgs({ ndots, search })`, `turnsDuring`, `LineReader.maxUnread`, killing forgotten
  processes on exit, `test:process`.

### Fixed
- Many proxy, DNS, holder, Redis and process fixes (latency losing a closing reply, freeze
  letting RST/FIN through, `waitForLine` losing lines, holders without timeouts, `idleInTransaction`
  holding the horizon under REPEATABLE READ by default, and more).

## [0.1.1]

### Fixed
- A signal can no longer reach every process of the user: the pid is taken at creation and every
  `process.kill` refuses pid 0, ±1 and non-integers.

## [0.1.0]
- First version: TCP fault proxy, fake DNS server, Postgres holders, Redis faults, shell wrapper
  and orphan detection, deadline assertions without wall clocks.
