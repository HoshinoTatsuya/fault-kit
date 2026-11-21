import type { ProcessInfo } from './process-info.type';

/**
 * Та же запись таблицы — тот же процесс: pid, момент старта и команда. pid
 * переиспользуется, момент старта на macOS — с точностью до секунды; команда
 * сужает совпадение ещё. Процесс, сменивший команду (exec), считается
 * другим — для уборки это безопасная сторона: лишний не убит.
 */
export const sameProcess = (a: ProcessInfo, b: ProcessInfo): boolean =>
  a.pid === b.pid && a.startedAt === b.startedAt && a.command === b.command;
