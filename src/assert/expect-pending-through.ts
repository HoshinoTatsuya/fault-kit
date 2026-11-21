import { asPromise } from './as-promise';
import type { Deadline } from './deadline.type';
import { describeSettle } from './describe-settle';
import { FaultAssertionError } from './fault-assertion.error';
import { runWindow } from './run-window';

/**
 * «Не произошло за окно»: работа не завершилась — ни ответом, ни ОТКАЗОМ, —
 * пока не наступила граница. Ровно то, что отличает замёрзшую сеть от
 * оборванной: на обрыв клиент отвечает ошибкой, на заморозку — ничем.
 *
 * Окно обязано БЫТЬ, иначе «не произошло» ничего не значит. Поэтому отказ
 * утверждения, а не зелёный результат:
 * - свидетель окна отказал (прямой клиент не подключён — ни одного обмена не было);
 * - свидетель разрешился сразу, не дав циклу событий ни одной макрозадачи
 *   (`Promise.resolve()`, цикл из нуля обращений, событие, случившееся до вызова);
 * - `{ turns: 0 }`;
 * - свидетель-событие, который закрыл сам цикл (`nextTurn()`, два
 *   `setImmediate`) раньше двух оборотов: за такое окно не успевает ни один
 *   обмен по сети, даже с сервером в том же процессе, — «не пришёл» было бы
 *   зелёным на исправно отвечающем сервере. Свидетель, разрешённый вводом-
 *   выводом (ответ другого процесса), — настоящий обмен и в один оборот.
 *   Для работы без ввода-вывода окно задаётся оборотами — `{ turns: N }`.
 *
 * Отказ работы ПОСЛЕ проверки этим вызовом уже обработан (наблюдатель
 * подписан), поэтому необработанным не станет; вызывающий может ждать ту же
 * работу дальше и увидит её исход.
 */
export const expectPendingThrough = async (
  work: PromiseLike<unknown>,
  window: Deadline,
  label = 'работа',
): Promise<void> => {
  if ('turns' in window && window.turns === 0) {
    throw new RangeError('окно из нуля оборотов ничего не проверяет: нужно хотя бы 1');
  }
  const outcome = await runWindow(asPromise(work), window);
  if (outcome.state.kind !== 'pending') {
    throw new FaultAssertionError(
      `${label}: ${describeSettle(outcome.state)} внутри окна, где не должна была`,
    );
  }
  if (outcome.boundary === 'rejected') {
    throw new FaultAssertionError(
      `${label}: свидетель окна отказал (${describeSettle({ kind: 'rejected', reason: outcome.reason })}) — окно не доказано`,
    );
  }
  if (outcome.immediate) {
    throw new FaultAssertionError(
      `${label}: свидетель окна разрешился сразу, не дав циклу событий ни одной макрозадачи — окно нулевой длины`,
    );
  }
  if (outcome.short) {
    throw new FaultAssertionError(
      `${label}: свидетель окна закрыт оборотом цикла раньше двух оборотов — за такое окно не успевает ни один ` +
        'обмен по сети и на исправном сервере; для работы без ввода-вывода задайте { turns: N }',
    );
  }
};
