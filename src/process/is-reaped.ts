import type { ChildProcess } from 'node:child_process';

/**
 * Node уже подобрал код выхода процесса (`waitpid`), то есть его pid
 * свободен и может достаться другому процессу. Пока не подобран, pid
 * зарезервирован за ним (живым или зомби) — и номер его группы тоже: сигнал
 * по ним попадёт в него, а не в чужой процесс. Проверяется синхронно прямо
 * перед сигналом: между проверкой и `kill()` в том же такте подобрать код
 * Node не может.
 */
export const isReaped = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;
