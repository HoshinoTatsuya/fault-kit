/**
 * Заморозить экспортированное значение целиком, со вложенными объектами,
 * массивами и функциями (их свойствами), по ВСЕМ собственным ключам — и
 * символьным, и неперечислимым. `as const` — только тип: без заморозки любая
 * зависимость потребителя переписала бы словарь для всего процесса.
 *
 * Отказ при загрузке — для значений, которые заморозка не защищает:
 * регулярное выражение с флагом g или y (его `lastIndex` — общее изменяемое
 * состояние; без этих флагов `lastIndex` не используется), Set, Map, WeakSet,
 * WeakMap (заморозка не мешает `add`/`set`), Date (`setTime`), типизированные
 * массивы, ArrayBuffer и DataView (байты меняются, а непустой типизированный
 * массив не замораживается вовсе).
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (value instanceof RegExp && (value.global || value.sticky)) {
    throw new Error(
      `регулярное выражение /${value.source}/${value.flags} в замороженном словаре: флаг g или y`,
    );
  }
  const mutable = [Set, Map, WeakSet, WeakMap, Date, ArrayBuffer, DataView].find(
    (kind) => value instanceof kind,
  );
  if (mutable !== undefined || ArrayBuffer.isView(value)) {
    throw new Error(
      `${(value as object).constructor.name} в замороженном словаре: заморозка не мешает изменять его содержимое`,
    );
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return value;
}
