import { isZombie } from './is-zombie';
import { listProcesses } from './list-processes';
import type { ProcessInfo } from './process-info.type';

/**
 * Что осталось живым от процесса после его завершения: члены его группы
 * процессов (pgid = pid; группа своя у процесса, запущенного с
 * `detached: true`, — так запускает `spawnBehindShell`) и процессы из
 * снимка `tracked` (`descendantsOf`, снятый, пока дерево работало), которые
 * всё ещё живы — тот же pid и тот же момент старта.
 *
 * Только группа — ловушка: потомок, ушедший в свою сессию (`detached: true`
 * у запускающего его раннера), группу покидает, и сирота среди ВЕРНО
 * выглядящих «ноль сирот» не виден. Снимок закрывает это; без снимка
 * результат — нижняя граница. Зомби не считаются: они уже не работают.
 *
 * `exited: true` — процесс `pid` точно завершён и подобран. Тогда номер его
 * группы мог опустеть и достаться чужому лидеру (а тот — выйти, оставив
 * своих членов): по группе не считается никто, только по снимку `tracked`.
 * `exited` функцией — спрашивается и после чтения таблицы: подбор посреди
 * асинхронного чтения освобождает номер группы, и флаг, снятый до него, устарел.
 * `exited: true` без снимка — отказ: ответ «сирот нет» был бы не проверкой,
 * а пустой выборкой. Пределы точности — в README («Чего поиск сирот не
 * различает»).
 */
export const orphansOf = async (
  pid: number,
  options: {
    readonly tracked?: readonly ProcessInfo[];
    readonly exited?: boolean | (() => boolean);
  } = {},
): Promise<readonly ProcessInfo[]> => {
  const refuse = (): never => {
    throw new TypeError(
      `процесс ${pid} подобран, снимка нет: членов его бывшей группы не отличить от чужих — ` +
        'снимите descendantsOf, пока он работает, и передайте в tracked',
    );
  };
  const exited = (): boolean =>
    typeof options.exited === 'function' ? options.exited() : options.exited === true;
  const untracked = (options.tracked ?? []).length === 0;
  if (exited() && untracked) {
    refuse();
  }
  const table = await listProcesses();
  // Функция `exited` спрашивается и ПОСЛЕ чтения таблицы (в том же такте, что выборка):
  // процесс, подобранный посреди чтения, освободил номер группы.
  const groupIsOurs = !exited();
  if (!groupIsOurs && untracked) {
    refuse();
  }
  const alive = table.filter((info) => !isZombie(info));
  const found = new Map<number, ProcessInfo>();
  for (const info of alive) {
    if (groupIsOurs && info.pgid === pid && info.pid !== pid) {
      found.set(info.pid, info);
    }
  }
  for (const known of options.tracked ?? []) {
    const current = alive.find((info) => info.pid === known.pid && info.startedAt === known.startedAt);
    if (current !== undefined && current.pid !== pid) {
      found.set(current.pid, current);
    }
  }
  return Object.freeze([...found.values()].sort((a, b) => a.pid - b.pid));
};
