import { AsyncResource, createHook, executionAsyncId } from 'node:async_hooks';
import { loopPhaseOf } from './loop-phase-of';
import { REAL_TIMERS } from './real-timers';
import { threadCpuMicros } from './thread-cpu-micros';
import type { TurnsDuringReport } from './turns-during-report.type';

/**
 * «Отдаёт ли работа цикл событий» — по самой работе, а не по счётчику рядом.
 *
 * Код работы прослеживается через `async_hooks`: всё, что она запустила
 * (обещания, таймеры, сокеты), — её; каждый вход в её колбэк — участок её
 * кода. Участки, между которыми цикл событий не сделал ни одного оборота,
 * складываются в один оборот работы. Итог:
 * - `turns` — в скольких оборотах выполнялась работа. Ожидание ввода-вывода
 *   (сокет, таймер) его не раздувает: пока работа ждёт, её код не исполняется;
 * - `longestTurnShare` — доля самого длинного оборота в процессорном времени
 *   работы (время потока, `process.threadCpuUsage`). Синхронная обработка
 *   всего объема после ожидания сети — доля около 1 при любом числе
 *   ожиданий до неё; обработка партиями с уступкой — около 1/число партий.
 *
 * Прежний счётчик `setImmediate` рядом с работой считал обороты ПРОСТОЯ: пока
 * работа ждала сокет, он крутился десятки тысяч раз в секунду, и
 * «ждала, потом 300 мс синхронно» давало тысячи «уступок». Здесь простоя не
 * видно вовсе, и ничего не крутится: между оборотами работы пакет не держит
 * ни одной макрозадачи, поэтому потолка нет — медленная живая работа не
 * отклоняется.
 *
 * Доля — отношение двух величин одного потока одного прогона: машина вдвое
 * медленнее удлиняет и самый длинный оборот, и всю работу. Время, когда поток
 * снят с ядра (занятая машина), не входит ни туда, ни туда. Поэтому порог
 * доли не зависит от скорости машины; число оборотов не зависит от неё вовсе.
 *
 * Граница оборота — свой `setImmediate` (фаза check); участок, начатый в
 * check, ставит её в check СЛЕДУЮЩЕГО оборота, поэтому вход работы в фазе
 * раньше прежней (таймер, ввод-вывод после check) — тоже новый оборот.
 *
 * Ограничения: `async_hooks` видит колбэки, запущенные из кода работы;
 * фаза первого участка (кода вызывающего) неизвестна: вызов из фазы check с
 * немедленной уступкой таймером может склеить первые два оборота;
 * чужой код, который работа ждёт (сервер в том же процессе), — не её.
 * Работа, поставленная до вызова (уже бегущий цикл), не прослеживается.
 * Отказ работы — отказ этого вызова.
 */
export const turnsDuring = async <T>(work: () => PromiseLike<T>): Promise<TurnsDuringReport<T>> => {
  const ours = new Set<number>();
  /** Фаза цикла, в которой исполняется колбэк ресурса работы (по типу ресурса); микрозадачи — без фазы. */
  const phases = new Map<number, number>();
  let lastPhase: number | undefined;
  let scheduling = false;
  let depth = 0;
  let enteredAt = 0;
  let inTurn = false;
  let turnCpu = 0;
  let longest = 0;
  let total = 0;
  let turns = 0;
  let boundary: NodeJS.Immediate | undefined;
  const closeTurn = (): void => {
    boundary = undefined;
    inTurn = false;
    lastPhase = undefined;
    longest = Math.max(longest, turnCpu);
    turnCpu = 0;
  };
  const enter = (phase: number | undefined): void => {
    depth += 1;
    if (depth > 1) {
      return;
    }
    if (inTurn && phase !== undefined && lastPhase !== undefined && phase < lastPhase) {
      // Фаза раньше прежней — цикл уже пошёл на следующий оборот, а граница,
      // поставленная из фазы check, ждёт check СЛЕДУЮЩЕГО оборота: таймеры и
      // ввод-вывод этого оборота пришли бы раньше неё и склеились с прежним.
      if (boundary !== undefined) {
        REAL_TIMERS.clearImmediate(boundary);
      }
      closeTurn();
    }
    if (phase !== undefined) {
      lastPhase = phase;
    }
    if (!inTurn) {
      inTurn = true;
      turns += 1;
      // Конец оборота — первая макрозадача после этого участка: свой setImmediate, не причисляемый к работе.
      scheduling = true;
      try {
        boundary = REAL_TIMERS.setImmediate(closeTurn);
      } finally {
        scheduling = false;
      }
    }
    enteredAt = threadCpuMicros();
  };
  const leave = (): void => {
    depth -= 1;
    if (depth > 0) {
      return;
    }
    const spent = threadCpuMicros() - enteredAt;
    turnCpu += spent;
    total += spent;
  };
  const hook = createHook({
    init(asyncId, type) {
      if (!scheduling && ours.has(executionAsyncId())) {
        ours.add(asyncId);
        const phase = loopPhaseOf(type);
        if (phase !== undefined) {
          phases.set(asyncId, phase);
        }
      }
    },
    before(asyncId) {
      if (ours.has(asyncId)) {
        enter(phases.get(asyncId));
      }
    },
    after(asyncId) {
      if (ours.has(asyncId)) {
        leave();
      }
    },
  });
  hook.enable();
  const scope = new AsyncResource('fault-kit.turnsDuring');
  ours.add(scope.asyncId());
  try {
    const value = await scope.runInAsyncScope(work);
    return Object.freeze({
      value,
      turns,
      longestTurnShare: total > 0 ? Math.max(longest, turnCpu) / total : 0,
    });
  } finally {
    hook.disable();
    if (boundary !== undefined) {
      REAL_TIMERS.clearImmediate(boundary);
    }
    scope.emitDestroy();
  }
};
