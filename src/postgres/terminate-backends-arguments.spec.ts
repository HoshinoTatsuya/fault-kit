import { terminateBackends } from './terminate-backends';

/**
 * Неверный фильтр из JavaScript мимо типов — отказ с текстом ДО обращения к
 * серверу. Прежде BigInt и цикл ломали саму строку отказа (JSON.stringify), а
 * `pid` не числом и не списком — разворот `[...pid]` («is not iterable»).
 * Соединение — подделка: до него проверка не доходит.
 */
describe('terminateBackends: текст отказа неверного фильтра', () => {
  const connection = {} as never;
  const cyclic = (): unknown => {
    const value: Record<string, unknown> = {};
    value.self = value;
    return value;
  };
  // JSON.stringify бросает на цикле, String() — на значении без прототипа: оба запасных пути разом.
  const cyclicBare = (): unknown => {
    const value = Object.create(null) as Record<string, unknown>;
    value.self = value;
    return value;
  };

  it.each([
    ['state', 'BigInt', (): unknown => BigInt(1), '1'],
    ['applicationName', 'цикл', cyclic, '[object Object]'],
    ['user', 'цикл без прототипа', cyclicBare, '[object Object]'],
  ])('%s: %s — TypeError с текстом', async (field, _label, make, text) => {
    await expect(terminateBackends(connection, { [field]: make() } as never)).rejects.toThrow(
      new TypeError(`${field} — непустая строка, получено ${text}`),
    );
  });

  it.each([
    ['BigInt', (): unknown => BigInt(5), '5'],
    ['список с BigInt', (): unknown => [BigInt(5)], '5'],
    ['строка', (): unknown => '42', '"42"'],
    ['пустой список (контроль: прежний текст)', (): unknown => [], '[]'],
  ])('pid: %s — TypeError с текстом', async (_label, make, text) => {
    await expect(terminateBackends(connection, { pid: make() } as never)).rejects.toThrow(
      new TypeError(`pid соединений — непустой список целых положительных, получено ${text}`),
    );
  });
});
