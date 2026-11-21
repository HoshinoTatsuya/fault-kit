import { SIGTERM_IGNORER_SCRIPT } from './sigterm-ignorer-script.constant';

/**
 * Команда «процесс, игнорирующий SIGTERM» — подставить вместо настоящей
 * программы за проверяемым раннером (или за `spawnBehindShell`). Тот же Node,
 * что исполняет спеку.
 */
export const sigtermIgnorerCommand = (): { readonly command: string; readonly args: readonly string[] } =>
  Object.freeze({ command: process.execPath, args: Object.freeze(['-e', SIGTERM_IGNORER_SCRIPT]) });
