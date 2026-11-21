import { createHook, executionAsyncResource } from 'node:async_hooks';

import { REAL_TIMERS } from './real-timers';

/**
 * Наблюдение за окном-событием: прошло ли с начала хотя бы ДВА оборота цикла
 * событий и чем была последняя макрозадача — оборотом цикла (`setImmediate`,
 * `nextTick`) или вводом-выводом/таймером.
 *
 * Окно, которое закрыл сам цикл (свидетель — `nextTurn()` или два
 * `setImmediate`) раньше двух оборотов, — не окно для работы с сетью: сервер
 * в том же процессе читает запрос в одной фазе опроса, клиент читает ответ
 * не раньше следующей. Свидетель, разрешённый ВВОДОМ-ВЫВОДОМ (ответ процесса
 * вне этого, строка из трубы), — настоящий обмен, даже если он уложился в
 * один оборот: такое окно принимается.
 *
 * Тип ресурса, созданного во время наблюдения, известен из `init`; у
 * созданного раньше (свидетель `nextTurn()`, вычисленный до вызова) — по
 * самому ресурсу: `Immediate` — оборот; реакции обещаний и `nextTick` (он
 * хранит колбэк в объекте-литерале) — не макрозадачи и последнюю не меняют:
 * поток, получивший данные из трубы, отдаёт их через `nextTick`, и это всё
 * ещё ввод-вывод; остальное — ввод-вывод и таймеры.
 */
export const watchTurns = (): { closedByLoopEarly(): boolean; stop(): void } => {
  const types = new Map<number, string>();
  let spanned = false;
  let lastLoopOnly = true;
  let second: NodeJS.Immediate | undefined;
  /** Вид колбэка: макрозадача-оборот, макрозадача ввода-вывода или таймера, либо не макрозадача вовсе. */
  const kindOf = (asyncId: number): 'loop' | 'io' | 'micro' => {
    const type = types.get(asyncId);
    if (type !== undefined) {
      return type === 'PROMISE' || type === 'TickObject' ? 'micro' : type === 'Immediate' ? 'loop' : 'io';
    }
    const resource = executionAsyncResource() as { constructor?: { name?: string } } | undefined;
    if (Object.prototype.toString.call(resource) === '[object Promise]') {
      return 'micro';
    }
    const name = resource?.constructor?.name;
    return name === 'Immediate' ? 'loop' : name === undefined || name === 'Object' ? 'micro' : 'io';
  };
  const hook = createHook({
    init(asyncId, type) {
      types.set(asyncId, type);
    },
    before(asyncId) {
      const kind = kindOf(asyncId);
      if (kind !== 'micro') {
        lastLoopOnly = kind === 'loop';
      }
    },
  });
  hook.enable();
  const first = REAL_TIMERS.setImmediate(() => {
    second = REAL_TIMERS.setImmediate(() => {
      spanned = true;
    });
  });
  return {
    closedByLoopEarly: () => !spanned && lastLoopOnly,
    stop: () => {
      hook.disable();
      REAL_TIMERS.clearImmediate(first);
      if (second !== undefined) {
        REAL_TIMERS.clearImmediate(second);
      }
    },
  };
};
