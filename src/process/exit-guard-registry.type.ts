import type { ChildProcess } from 'node:child_process';

/**
 * Реестр незавершённых процессов на настоящем процессе Node — один на все
 * копии модуля (реестр модулей jest на каждый файл спек, две версии пакета в
 * монорепозитории): слушатели выхода и сигналов ставятся ровно один раз.
 */
export interface ExitGuardRegistry {
  readonly live: Map<ChildProcess, () => void>;
}
