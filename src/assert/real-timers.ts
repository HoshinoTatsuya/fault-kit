import { clearImmediate, setImmediate } from 'node:timers';

import { realProcess } from '../real-process';

/**
 * Таймеры, которые не подменяют фальшивые таймеры jest: `setImmediate` из
 * модуля `node:timers` (jest подменяет глобальный, а не модуль) и `nextTick`
 * настоящего процесса, взятые при загрузке модуля. Под `jest.useFakeTimers()`
 * обороты пакета идут по настоящему циклу событий, а не висят до
 * `jest.advanceTimersByTime`.
 */
export const REAL_TIMERS = Object.freeze({
  setImmediate,
  clearImmediate,
  nextTick: realProcess.nextTick.bind(realProcess),
});
