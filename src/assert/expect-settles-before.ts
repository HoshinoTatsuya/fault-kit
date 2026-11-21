import { asPromise } from './as-promise';
import type { Deadline } from './deadline.type';
import { describeSettle } from './describe-settle';
import { FaultAssertionError } from './fault-assertion.error';
import { runWindow } from './run-window';

/**
 * «Произошло до дедлайна». Работа завершилась раньше границы — её значение
 * (или её отказ, как есть: «быстро отказала» — тоже исход, и проверять его
 * вызывающему); граница наступила раньше — `FaultAssertionError`. Исход,
 * пришедший цепочкой микрозадач уже ПОСЛЕ события-границы, — опоздал.
 *
 * Граница — событие или число оборотов цикла (см. `Deadline`), а не порог по
 * часам: порог на занятой машине — флак. Отказ обещания-границы — тоже
 * наступление границы: свидетель, упавший раньше работы, всё равно отметил
 * момент (причина — в тексте отказа).
 */
export const expectSettlesBefore = async <T>(
  work: PromiseLike<T>,
  deadline: Deadline,
  label = 'работа',
): Promise<T> => {
  const outcome = await runWindow(asPromise(work), deadline);
  if (outcome.state.kind === 'resolved') {
    return outcome.state.value;
  }
  if (outcome.state.kind === 'rejected') {
    throw outcome.state.reason;
  }
  const witness =
    outcome.boundary === 'rejected'
      ? ` (свидетель-дедлайн ${describeSettle({ kind: 'rejected', reason: outcome.reason })})`
      : '';
  throw new FaultAssertionError(`${label}: не завершилась до дедлайна${witness}`);
};
