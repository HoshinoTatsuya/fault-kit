import type { ProcessInfo } from './process-info.type';
import { readProcTable } from './read-proc-table';
import { readPsTable } from './read-ps-table';
import { UnsupportedPlatformError } from './unsupported-platform.error';

/** Все процессы машины (видимые пользователю), включая зомби. Linux — `/proc`, macOS/BSD — `ps`. */
export const listProcesses = (): Promise<readonly ProcessInfo[]> => {
  if (process.platform === 'linux') {
    return readProcTable();
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    return readPsTable();
  }
  return Promise.reject(new UnsupportedPlatformError(process.platform));
};
