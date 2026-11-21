import { isDeepStrictEqual } from 'node:util';

import type { MembersDiff } from './members-diff.type';

/** Мультимножества попарным `isDeepStrictEqual`: каждый фактический элемент снимает ПЕРВЫЙ равный ожидаемый. */
export const membersDiffByEquality = <T>(actual: Iterable<T>, expected: Iterable<T>): MembersDiff<T> => {
  const pending = [...expected];
  const unexpected: T[] = [];
  for (const item of actual) {
    const at = pending.findIndex((candidate) => isDeepStrictEqual(candidate, item));
    if (at < 0) {
      unexpected.push(item);
    } else {
      pending.splice(at, 1);
    }
  }
  return { missing: pending, unexpected };
};
