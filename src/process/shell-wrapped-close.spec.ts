import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { listProcesses } from './list-processes';
import { orphansOf } from './orphans-of';
import type { ProcessInfo } from './process-info.type';
import { ShellWrappedProcess } from './shell-wrapped-process';
import { SigtermIgnorer } from './sigterm-ignorer';

jest.mock('./list-processes');

/**
 * Уборка `close()` против ПОДДЕЛЬНОЙ таблицы процессов. `process.kill`
 * подменён до каждой проверки: ни один вызов, включая мутантов, не шлёт
 * настоящего сигнала — первое утверждение каждой проверки это и проверяет.
 * Мутации этого кода — только в Linux-контейнере (см. README «Проверка»).
 */
const SHELL = 5000;

const proc = (pid: number, ppid: number, pgid: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid,
  ppid,
  pgid,
  state: 'S',
  startedAt: `t${pid}`,
  command: `cmd${pid}`,
  ...extra,
});

/** Сам процесс спеки и его родитель — в каждой таблице: уборка обязана их видеть и не трогать. */
const self = (): ProcessInfo[] => [
  proc(process.pid, process.ppid, process.pid, { command: 'jest' }),
  proc(process.ppid, 1, process.ppid, { command: 'runner' }),
];

const fakeShell = (): ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null } =>
  Object.assign(new EventEmitter(), {
    pid: SHELL,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
  }) as unknown as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };

describe('ShellWrappedProcess.close: поштучные сигналы только перепроверенным', () => {
  let kill: jest.SpyInstance;
  let shell: ReturnType<typeof fakeShell>;
  const table = jest.mocked(listProcesses);

  const reap = (signal: NodeJS.Signals | null, code: number | null = null): void => {
    shell.signalCode = signal;
    shell.exitCode = code;
    shell.emit('exit', code, signal);
  };

  beforeEach(() => {
    shell = fakeShell();
    kill = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (
        Math.abs(pid) === SHELL &&
        signal === 'SIGKILL' &&
        shell.exitCode === null &&
        shell.signalCode === null
      ) {
        queueMicrotask(() => reap('SIGKILL'));
      }
      return true;
    });
  });

  afterEach(() => {
    table.mockReset();
  });

  const killed = (): Array<[number, unknown]> =>
    (kill.mock.calls as Array<[number, unknown]>).map(([pid, signal]) => [pid, signal]);

  it('оболочка жива: SIGKILL группе и оболочке, затем члену группы и потомку в своей сессии; чужой не тронут', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    table.mockResolvedValue([
      ...self(),
      proc(SHELL, process.pid, SHELL),
      proc(5001, SHELL, SHELL),
      proc(5002, 5001, 5002),
      proc(5006, 1, SHELL),
      proc(6000, 1, 6000),
    ]);
    await new ShellWrappedProcess(shell).close();
    const calls = killed();
    expect(calls.slice(0, 2)).toEqual([
      [-SHELL, 'SIGKILL'],
      [SHELL, 'SIGKILL'],
    ]);
    // 5006 — член группы, уже переподчинённый (не потомок): добит только потому, что группа — наша.
    expect(calls.slice(2).sort()).toEqual([
      [5001, 'SIGKILL'],
      [5002, 'SIGKILL'],
      [5006, 'SIGKILL'],
    ]);
  });

  /**
   * Оболочку подобрали, пока снималась таблица ПОСЛЕ сигнала: флаг «не подобрана»,
   * снятый до чтения, устарел — номер группы мог освободиться и достаться
   * чужому лидеру, чьи члены попали в эту же таблицу. По группе — никого.
   */
  it('оболочку подобрали во время чтения таблицы уборки: член группы, не виденный раньше, не тронут', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    table
      .mockImplementationOnce(async () => [...self(), proc(SHELL, process.pid, SHELL)])
      .mockImplementationOnce(async () => {
        if (shell.exitCode === null && shell.signalCode === null) {
          reap('SIGKILL');
        }
        return [
          ...self(),
          proc(SHELL, 1, SHELL, { startedAt: 'later', command: 'foreign-leader' }),
          proc(7000, SHELL, SHELL, { command: 'foreign-member' }),
        ];
      });
    await new ShellWrappedProcess(shell).close();
    expect(killed()).toEqual([
      [-SHELL, 'SIGKILL'],
      [SHELL, 'SIGKILL'],
    ]);
  });

  it('оболочку подобрали, пока снимался снимок потомков: ни группе, ни её pid сигнала нет', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    table.mockImplementation(async () => {
      if (shell.exitCode === null && shell.signalCode === null) {
        reap(null, 0);
      }
      return [...self(), proc(5002, 1, 5002)];
    });
    await new ShellWrappedProcess(shell).close();
    expect(killed()).toEqual([]);
  });

  it('оболочка уже подобрана: ни группе, ни её pid сигнала нет; добиты член группы и сирота из снимка до подбора', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    table.mockResolvedValue([
      ...self(),
      proc(SHELL, process.pid, SHELL),
      proc(5001, 1, SHELL),
      proc(5002, SHELL, 5002),
      proc(5003, SHELL, 5003),
    ]);
    const wrapped = new ShellWrappedProcess(shell);
    const snapshot = await wrapped.descendants();
    // Снимок — потомки; член группы, уже переподчинённый (5001), обёртка запомнила тем же чтением таблицы.
    expect(snapshot.map((info) => info.pid)).toEqual([5002, 5003]);
    reap('SIGTERM');
    table.mockResolvedValue([
      ...self(),
      proc(5001, 1, SHELL),
      proc(5002, 1, 5002),
      proc(5003, 1, 5003, { startedAt: 'позже' }),
      proc(5007, 1, SHELL),
      proc(6000, 1, 6000),
    ]);
    await wrapped.close();
    // 5007 — член группы с тем же номером, которого до подбора не было: не доказуемо наш, не тронут.
    expect(killed().sort()).toEqual([
      [5001, 'SIGKILL'],
      [5002, 'SIGKILL'],
    ]);
  });

  it('номер группы достался чужому лидеру, тот вышел, его члены живы: после подбора оболочки по группе — никого', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    reap(null, 0);
    // Процесса с номером группы в таблице нет (чужой лидер вышел), члены его группы — 7001 и 7002.
    table.mockResolvedValue([...self(), proc(7001, 1, SHELL), proc(7002, 7001, SHELL)]);
    await new ShellWrappedProcess(shell).close();
    expect(killed()).toEqual([]);
  });

  it('тот же момент старта и та же команда, но другой pid — не тот процесс (macOS: точность ps — секунда)', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const same = { startedAt: 'Mon Nov 17 09:00:00 2026', command: 'node worker.js' };
    table.mockResolvedValue([...self(), proc(SHELL, process.pid, SHELL), proc(5002, SHELL, 5002, same)]);
    const wrapped = new ShellWrappedProcess(shell);
    await wrapped.descendants();
    reap(null, 0);
    // 5002 вышел; соседний воркер с той же командой, запущенный в ту же секунду, получил pid 5003.
    table.mockResolvedValue([...self(), proc(5003, 1, 5003, same)]);
    await wrapped.close();
    expect(killed()).toEqual([]);
  });

  it('pid процесса из снимка достался другому (иной момент старта или команда) — не тронут', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    table.mockResolvedValue([...self(), proc(SHELL, process.pid, SHELL), proc(5002, SHELL, 5002)]);
    const wrapped = new ShellWrappedProcess(shell);
    await wrapped.descendants();
    reap(null, 0);
    table.mockResolvedValue([...self(), proc(5002, 1, 5002, { command: 'чужая программа' })]);
    await wrapped.close();
    expect(killed()).toEqual([]);
  });

  it('pid оболочки достался другому процессу — его группа не наша: никого по группе', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    reap(null, 0);
    table.mockResolvedValue([
      ...self(),
      proc(SHELL, 1, SHELL, { command: 'чужой лидер' }),
      proc(5004, SHELL, SHELL),
    ]);
    await new ShellWrappedProcess(shell).close();
    expect(killed()).toEqual([]);
  });

  /** Оболочка подобрана после снимка: снимок (потомки и члены группы) снят, пока номер группы был её. */
  const reapedAfterSnapshot = async (
    before: readonly ProcessInfo[],
    after: readonly ProcessInfo[],
    options: { readonly killLimit?: number } = {},
  ): Promise<ShellWrappedProcess> => {
    shell = fakeShell();
    table.mockResolvedValue([...before]);
    const wrapped = new ShellWrappedProcess(shell, options);
    await wrapped.descendants();
    reap(null, 0);
    table.mockResolvedValue([...after]);
    return wrapped;
  };

  it('EPERM на одной жертве: остальные всё равно добиты, close отклонён с перечнем недобитых', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const wrapped = await reapedAfterSnapshot(
      [
        ...self(),
        proc(SHELL, process.pid, SHELL),
        proc(5001, SHELL, SHELL),
        proc(5002, SHELL, SHELL),
        proc(5003, SHELL, SHELL),
      ],
      [...self(), proc(5001, 1, SHELL), proc(5002, 1, SHELL), proc(5003, 1, SHELL)],
    );
    kill.mockImplementation((pid: number) => {
      if (pid === 5001) {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return true;
    });
    await expect(wrapped.close()).rejects.toThrow('уборка не добила 1 из 3: 5001: kill EPERM');
    expect(killed().sort()).toEqual([
      [5001, 'SIGKILL'],
      [5002, 'SIGKILL'],
      [5003, 'SIGKILL'],
    ]);
  });

  it('выборка задела процесс спеки — отказ без единого поштучного сигнала', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const broken = [
      proc(process.pid, process.ppid, SHELL, { command: 'jest' }),
      proc(process.ppid, 1, process.ppid),
      proc(SHELL, process.pid, SHELL),
      proc(5001, 1, SHELL),
    ];
    const wrapped = await reapedAfterSnapshot(broken, broken);
    await expect(wrapped.close()).rejects.toThrow(
      `уборка задела процесс спеки или его предков (${process.pid})`,
    );
    expect(killed()).toEqual([]);
  });

  it('выборка задела предка процесса спеки — тоже отказ', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const broken = [
      proc(process.pid, process.ppid, process.pid),
      proc(process.ppid, 1, SHELL, { command: 'runner' }),
      proc(SHELL, process.pid, SHELL),
    ];
    const wrapped = await reapedAfterSnapshot(broken, broken);
    await expect(wrapped.close()).rejects.toThrow(String(process.ppid));
    expect(killed()).toEqual([]);
  });

  it('жертв больше потолка — отказ без поштучных сигналов; поднятый потолок — все добиты', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const members = Array.from({ length: 65 }, (_, index) => proc(7000 + index, 1, SHELL));
    const before = [...self(), proc(SHELL, process.pid, SHELL), ...members];
    const over = await reapedAfterSnapshot(before, [...self(), ...members]);
    await expect(over.close()).rejects.toThrow('уборка нашла 65 процессов — больше потолка 64');
    expect(killed()).toEqual([]);
    const raised = await reapedAfterSnapshot(before, [...self(), ...members], { killLimit: 65 });
    await raised.close();
    expect(killed()).toHaveLength(65);
  });

  it('зомби и сама оболочка поштучно не добиваются', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const wrapped = await reapedAfterSnapshot(
      [
        ...self(),
        proc(SHELL, process.pid, SHELL),
        proc(5001, 1, SHELL),
        proc(5005, 1, SHELL, { state: 'Ss' }),
      ],
      [
        ...self(),
        proc(SHELL, 1, SHELL, { state: 'Z' }),
        proc(5001, 1, SHELL, { state: 'Z' }),
        proc(5005, 1, SHELL, { state: 'Ss' }),
      ],
    );
    await wrapped.close();
    expect(killed()).toEqual([[5005, 'SIGKILL']]);
  });

  it('после того как оболочку подобрали: signal и signalGroup — false без сигнала; снимок потомков — отказ', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const wrapped = new ShellWrappedProcess(shell);
    reap('SIGTERM');
    expect([wrapped.signal('SIGTERM'), wrapped.signalGroup('SIGKILL')]).toEqual([false, false]);
    await expect(wrapped.descendants()).rejects.toThrow('уже завершилась');
    expect(killed()).toEqual([]);
  });

  it('orphansOf с exited: по группе никого (номер мог достаться чужим), только по снимку', async () => {
    const tracked = [proc(5004, 1, SHELL)];
    table.mockResolvedValue([
      ...self(),
      proc(SHELL, 1, SHELL, { command: 'чужой лидер' }),
      proc(5004, 1, SHELL),
      proc(5005, SHELL, SHELL),
    ]);
    expect((await orphansOf(SHELL)).map((info) => info.pid)).toEqual([5004, 5005]);
    expect((await orphansOf(SHELL, { exited: true, tracked })).map((info) => info.pid)).toEqual([5004]);
    // Чужой лидер вышел, его члены живы: прежде «процесса с номером группы нет» засчитывало группу как свою.
    table.mockResolvedValue([...self(), proc(7001, 1, SHELL), proc(7002, 7001, SHELL)]);
    expect((await orphansOf(SHELL, { exited: true, tracked })).map((info) => info.pid)).toEqual([]);
  });

  it('orphansOf с exited без снимка — отказ: «сирот нет» был бы пустой выборкой', async () => {
    table.mockResolvedValue([...self(), proc(7001, 1, SHELL)]);
    await expect(orphansOf(SHELL, { exited: true })).rejects.toThrow('снимка нет');
    await expect(orphansOf(SHELL, { exited: true, tracked: [] })).rejects.toThrow('снимка нет');
  });

  it('orphansOf по снимку: тот же pid с другим моментом старта — другой процесс, не сирота', async () => {
    table.mockResolvedValue([...self(), proc(5002, 1, 5002, { startedAt: 'позже' })]);
    expect(await orphansOf(SHELL, { exited: true, tracked: [proc(5002, SHELL, 5002)] })).toEqual([]);
    table.mockResolvedValue([...self(), proc(5002, 1, 5002)]);
    expect(
      (await orphansOf(SHELL, { exited: true, tracked: [proc(5002, SHELL, 5002)] })).map((info) => info.pid),
    ).toEqual([5002]);
  });

  /** Тот же класс, что у уборки: «подобрана ли» — по состоянию ПОСЛЕ чтения таблицы. */
  it('orphans(): оболочку подобрали во время чтения таблицы — по группе никого, только по снимку', async () => {
    table.mockResolvedValueOnce([...self(), proc(SHELL, process.pid, SHELL), proc(5001, SHELL, SHELL)]);
    const wrapped = new ShellWrappedProcess(shell);
    await wrapped.descendants();
    table.mockImplementationOnce(async () => {
      reap('SIGTERM');
      return [...self(), proc(5001, 1, SHELL), proc(7000, 1, SHELL, { command: 'чужой член группы' })];
    });
    expect((await wrapped.orphans()).map((info) => info.pid)).toEqual([5001]);
  });

  it('orphans() обёртки после подбора: по снимку обёртки, без снимка — отказ', async () => {
    table.mockResolvedValue([
      ...self(),
      proc(SHELL, process.pid, SHELL),
      proc(5001, 1, SHELL),
      proc(5002, SHELL, 5002),
    ]);
    const wrapped = new ShellWrappedProcess(shell);
    await wrapped.descendants();
    reap('SIGTERM');
    table.mockResolvedValue([...self(), proc(5001, 1, SHELL), proc(5002, 1, 5002), proc(5009, 1, SHELL)]);
    expect((await wrapped.orphans()).map((info) => info.pid)).toEqual([5001, 5002]);
    const blind = new ShellWrappedProcess(fakeShell());
    (blind.shell as unknown as { exitCode: number }).exitCode = 0;
    await expect(blind.orphans()).rejects.toThrow('снимка нет');
  });

  it('процесс без pid: отказ запуска, пришедший событием после конструктора, не роняет процесс спеки', async () => {
    const noPid = Object.assign(fakeShell(), { pid: undefined }) as unknown as ChildProcess;
    expect(() => new ShellWrappedProcess(noPid)).toThrow('нет pid');
    const create = SigtermIgnorer as unknown as new (child: ChildProcess) => SigtermIgnorer;
    const noPidIgnorer = Object.assign(fakeShell(), {
      pid: undefined,
      stdout: null,
    }) as unknown as ChildProcess;
    expect(() => new create(noPidIgnorer)).toThrow('не запустился');
    expect(() => noPid.emit('error', new Error('spawn ENOENT'))).not.toThrow();
    expect(() => noPidIgnorer.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });

  it('killLimit — целое неотрицательное', () => {
    expect(() => new ShellWrappedProcess(shell, { killLimit: -1 })).toThrow(RangeError);
    expect(() => new ShellWrappedProcess(shell, { killLimit: 1.5 })).toThrow(RangeError);
  });

  it('SigtermIgnorer.close: уже подобранному сигнал не шлётся', async () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const child = Object.assign(fakeShell(), { stdout: new (require('node:stream').PassThrough)() });
    const create = SigtermIgnorer as unknown as new (child: ChildProcess) => SigtermIgnorer;
    const ignorer = new create(child);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await ignorer.close();
    expect(killed()).toEqual([]);
  });
});
