import { listProcesses } from './list-processes';
import type { ProcessInfo } from './process-info.type';

/** Процесс по pid или `undefined`, если такого нет. Зомби возвращается (см. `ProcessInfo.state`). */
export const processInfoOf = async (pid: number): Promise<ProcessInfo | undefined> =>
  (await listProcesses()).find((info) => info.pid === pid);
