/**
 * Процесс из таблицы процессов. `startedAt` — метка момента старта (формат
 * зависит от платформы): вместе с `pid` она отличает процесс от другого,
 * получившего тот же pid позже. `state` начинается с `Z` у зомби — завершён,
 * не подобран родителем.
 */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly state: string;
  readonly startedAt: string;
  readonly command: string;
}
