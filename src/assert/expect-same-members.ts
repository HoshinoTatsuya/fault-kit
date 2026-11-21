import { inspect } from 'node:util';

import { FaultAssertionError } from './fault-assertion.error';
import { membersDiff } from './members-diff';

/**
 * Наборы совпадают как мультимножества (см. `membersDiff`); иначе — отказ с
 * расхождением. Текст отказа — `util.inspect`: `JSON.stringify` падал на
 * `BigInt` и печатал `Error` и `Map` как `{}`.
 */
export const expectSameMembers = <T>(
  actual: Iterable<T>,
  expected: Iterable<T>,
  key?: (item: T) => string,
): void => {
  const diff = membersDiff(actual, expected, key);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    const show = (items: readonly T[]): string =>
      inspect(items, { depth: 4, breakLength: Number.POSITIVE_INFINITY });
    throw new FaultAssertionError(
      `наборы не совпадают: не хватает ${show(diff.missing)}, лишние ${show(diff.unexpected)}`,
    );
  }
};
