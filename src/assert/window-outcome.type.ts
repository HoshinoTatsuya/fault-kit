import type { SettleState } from './settle-state.type';

/**
 * Исход окна. `state` — что было с работой В МОМЕНТ границы (или когда она
 * завершилась раньше границы). `boundary`: `reached` — граница наступила
 * (событие разрешилось или обороты кончились), `rejected` — обещание-граница
 * отказало (`reason`), `settled-first` — работа завершилась раньше границы.
 * `immediate` — событие-граница разрешилось сразу, не дав циклу событий ни
 * одной макрозадачи: окно нулевой длины. `short` — окно-событие закрыл сам цикл
 * (`setImmediate`, `nextTick`) раньше двух оборотов (у окна из оборотов —
 * `false`).
 */
export interface WindowOutcome<T> {
  readonly state: SettleState<T>;
  readonly boundary: 'reached' | 'rejected' | 'settled-first';
  readonly reason?: unknown;
  readonly immediate: boolean;
  readonly short: boolean;
}
