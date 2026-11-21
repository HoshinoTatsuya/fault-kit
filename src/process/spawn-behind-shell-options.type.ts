import type { StdioOptions } from 'node:child_process';

/**
 * Настройки запуска. stdio по умолчанию — `ignore`: невычитанная труба
 * остановила бы пишущего. `killLimit` — потолок поштучных SIGKILL в
 * `close()` (по умолчанию 64): больше — отказ без сигналов.
 */
export interface SpawnBehindShellOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: StdioOptions;
  readonly killLimit?: number;
}
