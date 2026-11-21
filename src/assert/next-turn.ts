import { REAL_TIMERS } from './real-timers';

/**
 * Один оборот цикла событий: `setImmediate`, а не микрозадача — та не
 * пропускает ни таймеры, ни ввод-вывод. Настоящий `setImmediate`
 * (`REAL_TIMERS`): под фальшивыми таймерами jest оборот не висит.
 */
export const nextTurn = (): Promise<void> =>
  new Promise<void>((resolve) => REAL_TIMERS.setImmediate(resolve));
