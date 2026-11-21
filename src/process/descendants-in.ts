import { isZombie } from './is-zombie';
import type { ProcessInfo } from './process-info.type';

/**
 * Потомки `pid` по таблице (по цепочке родителей, транзитивно), без самого
 * процесса и без зомби. Чистая функция над одной таблицей: снимок потомков и
 * членов группы берётся из ОДНОГО чтения таблицы.
 */
export const descendantsIn = (table: readonly ProcessInfo[], pid: number): readonly ProcessInfo[] => {
  const alive = table.filter((info) => !isZombie(info));
  const found: ProcessInfo[] = [];
  const parents = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const info of alive) {
      if (parents.has(info.ppid) && !parents.has(info.pid)) {
        parents.add(info.pid);
        found.push(info);
        grew = true;
      }
    }
  }
  return Object.freeze(found);
};
