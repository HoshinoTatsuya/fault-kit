import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { assertSignalablePid } from './assert-signalable-pid';
import { ShellWrappedProcess } from './shell-wrapped-process';
import { signalQuietly } from './signal-quietly';
import { SigtermIgnorer } from './sigterm-ignorer';

/**
 * Защита от `kill(-1)` (16.11.2026: сентинел `child.pid ?? -1` под мутантом
 * разослал SIGTERM всем процессам пользователя). В этом файле `process.kill`
 * подменён ДО каждой проверки: ни один вызов, включая мутантов, не шлёт
 * настоящего сигнала — первое утверждение каждой проверки это и проверяет.
 */
describe('сигнал только одному процессу или группе', () => {
  let kill: jest.SpyInstance;

  beforeEach(() => {
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  const fakeChild = (pid: number): ChildProcess =>
    Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      signalCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr: null,
    }) as unknown as ChildProcess;

  it.each([
    ['-1 (все процессы пользователя)', -1],
    ['0 (своя группа)', 0],
    ['1 (init/launchd)', 1],
    ['не число', Number.NaN],
    ['дробное', 4242.5],
    ['бесконечность', Number.NEGATIVE_INFINITY],
  ])('pid %s — отказ без сигнала', (_name, pid) => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    expect(() => signalQuietly(pid, 'SIGTERM')).toThrow(RangeError);
    expect(() => assertSignalablePid(pid)).toThrow(RangeError);
    expect(kill).not.toHaveBeenCalled();
  });

  it('процесс и группа с настоящим pid — сигнал уходит с тем же pid', () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    expect(signalQuietly(4242, 'SIGTERM')).toBe(true);
    expect(signalQuietly(-4242, 'SIGKILL')).toBe(true);
    expect(signalQuietly(2, 'SIGTERM')).toBe(true);
    expect(kill.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
      [2, 'SIGTERM'],
    ]);
  });

  it('ShellWrappedProcess: pid снят при создании — пропажа pid у процесса не превращается в -1', () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const child = fakeChild(4242);
    const wrapped = new ShellWrappedProcess(child);
    (child as { pid: number | undefined }).pid = undefined;
    expect(wrapped.pid).toBe(4242);
    wrapped.signal('SIGTERM');
    wrapped.signalGroup('SIGTERM');
    expect(kill.mock.calls).toEqual([
      [4242, 'SIGTERM'],
      [-4242, 'SIGTERM'],
    ]);
  });

  it('SigtermIgnorer: pid снят при создании — пропажа pid у процесса не превращается в -1', () => {
    expect(jest.isMockFunction(process.kill)).toBe(true);
    const child = fakeChild(4243);
    const create = SigtermIgnorer as unknown as new (child: ChildProcess) => SigtermIgnorer;
    const ignorer = new create(child);
    (child as { pid: number | undefined }).pid = undefined;
    expect(ignorer.pid).toBe(4243);
  });

  it('без pid ни обёртка, ни игнорирующий процесс не создаются', () => {
    const child = Object.assign(fakeChild(1), { pid: undefined }) as unknown as ChildProcess;
    const create = SigtermIgnorer as unknown as new (child: ChildProcess) => SigtermIgnorer;
    expect(() => new ShellWrappedProcess(child)).toThrow('нет pid');
    expect(() => new create(child)).toThrow('не запустился');
    expect(kill).not.toHaveBeenCalled();
  });
});
