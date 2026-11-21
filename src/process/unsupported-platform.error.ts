/** Примитив процессов не умеет эту платформу (Windows: нет групп процессов POSIX и `/bin/sh`). */
export class UnsupportedPlatformError extends Error {
  public override readonly name = 'UnsupportedPlatformError';

  public constructor(public readonly platform: string) {
    super(`примитивы процессов не поддерживают платформу ${platform}: нужны Linux или macOS`);
  }
}
