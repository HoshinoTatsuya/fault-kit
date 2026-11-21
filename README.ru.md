# @hoshinotatsuya/fault-kit

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/fault-kit.svg)](https://www.npmjs.com/package/@hoshinotatsuya/fault-kit)
[![CI](https://github.com/HoshinoTatsuya/fault-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/fault-kit/actions/workflows/ci.yml)

[English version](README.md) · [Changelog](CHANGELOG.md)

Примитивы внедрения отказов для спек: то, чем находятся дефекты класса «работает, пока сеть не
замерла». Юнит-тест с моком такие дефекты не видит, чтение кода — тоже. Видно их, только когда
отказ настоящий: сокет открыт, а байты не идут; DNS не отвечает; транзакция держит горизонт;
оболочка умерла, а её потомок остался.

Пакет — dev-зависимость. Каждый примитив освобождает всё, что занял (`close()`/`release()`,
`Symbol.asyncDispose` для `await using`); спеки проверяют, что открытые ресурсы процесса до и после
совпадают.

| Вход | Что внутри | Нужно |
|---|---|---|
| `@hoshinotatsuya/fault-kit` | утверждения без стенных часов: дедлайн и окно, мультимножества, обороты цикла событий (`turnsDuring`) | — |
| `@hoshinotatsuya/fault-kit/tcp` | `FaultProxy`: `freeze`/`thaw`, `drop`, `latency`, `blackholeNew`, счётчики | — |
| `@hoshinotatsuya/fault-kit/dns` | `FakeDnsServer` (UDP + TCP): адреса, молчание, задержка; `dockerDnsArgs` для getaddrinfo | — |
| `@hoshinotatsuya/fault-kit/postgres` | `holdSnapshot`, `holdWriter`, `holdLock`, `idleInTransaction`, `terminateBackends`, `horizonAge` | `pg`, Postgres 15–18 |
| `@hoshinotatsuya/fault-kit/redis` | `RedisFaults.pause`/`killClients`, `slowRedis` | любой клиент с `call()` (например, ioredis), Redis 6.2+ |
| `@hoshinotatsuya/fault-kit/process` | `spawnBehindShell`, `orphansOf`, `descendantsOf`, `SigtermIgnorer`, `waitForLine`/`LineReader` | Linux или macOS |

## Установка

```sh
pnpm add -D @hoshinotatsuya/fault-kit
pnpm add -D pg @types/pg   # только для входа /postgres (необязательные peer: pg ^8.11, @types/pg >=8.15)
```

Корень, `/tcp`, `/dns`, `/process` и `/redis` не загружают ни `pg`, ни `ioredis` (`/redis`
принимает любой объект с `call()`); это проверяет спека, как и совпадение объявленных зависимостей
с импортами поставляемого кода.

## Быстрый старт: отказ без часов

Порог по времени («ответ не позже 200 мс») на занятой машине флакает, а «ответа нет 2 секунды»
медленная машина проходит и на сломанном коде. Границу окна задаёт **событие-свидетель** или
**число оборотов цикла**:

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

**Окно обязано быть.** `expectPendingThrough` отказывает (`FaultAssertionError`), а не зеленеет,
когда окна не было: свидетель отказал, разрешился, не дав циклу ни одной макрозадачи, или это
событие, которое закрыл сам цикл раньше двух оборотов (`nextTurn()`); `{ turns: 0 }` —
`RangeError`. За такое окно не успевает ни один обмен по сети, даже с сервером в том же процессе.
Свидетель, разрешённый вводом-выводом (строка от другого процесса), — настоящий обмен и в один
оборот. Для работы без ввода-вывода — `{ turns: N }`.

**Граница — момент события.** Исход, пришедший цепочкой микрозадач после события-границы,
`expectSettlesBefore` считает опоздавшим. Thenable вызывается ровно один раз.

**`turnsDuring`** прослеживает саму работу через `async_hooks`: `turns` — в скольких оборотах цикла
выполнялся её код, `longestTurnShare` — доля самого длинного оборота в процессорном времени её
потока. Ожидание сети оборотов не добавляет, поэтому рецепт — «`longestTurnShare < 0.5` и `turns ≥`
числа партий» (замер: исправная форма 0,1–0,2, дефектная — больше 0,9). Время потока учитывается
квантами планировщика (на Linux — единицы миллисекунд): каждая измеряемая партия обязана быть
длиннее, иначе работа в несколько микросекунд на ход читается как один ход, державший всё. `await Promise.resolve()`
оборотом не считается. Работа, поставленная до вызова, и чужой код, который она ждёт, не
прослеживаются.

Утверждения идут по настоящему циклу событий (`setImmediate` из `node:timers`, настоящий
`process.nextTick`) и работают под `jest.useFakeTimers()`. Саму работу они не отменяют: зависший
клиент останавливайте его же средствами (закрыть клиент).

`membersDiff`/`expectSameMembers` сравнивают `util.isDeepStrictEqual` (попарно, O(n·m)); для
тысяч элементов задайте строковый `key`.

## TCP: замерзающий прокси и DNS

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

- `freeze()` — ничего не идёт ни в одну сторону: ни байты, ни FIN, ни RST, ни новое подключение к
  цели; источники на паузе, отправитель упирается в окно TCP. `thaw()` отдаёт накопленное по порядку.
- `latency(ms)` — задержка каждого события в обе стороны (закрытия тоже), до 2³¹−1 мс; `drop()` —
  RST текущим соединениям (`drop('close')` — FIN); `blackholeNew()` — новые соединения принимаются и
  не обслуживаются; `stats()` → `{ accepted, active, blackholed, bytesToUpstream, bytesToClient,
  queuedToUpstream, queuedToClient }`.
- Обратное давление соблюдается (очередь направления больше 1 МиБ ставит источник на паузу);
  полузакрытие проходит насквозь.
- **Чем прокси не является.** Потерь, искажения, перестановки и разброса задержки нет (TCP скрывает
  их от приложения). Прокси на той же машине, ядро подтверждает всё, что отправил клиент: **TCP
  keepalive и ретрансмиссии заморозку не обнаружат**, в отличие от настоящей потери пакетов. Байты,
  отданные ядру до `freeze()` (на loopback — сотни КБ), дойдут.
- Доказано спеками: ioredis и pg за замёрзшим прокси не получают ни ответа, ни ошибки, пока тот же
  сервер напрямую ответил 20 раз; после `thaw()` приходит настоящий результат.

`FakeDnsServer` отвечает записями A и AAAA по UDP и TCP (отрицательный ответ несёт SOA, ответ
больше UDP клиента — с битом TC, неподдерживаемые opcode/число вопросов/класс — NOTIMP/FORMERR/
REFUSED); `silence()` (и только `'udp'`/`'tcp'`), `delay(ms)`, `respond()`, `waitForQueries(n)`,
`queries()`, `errors()`. CNAME, PTR, MX и wildcard не отдаются. `dns.lookup` (getaddrinfo) читает
только `/etc/resolv.conf`, поэтому проверяется в контейнере: сервер поднимается на `127.0.0.1:53`
внутри, резолвер направляет `dockerDnsArgs()` (сеть bridge). Домены поиска хоста в контейнер не попадают (`--dns-search .`, если
не задан `search`): имена запросов не зависят от машины. Запросы резолвера в конце теста
отменяйте (`resolver.cancel()`), иначе процесс живёт до потолка резолвера.

## Postgres: держатели и обрывы

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

- `holdSnapshot` (REPEATABLE READ, держит горизонт), `holdWriter` (ROW EXCLUSIVE + номер транзакции,
  тоже держит горизонт), `holdLock` (любой из 8 `LOCK_MODE`; секции и наследники тоже, если не
  `only: true`), `idleInTransaction` (явный READ COMMITTED: простой в транзакции **без** снимка).
  Каждый открывает своё соединение; `pid` и `applicationName` читаются внутри транзакции держателя
  (верно и за пулером в режиме транзакций).
- Настройки: `applicationName`; `timeoutMs` (10 000) — потолок открытия и освобождения: держатель за
  замёрзшим `FaultProxy` отказывает, а не висит; у держателей блокировки ещё `lockTimeoutMs` (5000,
  не больше половины `timeoutMs`; 0 — без потолка) и `only`. Настройки блокировки у держателя без
  блокировки — ошибка типа и `TypeError`.
- `whenLost()` разрешается ошибкой, с которой сервер оборвал соединение (и при FIN без
  ErrorResponse); после штатного `release()` отклоняется.
- `terminateBackends(пул или клиент, фильтр)` — по умолчанию **текущая** база (иначе `database` или
  `anyDatabase: true`), своё соединение не трогается никогда, возвращает pid снятых (каждый уже
  мёртв), при частичном отказе — `BackendTerminationError` с `terminated`/`failed`/`code`. Пустой
  фильтр и пустая строка в условии — отказ; walsender не снимается. Нужен `pg_signal_backend` или та
  же роль, что у жертвы.
- `horizonAge(pool)` → `{ age, holders }`: клиентские соединения текущей базы, подготовленные
  транзакции и слоты (`includeBackground: true` — ещё autovacuum и воркеры). Под ролью без
  `pg_read_all_stats` чужой держатель всё равно засчитывается (`hidden: true`).
- Доказано на Postgres 15, 16, 17 и 18: под `holdSnapshot` VACUUM убирает 0 из 500 мёртвых строк, после
  `release()` — все 500; `CREATE INDEX CONCURRENTLY` под `lock_timeout` при `holdWriter` падает с
  55P03; каждый режим блокировки виден в `pg_locks` именно им.

## Redis: пауза, обрыв, медленный путь

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

- `pause(ms, mode)` — режим обязателен: `CLIENT PAUSE ALL` досрочно не снять (`UNPAUSE` сам ждёт),
  поэтому `unpause()`/`await using` ждут всю паузу — держите её короткой; `WRITE` снимается сразу.
  Под `WRITE` стоят и команды, которые **могут** писать (`EVAL` без `no-writes`, `PUBLISH`,
  `PFCOUNT`); ключ с истёкшим сроком не читается, но не удаляется до снятия паузы.
- `killClients(фильтр)` по `name`, `id`, `addr`, `ip` (IPv6 — со скобками или без) или `libName`
  (Redis 7.2+, сервер не сообщает — отказ); возвращает id оборванных; административное соединение не
  обрывается никогда (`SKIPME`). Кластерного режима нет: отказы действуют на узел административного
  соединения.
- Оборванный клиент ioredis переподключается; закрывайте его после `ready` через `quit()` и ждите `end`.

## Процессы: оболочка без exec и сироты

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

- `spawnBehindShell` оставляет между запускающим и командой настоящий процесс оболочки (своя группа
  процессов); `descendants()` снимает дерево; `orphans(snapshot)` находит живых членов группы и
  записи снимка (тот же pid и момент старта); `close()` снимает группу и совпавшие записи снимков
  поштучно и отказывает (без единого сигнала), если выборка задела процесс спеки или его предков
  или больше `killLimit` (64).
- pid, который не адресует один процесс (0, ±1, не целое), — `RangeError` до `process.kill`.
  `SigtermIgnorer`/`sigtermIgnorerCommand()` — процесс, переживающий SIGTERM.
- Обёртки и процессы, не закрытые упавшей спекой, добиваются при выходе процесса спеки (штатном, по
  SIGTERM от jest-worker и по SIGINT) — слушатели стоят на настоящем процессе Node, а не на копии из
  песочницы jest.
- `waitForLine(stream, образец)`/`LineReader`: один читатель на поток, потоковое декодирование
  UTF-8, курсор по строкам, не больше `LineReader.maxUnread` (10 000) непрочитанных строк.
- Linux (`/proc`) и macOS (`ps`, момент старта с точностью до секунды). **Windows не
  поддерживается** (`UnsupportedPlatformError`). Ветка macOS спеками пакета не проверяется: код,
  шлющий сигналы, здесь идёт только в Linux-контейнере.

## Гарантии и пределы

- Каждый примитив проверен мутацией: снятие механизма делает его спеку красной по числу упавших тестов.
- Проверены Postgres 15–18 и Redis 7.4/8; Redis 6.2 — теоретический минимум (`CLIENT PAUSE WRITE`),
  не запускался.
- Тексты отказов — на русском.

## Поведение при отказе

Fail-closed: неверные настройки (порты, таймеры больше 2³¹−1 мс, пустые фильтры и образцы,
значения без прототипа или с бросающим `toString`) — отказ с именем настройки до создания сокета,
соединения или процесса; ответ, который не определить («окна не было», «сирот нет» без снимка,
нечитаемый `/proc`), — ошибка, а не зелёный результат.

## Совместимость

- Node.js ≥ 24; пакет CommonJS, потребители CJS (node10 через `typesVersions`), node16, nodenext,
  ESM и `moduleResolution: bundler` (матрица потребителей проверяет каждый вход `exports`).
- `pg` ^8.11; любой клиент Redis с `call()`; jest 30 (утверждения работают под фальшивыми таймерами).

## Разработка и тесты

```sh
pnpm install
pnpm run typecheck            # tsc, examples/*.ts против настоящего API, цитаты README равны examples
pnpm run lint                 # biome
pnpm test                     # настоящие Postgres 17 и Redis 7.4 в одноразовых контейнерах (docker)
pnpm run test:examples        # примеры README против настоящих Postgres и Redis
scripts/prepare-linux-deps.sh # один раз: том docker с linux-привязкой резолвера jest
pnpm run test:process         # спеки процессов в одноразовом Linux-контейнере без сети
pnpm run test:examples:process
pnpm run test:docker          # getaddrinfo и /proc в node:24-bookworm-slim
pnpm run test:consumers       # собранный тарбол в одноразовых проектах-потребителях CJS/ESM
```

`scripts/with-postgres.sh` и `scripts/with-redis.sh` поднимают контейнеры, если не заданы
`PG_TEST_URL` и `REDIS_TEST_URL`; `PG_TEST_IMAGE`/`REDIS_TEST_IMAGE` — другие версии. Все наборы
идут через jest-groups (≤300 тестов в группе, ≤2 воркера). **Спеки и мутации кода, который шлёт
сигналы, — только в одноразовом Linux-контейнере**, никогда на хосте: мутант `pid ?? -1` однажды
стал `process.kill(-1, 'SIGTERM')` — сигнал всем процессам пользователя.

## Лицензия

[MIT](LICENSE) © 2026 Hoshino Tatsuya
