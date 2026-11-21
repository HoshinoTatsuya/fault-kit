import { valueText } from '../value-text';
import { afterMicrotaskDrain } from './after-microtask-drain';
import type { Deadline } from './deadline.type';
import { nextTurn } from './next-turn';
import { observeSettle } from './observe-settle';
import { watchTurns } from './watch-turns';
import type { WindowOutcome } from './window-outcome.type';

/**
 * Прожить окно до границы или до того, как работа завершилась, и вернуть,
 * что было с работой В МОМЕНТ границы.
 *
 * Окно из оборотов проверяет исход после КАЖДОГО оборота. Окно-событие
 * снимает состояние работы прямо в колбэке события: работа, разрешённая
 * цепочкой микрозадач ПОСЛЕ границы, не засчитывается как успевшая (прежде
 * засчитывалось до трёх звеньев). Отказ обещания-границы — граница наступила,
 * но с `boundary: 'rejected'`: вызывающий решает, доказывает ли такое окно
 * что-нибудь. За окном-событием наблюдает `watchTurns`: прошло ли два оборота цикла.
 */
export const runWindow = async <T>(work: Promise<T>, deadline: Deadline): Promise<WindowOutcome<T>> => {
  const observed = observeSettle(work);
  if ('turns' in deadline) {
    if (!Number.isSafeInteger(deadline.turns) || deadline.turns < 0) {
      throw new RangeError(`число оборотов — целое неотрицательное, получено ${valueText(deadline.turns)}`);
    }
    // Сначала — опустошение очереди микрозадач (без единой макрозадачи): исход,
    // пришедший цепочкой микрозадач, укладывается и в окно из нуля оборотов.
    await new Promise<void>((resolve) => afterMicrotaskDrain(resolve));
    for (let turn = 0; turn < deadline.turns && observed.state().kind === 'pending'; turn += 1) {
      await nextTurn();
    }
    const state = observed.state();
    return {
      state,
      boundary: state.kind === 'pending' ? 'reached' : 'settled-first',
      immediate: false,
      short: false,
    };
  }
  // Своя пара оборотов — раньше любой макрозадачи, поставленной дальше: свидетель короче двух оборотов виден.
  const turns = watchTurns();
  let drained = false;
  afterMicrotaskDrain(() => {
    drained = true;
  });
  try {
    return await new Promise<WindowOutcome<T>>((resolve) => {
      work.then(
        () =>
          resolve({
            state: observed.state(),
            boundary: 'settled-first',
            immediate: false,
            short: turns.closedByLoopEarly(),
          }),
        () =>
          resolve({
            state: observed.state(),
            boundary: 'settled-first',
            immediate: false,
            short: turns.closedByLoopEarly(),
          }),
      );
      Promise.resolve(deadline).then(
        () =>
          resolve({
            state: observed.state(),
            boundary: 'reached',
            immediate: !drained,
            short: turns.closedByLoopEarly(),
          }),
        (reason: unknown) =>
          resolve({
            state: observed.state(),
            boundary: 'rejected',
            reason,
            immediate: !drained,
            short: turns.closedByLoopEarly(),
          }),
      );
    });
  } finally {
    turns.stop();
  }
};
