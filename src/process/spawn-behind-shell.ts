import { spawn } from 'node:child_process';
import { killLimitOf } from './kill-limit-of';
import { ShellWrappedProcess } from './shell-wrapped-process';
import { SHELL_WRAPPER_SCRIPT } from './shell-wrapper-script.constant';
import type { SpawnBehindShellOptions } from './spawn-behind-shell-options.type';
import { UnsupportedPlatformError } from './unsupported-platform.error';

/**
 * Запустить `command args…` за `/bin/sh` БЕЗ exec: оболочка остаётся отдельным
 * процессом-родителем. Это форма, в которой сирот плодит любой запускающий,
 * шлющий сигнал только прямому потомку: `"test": "./scripts/test.sh"`,
 * `sh -c`, менеджер пакетов. Аргументы передаются позиционно, без
 * интерполяции в текст скрипта, — экранировать нечего.
 *
 * Оболочка запускается лидером новой группы процессов (`detached`), чтобы и
 * проверяемый раннер, и уборка могли обратиться ко всей группе.
 */
export const spawnBehindShell = (
  command: string,
  args: readonly string[] = [],
  options: SpawnBehindShellOptions = {},
): ShellWrappedProcess => {
  if (process.platform === 'win32') {
    throw new UnsupportedPlatformError(process.platform);
  }
  // До spawn: отказ после запуска оставил бы оболочку с командой жить без ссылки на неё.
  const killLimit = killLimitOf(options.killLimit);
  const shell = spawn('/bin/sh', ['-c', SHELL_WRAPPER_SCRIPT, command, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'ignore',
    detached: true,
  });
  return new ShellWrappedProcess(shell, { killLimit });
};
