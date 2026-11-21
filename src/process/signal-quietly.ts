import { assertSignalablePid } from './assert-signalable-pid';

/**
 * Послать сигнал процессу (или группе: отрицательный pid); уже завершённый — не ошибка.
 * pid вне `assertSignalablePid` (0, ±1, не целое) — отказ без сигнала.
 */
export const signalQuietly = (pid: number, signal: NodeJS.Signals): boolean => {
  assertSignalablePid(pid);
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};
