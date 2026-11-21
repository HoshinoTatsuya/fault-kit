import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LineReader } from './line-reader';
import { processInfoOf } from './process-info-of';

/**
 * ExitGuard в НАСТОЯЩЕМ jest 30 (только в контейнере, `pnpm run test:process`):
 * спека-фикстура запускает `SigtermIgnorer` и команду за `spawnBehindShell`,
 * не вызывает `close()` и сообщает pid по unix-сокету; затем процесс jest
 * завершается одним из способов, а проверка смотрит, живы ли жертвы.
 *
 * Внутри jest глобальный `process` — копия, которая не завершается: подписка
 * на неё оставляла жертв живыми при любом выходе. jest-worker снимает
 * невышедший воркер SIGTERM, а не SIGKILL, — по SIGTERM 'exit' не наступает.
 */
const ROOT = resolve(__dirname, '..', '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const TS_JEST = join(ROOT, 'node_modules', 'ts-jest');

const FIXTURE = `
import { connect } from 'node:net';
import { SigtermIgnorer, spawnBehindShell, waitForLine } from '${ROOT}/src/process';

// Настоящий процесс — из основного realm Node: jest 30.5 отдаёт на getBuiltinModule('node:process') копию.
const realProcess = new (Buffer.constructor as FunctionConstructor)('return process')() as NodeJS.Process;

it('оставляет процессы без close()', async () => {
  const ignorer = SigtermIgnorer.start();
  await ignorer.ready;
  const wrapped = spawnBehindShell(process.execPath, ['-e', "console.log('pid', process.pid); setInterval(() => {}, 1e9)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = await waitForLine(wrapped.shell.stdout as NonNullable<typeof wrapped.shell.stdout>, /^pid [0-9]+$/);
  const report = { runner: realProcess.pid, ignorer: ignorer.pid, command: Number(line.split(' ')[1]) };
  const socket = connect(process.env.FK_SOCKET as string);
  if (process.env.FK_FOREIGN === '1') {
    // Чужой обработчик SIGTERM: решает он — сообщает, живы ли жертвы в момент сигнала, и выходит сам.
    realProcess.on('SIGTERM', () => {
      const alive = [ignorer.pid, report.command].map((pid) => { if (!(pid > 1)) { return false; } try { realProcess.kill(pid, 0); return true; } catch { return false; } });
      socket.end(JSON.stringify({ atSignal: alive }) + '\\n', () => realProcess.exit(7));
    });
  }
  await new Promise<void>((done) => socket.write(JSON.stringify(report) + '\\n', () => done()));
  if (process.env.FK_BLOCK === '1') {
    await new Promise(() => undefined);
  }
  socket.end();
});
`;

interface Report {
  readonly runner: number;
  readonly ignorer: number;
  readonly command: number;
}

interface Run {
  readonly child: ChildProcess;
  readonly reports: (count: number) => Promise<readonly Report[]>;
  readonly line: (pattern: RegExp) => Promise<string>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

let dir = '';
let server: Server;
const lines: string[] = [];
let lineWaiters: Array<() => void> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fault-kit-exit-guard-'));
  writeFileSync(join(dir, 'a.fixture.ts'), FIXTURE);
  writeFileSync(join(dir, 'b.fixture.ts'), FIXTURE);
  writeFileSync(
    join(dir, 'jest.config.js'),
    `module.exports = ${JSON.stringify({
      rootDir: dir,
      testMatch: ['<rootDir>/*.fixture.ts'],
      testEnvironment: 'node',
      testTimeout: 120000,
      transform: { '^.+\\.ts$': [TS_JEST, { tsconfig: join(ROOT, 'tsconfig.json'), diagnostics: false }] },
    })};`,
  );
  server = createServer((socket) => {
    LineReader.of(socket).onLine((line) => {
      lines.push(line);
      for (const wake of lineWaiters.splice(0)) {
        wake();
      }
    });
  });
  await new Promise<void>((done) => server.listen(join(dir, 'pids.sock'), done));
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  if (dir.startsWith(join(tmpdir(), 'fault-kit-exit-guard-'))) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  lines.length = 0;
  lineWaiters = [];
});

const nextLine = (pattern: RegExp): Promise<string> =>
  new Promise<string>((done) => {
    const check = (): void => {
      const at = lines.findIndex((line) => pattern.test(line));
      if (at >= 0) {
        done(lines.splice(at, 1)[0] as string);
      } else {
        lineWaiters.push(check);
      }
    };
    check();
  });

let runs = 0;

const startJest = (files: readonly string[], args: readonly string[], env: Record<string, string>): Run => {
  runs += 1;
  const child = spawn(
    process.execPath,
    [
      JEST,
      '-c',
      join(dir, 'jest.config.js'),
      '--ci',
      '--no-watchman',
      // Свой кэш на каждый запуск: по замерам прошлого запуска jest решил бы «быстро — в одном процессе».
      `--cacheDirectory=${join(dir, `cache-${runs}`)}`,
      ...args,
      ...files.map((file) => join(dir, file)),
    ],
    {
      cwd: dir,
      env: { ...process.env, FK_SOCKET: join(dir, 'pids.sock'), ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  );
  return {
    child,
    exited,
    stderr: () => stderr,
    line: nextLine,
    reports: async (count) => {
      const found: Report[] = [];
      while (found.length < count) {
        found.push(JSON.parse(await nextLine(/"runner"/)) as Report);
      }
      return found;
    },
  };
};

/** Жив ли процесс: зомби и отсутствующий — мёртв. После выхода jest жертва, получившая SIGKILL, умирает за доли секунды. */
const aliveAfterRunner = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const info = await processInfoOf(pid);
    if (info === undefined || info.state.startsWith('Z')) {
      return false;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  return true;
};

const victimsAlive = async (reports: readonly Report[]): Promise<boolean[]> => {
  const alive: boolean[] = [];
  for (const report of reports) {
    alive.push(await aliveAfterRunner(report.ignorer), await aliveAfterRunner(report.command));
  }
  return alive;
};

/** Если проверка упала — не оставить жертв жить дальше в контейнере. */
const killLeftovers = (reports: readonly Report[]): void => {
  for (const report of reports) {
    for (const pid of [report.ignorer, report.command]) {
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // уже мёртв
        }
      }
    }
  }
};

describe('ExitGuard в настоящем jest 30', () => {
  it('в одном процессе, штатный выход (--forceExit): жертвы мертвы', async () => {
    const run = startJest(['a.fixture.ts'], ['--runInBand', '--forceExit'], {});
    const reports = await run.reports(1);
    try {
      const exit = await run.exited;
      // Вывод jest — только в тексте отказа: при исправном прогоне сравнивается один исход.
      expect(exit.code === 0 ? exit : { ...exit, stderr: run.stderr() }).toEqual({ code: 0, signal: null });
      expect(reports.map((report) => report.runner)).toEqual([run.child.pid]);
      expect(await victimsAlive(reports)).toEqual([false, false]);
    } finally {
      killLeftovers(reports);
    }
  }, 60000);

  it('в воркерах jest (2 файла, 2 воркера), штатный конец прогона: жертвы мертвы', async () => {
    const run = startJest(['a.fixture.ts', 'b.fixture.ts'], ['--maxWorkers=2', '--forceExit'], {});
    const reports = await run.reports(2);
    try {
      const exit = await run.exited;
      // Вывод jest — только в тексте отказа: при исправном прогоне сравнивается один исход.
      expect(exit.code === 0 ? exit : { ...exit, stderr: run.stderr() }).toEqual({ code: 0, signal: null });
      // Жертвы запускали воркеры, а не основной процесс jest.
      expect(reports.map((report) => report.runner === run.child.pid)).toEqual([false, false]);
      expect(await victimsAlive(reports)).toEqual([false, false, false, false]);
    } finally {
      killLeftovers(reports);
    }
  }, 60000);

  it.each([['SIGTERM' as const], ['SIGINT' as const]])(
    'процесс jest получил %s посреди спеки: жертвы мертвы, процесс завершён тем же сигналом',
    async (signal) => {
      const run = startJest(['a.fixture.ts'], ['--runInBand'], { FK_BLOCK: '1' });
      const reports = await run.reports(1);
      try {
        expect(run.child.kill(signal)).toBe(true);
        expect(await run.exited).toEqual({ code: null, signal });
        expect(await victimsAlive(reports)).toEqual([false, false]);
      } finally {
        killLeftovers(reports);
      }
    },
    60000,
  );

  it('чужой обработчик SIGTERM: в момент сигнала жертвы живы (решает он), после его выхода — мертвы', async () => {
    const run = startJest(['a.fixture.ts'], ['--runInBand'], { FK_BLOCK: '1', FK_FOREIGN: '1' });
    const reports = await run.reports(1);
    try {
      expect(run.child.kill('SIGTERM')).toBe(true);
      expect(JSON.parse(await run.line(/"atSignal"/))).toEqual({ atSignal: [true, true] });
      expect(await run.exited).toEqual({ code: 7, signal: null });
      expect(await victimsAlive(reports)).toEqual([false, false]);
    } finally {
      killLeftovers(reports);
    }
  }, 60000);
});
