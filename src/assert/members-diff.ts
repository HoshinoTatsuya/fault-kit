import type { MembersDiff } from './members-diff.type';
import { membersDiffByEquality } from './members-diff-by-equality';
import { membersDiffByKey } from './members-diff-by-key';

/**
 * Сравнить наборы как МУЛЬТИМНОЖЕСТВА: порядок не важен, кратность важна.
 * Конкурентные доставки приходят в любом порядке, и сравнение массивов
 * краснеет на исправном коде; сравнение множеств без кратности, наоборот,
 * пропускает двойную доставку.
 *
 * Без `key` элементы сравниваются `util.isDeepStrictEqual` (тот же алгоритм,
 * что `assert.deepStrictEqual`): порядок ключей объекта не важен, `NaN`
 * равен `NaN` и не равен `null`, у `Error` сравниваются имя и сообщение, у
 * `Map`/`Set` — содержимое, `BigInt` допустим. Прежний ключ `JSON.stringify`
 * считал разные `Error` и `Map` равными, а `NaN` — равным `null`. Сравнение
 * попарное: O(n·m) — для наборов спек это доли секунды; для тысяч элементов
 * задайте `key` (строку), тогда сравнение по корзинам.
 */
export const membersDiff = <T>(
  actual: Iterable<T>,
  expected: Iterable<T>,
  key?: (item: T) => string,
): MembersDiff<T> =>
  key === undefined ? membersDiffByEquality(actual, expected) : membersDiffByKey(actual, expected, key);
