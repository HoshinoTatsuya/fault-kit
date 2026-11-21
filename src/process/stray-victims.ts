import { ancestorsOf } from './ancestors-of';
import { isZombie } from './is-zombie';
import type { ProcessInfo } from './process-info.type';
import { sameProcess } from './same-process';

/**
 * Кого уборка `ShellWrappedProcess.close()` вправе добить поодиночке —
 * перепроверка по СВЕЖЕЙ таблице, снятой прямо перед сигналами:
 * - живой член группы `group`, кроме самой оболочки, — только пока оболочка
 *   НЕ подобрана (`shellReaped: false`): тогда номер группы зарезервирован за
 *   ней. После подбора группа могла опустеть, номер — достаться чужому
 *   лидеру, а тот — выйти, оставив своих членов живыми: «процесса с номером
 *   группы в таблице нет» не доказывает, что группа наша. Поэтому после
 *   подбора по группе не выбирается никто; члены группы попадают в `known`
 *   снимком, снятым ДО подбора;
 * - живой процесс, совпавший с ранее увиденным (`known`) по pid, моменту
 *   старта и команде.
 *
 * Выборка, задевшая сам процесс спеки или его предков, — признак дефекта
 * выборки (потомок оболочки не может быть предком того, кто её запустил):
 * отказ без единого сигнала. Жертв больше `limit` — тоже отказ: сломанная
 * таблица процессов или фильтр, расширивший выборку, не должны превращаться
 * в SIGKILL сотне чужих процессов.
 */
export const strayVictims = (
  table: readonly ProcessInfo[],
  scope: {
    readonly group: number;
    readonly shellReaped: boolean;
    readonly known: readonly ProcessInfo[];
    readonly limit: number;
  },
): readonly ProcessInfo[] => {
  const { group, known, limit } = scope;
  const groupIsOurs = !scope.shellReaped;
  const victims = table.filter(
    (info) =>
      !isZombie(info) &&
      info.pid !== group &&
      ((groupIsOurs && info.pgid === group) || known.some((seen) => sameProcess(seen, info))),
  );
  const protectedPids = ancestorsOf(process.pid, table);
  const forbidden = victims.filter((info) => protectedPids.has(info.pid));
  if (forbidden.length > 0) {
    throw new Error(
      `уборка задела процесс спеки или его предков (${forbidden.map((info) => info.pid).join(', ')}): ` +
        'выборка неверна, сигналы не посланы',
    );
  }
  if (victims.length > limit) {
    throw new Error(
      `уборка нашла ${victims.length} процессов — больше потолка ${limit}: сигналы не посланы ` +
        '(сломанная таблица процессов или выборка; если дерево действительно такое — поднимите killLimit)',
    );
  }
  return victims;
};
