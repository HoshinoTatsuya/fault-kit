import { spawn } from 'node:child_process';

import { expectSameMembers } from '../assert/expect-same-members';
import { settledResources } from '../testing/settled-resources';
import { descendantsOf } from './descendants-of';
import { orphansOf } from './orphans-of';
import { processInfoOf } from './process-info-of';
import type { ShellWrappedProcess } from './shell-wrapped-process';
import { signalQuietly } from './signal-quietly';
import { spawnBehindShell } from './spawn-behind-shell';
import { waitForLine } from './wait-for-line';

/** Программа, которая печатает свои pid и ppid и живёт до сигнала. */
const REPORTER = "console.log('pid', process.pid, process.ppid); setInterval(() => undefined, 1 << 30);";

/**
 * pid из строки `pid <pid> <ppid>`. Не разобрался — отказ, а не запасное `-1`:
 * уборка шлёт по этим pid SIGKILL, а `kill(-1)` — это все процессы пользователя.
 */
const pidsOf = (line: string): { pid: number; ppid: number } => {
  const [, pid, ppid] = line.split(' ').map(Number);
  if (pid === undefined || ppid === undefined || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) {
    throw new Error(`строка без pid: ${line}`);
  }
  return { pid, ppid };
};

const alive = async (pid: number): Promise<boolean> => {
  const info = await processInfoOf(pid);
  return info !== undefined && !info.state.startsWith('Z');
};

describe('spawnBehindShell и сироты', () => {
  const started: ShellWrappedProcess[] = [];
  const strays: number[] = [];

  afterEach(async () => {
    for (const wrapped of started.splice(0)) {
      await wrapped.close();
    }
    for (const pid of strays.splice(0)) {
      signalQuietly(pid, 'SIGKILL');
    }
  });

  const start = async (): Promise<{ wrapped: ShellWrappedProcess; pid: number; ppid: number }> => {
    const wrapped = spawnBehindShell(process.execPath, ['-e', REPORTER], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    started.push(wrapped);
    const stdout = wrapped.shell.stdout;
    if (stdout === null) {
      throw new Error('нет stdout');
    }
    const { pid, ppid } = pidsOf(await waitForLine(stdout, /^pid \d+ \d+$/));
    strays.push(pid);
    return { wrapped, pid, ppid };
  };

  it('между запускающим и командой — отдельный процесс оболочки (exec не случился)', async () => {
    const { wrapped, pid, ppid } = await start();
    expect({ commandIsShell: pid === wrapped.pid, parentIsShell: ppid === wrapped.pid }).toEqual({
      commandIsShell: false,
      parentIsShell: true,
    });
    expectSameMembers(
      (await wrapped.descendants()).map((info) => info.pid),
      [pid],
    );
  });

  it('оболочка подобрана, снимка нет: orphans — отказ, а не «сирот нет»', async () => {
    const { wrapped, pid } = await start();
    wrapped.signal('SIGTERM');
    await wrapped.exited;
    await expect(wrapped.orphans()).rejects.toThrow('снимка нет');
    expect(await alive(pid)).toBe(true);
  });

  it('сигнал только оболочке: оболочка умерла, команда осталась сиротой — orphans её находит', async () => {
    const { wrapped, pid } = await start();
    // Снимок до сигнала: после подбора оболочки номер её группы уже не доказуемо её.
    await wrapped.descendants();
    wrapped.signal('SIGTERM');
    expect(await wrapped.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect((await wrapped.orphans()).map((info) => info.pid)).toEqual([pid]);
    expect(await alive(pid)).toBe(true);
  });

  it('сигнал группе: не остаётся никого', async () => {
    const { wrapped, pid } = await start();
    await wrapped.descendants();
    wrapped.signalGroup('SIGTERM');
    await wrapped.exited;
    await waitGone(pid);
    expect(await wrapped.orphans()).toEqual([]);
  });

  it('close: убивает группу; повторный close — то же; ресурсы процесса освобождены', async () => {
    const baseline = await settledResources();
    const { wrapped, pid } = await start();
    started.pop();
    await wrapped.close();
    await waitGone(pid);
    expect(await alive(pid)).toBe(false);
    await expect(wrapped.close()).resolves.toBeUndefined();
    expect(await settledResources()).toEqual(baseline);
  });

  it('ловушка группы: потомок в своей сессии по группе не виден, по снимку — виден', async () => {
    // Оболочка запускает node, который запускает внука detached (своя сессия), как раннер с detached: true.
    const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
      REPORTER,
    )}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }); c.unref(); setInterval(() => undefined, 1 << 30);`;
    const wrapped = spawnBehindShell(process.execPath, ['-e', launcher], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    started.push(wrapped);
    const stdout = wrapped.shell.stdout;
    if (stdout === null) {
      throw new Error('нет stdout');
    }
    const { pid: detachedPid } = pidsOf(await waitForLine(stdout, /^pid \d+ \d+$/));
    strays.push(detachedPid);
    const snapshot = await wrapped.descendants();
    expect(snapshot.map((info) => info.pid)).toContain(detachedPid);
    wrapped.signalGroup('SIGKILL');
    await wrapped.exited;
    expect(await orphansOf(wrapped.pid)).toEqual([]);
    expect((await orphansOf(wrapped.pid, { tracked: snapshot })).map((info) => info.pid)).toEqual([
      detachedPid,
    ]);
  });

  it('close добивает сироту в своей сессии, найденную по снимку descendants()', async () => {
    const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
      REPORTER,
    )}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }); c.unref(); setInterval(() => undefined, 1 << 30);`;
    const wrapped = spawnBehindShell(process.execPath, ['-e', launcher], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    started.push(wrapped);
    const stdout = wrapped.shell.stdout;
    if (stdout === null) {
      throw new Error('нет stdout');
    }
    const { pid: detachedPid } = pidsOf(await waitForLine(stdout, /^pid \d+ \d+$/));
    strays.push(detachedPid);
    const snapshot = await wrapped.descendants();
    wrapped.signal('SIGTERM');
    await wrapped.exited;
    expect((await wrapped.orphans(snapshot)).map((info) => info.pid)).toContain(detachedPid);
    await wrapped.close();
    await waitGone(detachedPid);
    expect(await wrapped.orphans(snapshot)).toEqual([]);
  });

  it('сигнал только оболочке, затем close: сирота-член группы добита поштучно', async () => {
    const { wrapped, pid } = await start();
    await wrapped.descendants();
    wrapped.signal('SIGTERM');
    await wrapped.exited;
    expect(await alive(pid)).toBe(true);
    await wrapped.close();
    await waitGone(pid);
    expect(await wrapped.orphans()).toEqual([]);
  });

  it('descendantsOf процесса без потомков — пусто; listProcesses видит саму спеку с её родителем', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], {
      stdio: 'ignore',
    });
    try {
      if (child.pid === undefined) {
        throw new Error('процесс не запустился');
      }
      expect(await descendantsOf(child.pid)).toEqual([]);
      const self = await processInfoOf(process.pid);
      expect({ pid: self?.pid, ppid: self?.ppid }).toEqual({ pid: process.pid, ppid: process.ppid });
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

/** Ждать, пока процесс исчезнет из таблицы (или станет зомби): событие ядра, а не пауза; потолок — таймаут теста. */
const waitGone = async (pid: number): Promise<void> => {
  for (;;) {
    const info = await processInfoOf(pid);
    if (info === undefined || info.state.startsWith('Z')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
