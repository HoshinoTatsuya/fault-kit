import type { ChildProcess } from 'node:child_process';

import { ShellWrappedProcess } from './shell-wrapped-process';

/**
 * Опечатка в `killLimit` из JavaScript мимо типов — отказ с текстом, а не
 * TypeError вместо него. Оболочка — подделка без процесса: отказ настроек
 * приходит до того, как обёртка запомнит pid, и сигнала не будет ни при каком
 * исходе.
 */
describe('ShellWrappedProcess: «странный» killLimit — понятный отказ', () => {
  const fakeShell = (): ChildProcess => ({ pid: 999_999, on: () => undefined }) as unknown as ChildProcess;

  it.each([
    ['без прототипа', (): unknown => Object.create(null)],
    [
      'с бросающим toString',
      (): unknown => ({
        toString: () => {
          throw new Error('toString');
        },
      }),
    ],
    [
      'с бросающим Symbol.toPrimitive',
      (): unknown => ({
        [Symbol.toPrimitive]: () => {
          throw new Error('toPrimitive');
        },
      }),
    ],
  ])('killLimit — значение %s', (_label, make) => {
    expect(() => new ShellWrappedProcess(fakeShell(), { killLimit: make() as number })).toThrow(
      'killLimit — целое неотрицательное, получено [object Object]',
    );
  });
});
