import { readdir } from 'node:fs/promises';

import { PROC_READ_CONCURRENCY } from './proc-read-concurrency.constant';
import type { ProcessInfo } from './process-info.type';
import { readProcEntry } from './read-proc-entry';

/**
 * Таблица процессов Linux из `/proc`: без `ps`, которого в минимальных образах
 * нет, а busybox-версия не знает нужных колонок.
 *
 * Читается не больше `PROC_READ_CONCURRENCY` процессов одновременно: `Promise.all`
 * по всем pid открывал тысячи файлов разом и упирался в лимит дескрипторов
 * (EMFILE). Пропускается только процесс, который читать нельзя или уже нет
 * (ENOENT, ESRCH — завершился во время чтения; EACCES, EPERM — чужой при
 * `hidepid`). Любая другая ошибка — отказ: молча потерянный процесс — это
 * «сирот нет», когда они есть.
 */
export const readProcTable = async (): Promise<readonly ProcessInfo[]> => {
  const entries = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  const rows: ProcessInfo[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let name = entries[next++]; name !== undefined; name = entries[next++]) {
      const row = await readProcEntry(name);
      if (row !== undefined) {
        rows.push(row);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROC_READ_CONCURRENCY, entries.length) }, worker));
  return rows.sort((a, b) => a.pid - b.pid);
};
