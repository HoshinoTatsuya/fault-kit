import { EventEmitter } from 'node:events';

import { realProcess } from '../real-process';
import { ExitGuard } from './exit-guard';
import { signalQuietly } from './signal-quietly';
import { SigtermIgnorer } from './sigterm-ignorer';

/**
 * Слушатели ExitGuard — на НАСТОЯЩЕМ процессе. Здесь, внутри jest, глобальный
 * `process` — копия, и подписка на неё не сработала бы никогда: спека находит
 * помеченный слушатель пакета именно на настоящем процессе и вызывает его.
 * Сам выход процесса (штатный, SIGTERM, SIGINT, воркеры jest) — в
 * `exit-guard-jest.spec.ts`: настоящий jest 30 в контейнере.
 */
const GUARD_LISTENER = Symbol.for('@hoshinotatsuya/fault-kit/exit-guard/listener');
const guardListeners = (target: NodeJS.Process, event: 'exit' | 'SIGTERM' | 'SIGINT'): Array<() => void> =>
  (target as unknown as { listeners(name: string): Array<() => void> })
    .listeners(event)
    .filter((listener) => GUARD_LISTENER in listener);
const guardListener = (event: 'exit' | 'SIGTERM' | 'SIGINT'): (() => void) => {
  const found = guardListeners(realProcess, event);
  expect(found).toHaveLength(1);
  return found[0] as () => void;
};

describe('ExitGuard', () => {
  it('внутри jest глобальный process — копия: слушатели пакета стоят на настоящем процессе', async () => {
    expect(realProcess).not.toBe(process);
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    const counts = (['exit', 'SIGTERM', 'SIGINT'] as const).map((event) => [
      guardListeners(realProcess, event).length,
      guardListeners(process, event).length,
    ]);
    expect(counts).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    await ignorer.close();
  });

  it('второй процесс не добавляет слушателей: реестр один на настоящий процесс', async () => {
    const first = SigtermIgnorer.start();
    const second = SigtermIgnorer.start();
    await Promise.all([first.ready, second.ready]);
    const counts = (['exit', 'SIGTERM', 'SIGINT'] as const).map(
      (event) => guardListeners(realProcess, event).length,
    );
    expect(counts).toEqual([1, 1, 1]);
    await Promise.all([first.close(), second.close()]);
  });

  it('забытый настоящий процесс (close не вызван) — SIGKILL слушателем выхода настоящего процесса', async () => {
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    guardListener('exit')();
    expect(await ignorer.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('уже подобранный процесс — сигнал не шлётся', async () => {
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    await ignorer.close();
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    guardListener('exit')();
    expect(kill).not.toHaveBeenCalled();
  });

  it('подделка ChildProcess не регистрируется: её выдуманный pid не получит сигнал', () => {
    const fake = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
    const kill = jest.fn();
    ExitGuard.killOnExit(fake as never, kill);
    guardListener('exit')();
    expect(kill).not.toHaveBeenCalled();
  });

  it('SIGTERM при чужом обработчике сигнала: решает он — процессы не добиты, слушатель пакета на месте', async () => {
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    const foreign = jest.fn();
    realProcess.on('SIGTERM', foreign);
    try {
      guardListener('SIGTERM')();
      // Живой и обрабатывает сигналы: SIGKILL ему не ушёл.
      const term = ignorer.nextTerm();
      expect(signalQuietly(ignorer.pid, 'SIGTERM')).toBe(true);
      await term;
      expect([ignorer.child.exitCode, ignorer.child.signalCode]).toEqual([null, null]);
      expect(guardListeners(realProcess, 'SIGTERM')).toHaveLength(1);
    } finally {
      realProcess.removeListener('SIGTERM', foreign);
      await ignorer.close();
    }
  });
});
