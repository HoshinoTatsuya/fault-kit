import { readdir, readFile } from 'node:fs/promises';

import { PROC_READ_CONCURRENCY } from './proc-read-concurrency.constant';
import { readProcTable } from './read-proc-table';

jest.mock('node:fs/promises');

/** Таблица `/proc` на подделанной файловой системе: ошибки чтения и одновременность видны точно. */
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('readProcTable (подделка /proc)', () => {
  const dir = jest.mocked(readdir);
  const file = jest.mocked(readFile);
  let open = 0;
  let peak = 0;

  const fakeProc = (
    pids: number[],
    fail: (path: string) => NodeJS.ErrnoException | undefined = () => undefined,
  ) => {
    dir.mockResolvedValue(['self', ...pids.map(String), 'meminfo'] as never);
    file.mockImplementation((async (path: string) => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
      const error = fail(path);
      if (error !== undefined) {
        throw error;
      }
      const pid = Number(path.split('/')[2]);
      return path.endsWith('/stat')
        ? `${pid} (node (x)) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 0 ${1000 + pid} 0 0`
        : `node\0-e\0x\0`;
    }) as never);
  };

  beforeEach(() => {
    open = 0;
    peak = 0;
  });

  it('разбор: поля после последней «)», команда из cmdline; по возрастанию pid', async () => {
    fakeProc([12, 3]);
    expect(await readProcTable()).toEqual([
      { pid: 3, ppid: 1, pgid: 3, state: 'S', startedAt: '1003', command: 'node -e x' },
      { pid: 12, ppid: 1, pgid: 12, state: 'S', startedAt: '1012', command: 'node -e x' },
    ]);
  });

  it(`одновременно открыто не больше ${PROC_READ_CONCURRENCY} файлов, сколько бы ни было процессов`, async () => {
    fakeProc(Array.from({ length: 500 }, (_, index) => index + 2));
    expect(await readProcTable()).toHaveLength(500);
    expect(PROC_READ_CONCURRENCY).toBe(16);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
  });

  it('процесс завершился (ENOENT, ESRCH) или не виден (EACCES, EPERM) — пропущен; cmdline недоступен — имя из stat', async () => {
    fakeProc([2, 3, 4, 5, 6], (path) =>
      path === '/proc/2/stat'
        ? errno('ENOENT')
        : path === '/proc/3/stat'
          ? errno('ESRCH')
          : path === '/proc/4/stat'
            ? errno('EACCES')
            : path === '/proc/5/stat'
              ? errno('EPERM')
              : path === '/proc/6/cmdline'
                ? errno('ENOENT')
                : undefined,
    );
    expect((await readProcTable()).map((row) => [row.pid, row.command])).toEqual([[6, 'node (x)']]);
  });

  it('прочие ошибки чтения (EMFILE) — отказ, а не молча потерянный процесс', async () => {
    fakeProc([2, 3], (path) => (path === '/proc/3/stat' ? errno('EMFILE') : undefined));
    await expect(readProcTable()).rejects.toMatchObject({ code: 'EMFILE' });
  });
});
