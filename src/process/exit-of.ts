import type { ChildProcess } from 'node:child_process';

import type { ExitInfo } from './exit-info.type';

/**
 * Обещание завершения процесса — по 'exit', а не по 'close': 'close' ждёт
 * закрытия stdio, а его держит потомок, переживший процесс (ровно случай
 * сироты), — и обещание не разрешилось бы никогда.
 */
export const exitOf = (child: ChildProcess): Promise<ExitInfo> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<ExitInfo>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
};
