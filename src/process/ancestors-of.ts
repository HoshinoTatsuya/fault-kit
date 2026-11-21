import type { ProcessInfo } from './process-info.type';

/** pid процесса и всех его предков по таблице (цепочка ppid до корня или до цикла). */
export const ancestorsOf = (pid: number, table: readonly ProcessInfo[]): ReadonlySet<number> => {
  const byPid = new Map(table.map((info) => [info.pid, info]));
  const chain = new Set<number>();
  for (let current: number | undefined = pid; current !== undefined && !chain.has(current); ) {
    chain.add(current);
    current = byPid.get(current)?.ppid;
  }
  return chain;
};
