/** Как завершился процесс: код выхода или сигнал. */
export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
