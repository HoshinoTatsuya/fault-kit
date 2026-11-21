import type { MembersDiff } from './members-diff.type';

/** Мультимножества по корзинам строкового ключа: O(n + m). */
export const membersDiffByKey = <T>(
  actual: Iterable<T>,
  expected: Iterable<T>,
  key: (item: T) => string,
): MembersDiff<T> => {
  const pending = new Map<string, T[]>();
  for (const item of expected) {
    const id = key(item);
    // Пополнение на месте: копия корзины на каждый элемент — квадрат по числу элементов с одним ключом.
    const bucket = pending.get(id);
    if (bucket === undefined) {
      pending.set(id, [item]);
    } else {
      bucket.push(item);
    }
  }
  const unexpected: T[] = [];
  for (const item of actual) {
    const bucket = pending.get(key(item));
    if (bucket === undefined || bucket.length === 0) {
      unexpected.push(item);
    } else {
      bucket.pop();
    }
  }
  return { missing: [...pending.values()].flat(), unexpected };
};
