import { expectSameMembers } from './expect-same-members';
import { FaultAssertionError } from './fault-assertion.error';
import { membersDiff } from './members-diff';

describe('membersDiff и expectSameMembers', () => {
  it('порядок не важен', () => {
    expect(membersDiff([3, 1, 2], [1, 2, 3])).toEqual({ missing: [], unexpected: [] });
    expect(() => expectSameMembers(['b', 'a'], ['a', 'b'])).not.toThrow();
  });

  it('кратность важна: двойная доставка — лишний элемент', () => {
    expect(membersDiff(['job-1', 'job-1', 'job-2'], ['job-1', 'job-2'])).toEqual({
      missing: [],
      unexpected: ['job-1'],
    });
    expect(membersDiff(['job-1'], ['job-1', 'job-1'])).toEqual({ missing: ['job-1'], unexpected: [] });
  });

  it('объекты сравниваются по содержимому, ключ задаётся', () => {
    expect(membersDiff([{ id: 2 }, { id: 1 }], [{ id: 1 }, { id: 2 }])).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(membersDiff([{ id: 1, at: 'x' }], [{ id: 1, at: 'y' }], (item) => String(item.id))).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(membersDiff([{ id: 1, at: 'x' }], [{ id: 1, at: 'y' }])).toEqual({
      missing: [{ id: 1, at: 'y' }],
      unexpected: [{ id: 1, at: 'x' }],
    });
  });

  it('с ключом кратность тоже важна: двойная доставка по ключу — лишний, недоставка — недостающий', () => {
    const byId = (item: { id: string }): string => item.id;
    expect(membersDiff([{ id: 'a' }, { id: 'a' }], [{ id: 'a' }], byId)).toEqual({
      missing: [],
      unexpected: [{ id: 'a' }],
    });
    expect(membersDiff([{ id: 'a' }], [{ id: 'a' }, { id: 'a' }], byId)).toEqual({
      missing: [{ id: 'a' }],
      unexpected: [],
    });
    expect(membersDiff([{ id: 'b' }], [{ id: 'a' }], byId)).toEqual({
      missing: [{ id: 'a' }],
      unexpected: [{ id: 'b' }],
    });
    expect(() => expectSameMembers(['a', 'a'], ['a'], (item) => item)).toThrow(FaultAssertionError);
    expect(() => expectSameMembers(['a', 'b'], ['b', 'a'], (item) => item)).not.toThrow();
  });

  it('несовпадение — FaultAssertionError с обеими сторонами расхождения', () => {
    expect(() => expectSameMembers([1, 4], [1, 2])).toThrow(FaultAssertionError);
    expect(() => expectSameMembers([1, 4], [1, 2])).toThrow('не хватает [ 2 ], лишние [ 4 ]');
  });

  it('пустой против непустого — расхождение, а не «совпало»', () => {
    expect(() => expectSameMembers([], ['a'])).toThrow("не хватает [ 'a' ]");
  });

  it('по умолчанию — глубокое равенство: разные Error и Map различаются, NaN не равен null', () => {
    expect(() => expectSameMembers([new Error('a')], [new Error('b')])).toThrow(FaultAssertionError);
    expect(() => expectSameMembers([new Map([[1, 2]])], [new Map([[3, 4]])])).toThrow(FaultAssertionError);
    expect(() => expectSameMembers([Number.NaN], [null])).toThrow(FaultAssertionError);
    expect(() => expectSameMembers([new Error('a')], [new Error('a')])).not.toThrow();
    expect(() => expectSameMembers([Number.NaN], [Number.NaN])).not.toThrow();
  });

  it('порядок ключей объекта не важен; BigInt допустим и в тексте отказа', () => {
    expect(() => expectSameMembers([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).not.toThrow();
    expect(() => expectSameMembers([1n], [1n])).not.toThrow();
    expect(() => expectSameMembers([1n], [2n])).toThrow('не хватает [ 2n ], лишние [ 1n ]');
  });

  it('только недостающие (лишних нет) — тоже расхождение; только лишние — тоже', () => {
    expect(() => expectSameMembers(['a'], ['a', 'b'])).toThrow("не хватает [ 'b' ], лишние []");
    expect(() => expectSameMembers(['a', 'b'], ['a'])).toThrow("не хватает [], лишние [ 'b' ]");
  });

  it('совпадение без ключа снимает ровно один равный элемент: кратность важна', () => {
    expect(membersDiff([{ id: 1 }, { id: 1 }], [{ id: 1 }])).toEqual({
      missing: [],
      unexpected: [{ id: 1 }],
    });
    expect(membersDiff([{ id: 1 }], [{ id: 1 }, { id: 1 }])).toEqual({
      missing: [{ id: 1 }],
      unexpected: [],
    });
  });

  /**
   * Корзина ключа пополняется на месте: копия корзины на каждый элемент
   * (`[...корзина, элемент]`) давала квадрат по числу элементов с одним
   * ключом. Число копий считается по обходам массивов (spread обходит
   * итератором), а не по часам: 1000 элементов — прежде 1000 обходов.
   */
  it('с ключом: элементы с одним ключом не копируют корзину на каждый элемент', () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({ id: 'same', index }));
    const expected = [...many, { id: 'other', index: -1 }];
    const iterate = Array.prototype[Symbol.iterator];
    let walks = 0;
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      walks += 1;
      return iterate.call(this);
    } as typeof iterate;
    let diff: ReturnType<typeof membersDiff<{ id: string; index: number }>>;
    try {
      diff = membersDiff(many, expected, (item) => item.id);
    } finally {
      Array.prototype[Symbol.iterator] = iterate;
    }
    expect([diff.missing.length, diff.unexpected.length]).toEqual([1, 0]);
    expect(walks).toBeLessThan(20);
  });

  it('FaultAssertionError — своё имя в отчёте раннера', () => {
    expect(new FaultAssertionError('x').name).toBe('FaultAssertionError');
    expect(String(new FaultAssertionError('x'))).toBe('FaultAssertionError: x');
  });
});
