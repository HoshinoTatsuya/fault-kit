/**
 * Фаза, в которой исполняется колбэк ресурса типа `type`: таймер — timers,
 * `setImmediate` — check, обещания и `nextTick` — без фазы (в той же
 * макрозадаче), прочее (сокеты, файлы, DNS) — poll.
 */
export const loopPhaseOf = (type: string): number | undefined => {
  if (type === 'PROMISE' || type === 'TickObject' || type === 'Microtask') {
    return undefined;
  }
  if (type === 'Timeout') {
    return 0; // timers
  }
  // Порядок фаз оборота libuv: timers (0) → poll, ввод-вывод (1) → check, setImmediate (2).
  return type === 'Immediate' ? 2 : 1;
};
