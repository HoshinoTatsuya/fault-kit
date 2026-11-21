import { spawn } from 'node:child_process';

import { spawnBehindShell } from './spawn-behind-shell';

// Свойство встроенного модуля не переопределяется шпионом: настоящий spawn за jest.fn.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});
const spawned = jest.mocked(spawn);

/**
 * Неверный `killLimit` — отказ ДО запуска оболочки. Прежде оболочка уже шла
 * лидером новой группы и исполняла команду, а отказ приходил из конструктора
 * обёртки: вызывающий получал исключение, а оболочка и её команда оставались
 * жить без единой ссылки на них — сирота, которого никто не уберёт.
 */
describe('spawnBehindShell: настройки проверяются до запуска', () => {
  beforeEach(() => spawned.mockClear());

  it('КОНТРОЛЬ: верный killLimit — оболочка запускается ровно один раз (шпион перехватывает spawn)', async () => {
    const wrapped = spawnBehindShell('true', [], { killLimit: 8 });

    expect(spawned).toHaveBeenCalledTimes(1);
    await wrapped.close();
  });

  it.each([
    ['отрицательный', -1],
    ['дробный', 1.5],
    ['без прототипа', Object.create(null) as unknown],
  ])('killLimit %s — RangeError, и оболочка не запущена', (_label, killLimit) => {
    expect(() => spawnBehindShell('true', [], { killLimit: killLimit as number })).toThrow(
      new RangeError(
        `killLimit — целое неотрицательное, получено ${typeof killLimit === 'number' ? killLimit : '[object Object]'}`,
      ),
    );
    expect(spawned).not.toHaveBeenCalled();
  });
});
