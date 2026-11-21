import { readFile } from 'node:fs/promises';

import type { ProcessInfo } from './process-info.type';

/**
 * Один процесс из `/proc/<pid>`: `undefined` — процесса уже нет (ENOENT, ESRCH)
 * или его не видно (EACCES, EPERM при `hidepid`). Любая другая ошибка
 * (EMFILE, EIO…) — отказ, а не пропуск.
 */
export const readProcEntry = async (name: string): Promise<ProcessInfo | undefined> => {
  const tolerate = <T>(error: unknown, fallback: T): T => {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return fallback;
    }
    throw error;
  };
  const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch((error: unknown) =>
    tolerate(error, undefined),
  );
  if (stat === undefined) {
    return undefined;
  }
  // Имя команды — в скобках и может содержать пробелы и скобки: поля — после ПОСЛЕДНЕЙ «)».
  const close = stat.lastIndexOf(')');
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(' ');
  const cmdline = (
    await readFile(`/proc/${name}/cmdline`, 'utf8').catch((error: unknown) => tolerate(error, ''))
  )
    .replace(/\0+$/, '')
    .replaceAll('\0', ' ');
  return {
    pid: Number(name),
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    state: fields[0] ?? '?',
    startedAt: fields[19] ?? '',
    command: cmdline === '' ? comm : cmdline,
  };
};
