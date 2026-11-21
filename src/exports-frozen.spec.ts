import { deepFreeze } from './deep-freeze';
import * as dnsEntry from './dns/index';
import * as rootEntry from './index';
import * as postgresEntry from './postgres/index';
import * as processEntry from './process/index';
import * as redisEntry from './redis/index';
import * as tcpEntry from './tcp/index';

/**
 * Каждое экспортированное значение-объект заморожено глубоко: иначе любая
 * зависимость потребителя переписала бы словарь пакета для всего процесса.
 * Set и Map — нарушение всегда (`Object.freeze` не мешает `add`).
 */
const ENTRIES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['.', rootEntry as Record<string, unknown>],
  ['./tcp', tcpEntry as Record<string, unknown>],
  ['./dns', dnsEntry as Record<string, unknown>],
  ['./postgres', postgresEntry as Record<string, unknown>],
  ['./redis', redisEntry as Record<string, unknown>],
  ['./process', processEntry as Record<string, unknown>],
];

const unfrozen = (value: unknown, path: string, seen: Set<unknown>): string[] => {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const own = Object.isFrozen(value) && !(value instanceof Set) && !(value instanceof Map) ? [] : [path];
  return own.concat(...Object.entries(value).map(([key, inner]) => unfrozen(inner, `${path}.${key}`, seen)));
};

describe('экспортированные значения заморожены', () => {
  it.each(ENTRIES)('вход %s: словари и массивы — глубоко', (_entry, api) => {
    const values = Object.entries(api).filter(([, value]) => typeof value === 'object' && value !== null);
    expect(values.flatMap(([name, value]) => unfrozen(value, name, new Set()))).toEqual([]);
  });

  it('выборка не выродилась: словари DROP_MODE, DNS_RCODE, DNS_RECORD_TYPE, LOCK_MODE, REDIS_PAUSE_MODE', () => {
    const objects = ENTRIES.flatMap(([, api]) =>
      Object.entries(api).filter(([, value]) => typeof value === 'object' && value !== null),
    ).map(([name]) => name);
    expect(objects.sort()).toEqual([
      'DNS_RCODE',
      'DNS_RECORD_TYPE',
      'DROP_MODE',
      'LOCK_MODE',
      'REDIS_PAUSE_MODE',
    ]);
  });

  it('deepFreeze: вложенные объекты и массивы; регулярка с g, Set и Map — отказ', () => {
    const value = { list: ['a', { deep: [1] }], nested: { flag: true } };
    deepFreeze(value);
    expect([value, value.list, value.list[1], value.nested].every((item) => Object.isFrozen(item))).toBe(
      true,
    );
    expect(() => deepFreeze({ pattern: /x/g })).toThrow('флаг g');
    expect(() => deepFreeze({ names: new Set(['a']) })).toThrow('Set');
    expect(() => deepFreeze({ byName: new Map() })).toThrow('Map');
    expect(() => deepFreeze({ pattern: /x/i })).not.toThrow();
  });

  it('deepFreeze: символьные и неперечислимые свойства, функции со свойствами — тоже', () => {
    const tag = Symbol('tag');
    const value: Record<string | symbol, unknown> = { [tag]: { inner: [1] } };
    Object.defineProperty(value, 'hidden', { value: { deep: {} }, enumerable: false });
    const fn = Object.assign(() => undefined, { options: { retries: 3 } });
    deepFreeze({ value, fn });
    expect([
      Object.isFrozen(value[tag]),
      Object.isFrozen((value[tag] as { inner: unknown[] }).inner),
      Object.isFrozen((value as { hidden: object }).hidden),
      Object.isFrozen(fn),
      Object.isFrozen(fn.options),
    ]).toEqual([true, true, true, true, true]);
  });

  it.each([
    ['WeakMap', new WeakMap()],
    ['WeakSet', new WeakSet()],
    ['Date', new Date(0)],
    ['Uint8Array', new Uint8Array(2)],
    ['ArrayBuffer', new ArrayBuffer(2)],
    ['DataView', new DataView(new ArrayBuffer(2))],
  ])('deepFreeze: %s — отказ (заморозка не защищает содержимое)', (name, inner) => {
    expect(() => deepFreeze({ inner })).toThrow(`${name} в замороженном словаре`);
  });

  it('deepFreeze: регулярное выражение без g и y — допустимо (lastIndex не используется)', () => {
    const value = { pattern: /x/i };
    expect(deepFreeze(value).pattern.test('X')).toBe(true);
    expect(deepFreeze(value).pattern.test('X')).toBe(true);
  });

  it('deepFreeze: цикл в словаре не уводит в бесконечную рекурсию; примитивы и null — как есть', () => {
    const cyclic: { self?: unknown; list: unknown[] } = { list: [] };
    cyclic.self = cyclic;
    cyclic.list.push(cyclic);
    expect(deepFreeze(cyclic)).toBe(cyclic);
    expect(Object.isFrozen(cyclic.list)).toBe(true);
    expect([deepFreeze(null), deepFreeze(7), deepFreeze('x')]).toEqual([null, 7, 'x']);
  });
});
