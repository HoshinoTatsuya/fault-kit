import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessInfo } from './process-info.type';

/**
 * Таблица процессов macOS/BSD через `ps`. Локаль — C: иначе `lstart` (момент
 * старта, пять слов) печатается на языке пользователя и разбор ломается.
 */
export const readPsTable = async (): Promise<readonly ProcessInfo[]> => {
  const { stdout } = await promisify(execFile)(
    'ps',
    ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='],
    { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const words = line.split(/\s+/);
      return {
        pid: Number(words[0]),
        ppid: Number(words[1]),
        pgid: Number(words[2]),
        state: words[3] ?? '?',
        startedAt: words.slice(4, 9).join(' '),
        command: words.slice(9).join(' '),
      };
    });
};
