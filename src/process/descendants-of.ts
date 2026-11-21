import { descendantsIn } from './descendants-in';
import { listProcesses } from './list-processes';
import type { ProcessInfo } from './process-info.type';

/**
 * Живые потомки процесса на этот момент (по цепочке родителей, транзитивно),
 * без самого процесса. Снимок: потомок, ушедший в свою сессию (`setsid`,
 * `detached: true`), по группе потом не найти — его находят по этому снимку
 * (`orphansOf(pid, { tracked })`).
 */
export const descendantsOf = async (pid: number): Promise<readonly ProcessInfo[]> =>
  descendantsIn(await listProcesses(), pid);
