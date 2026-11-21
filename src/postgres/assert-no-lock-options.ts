import { valueText } from '../value-text';

/**
 * Держатель без блокировки таблицы (`holdSnapshot`, `idleInTransaction`) не
 * берёт `lockTimeoutMs` и `only`: молча проигнорированная настройка выглядит
 * действующей. Отказ — и для вызывающих из JavaScript, мимо типов.
 */
export const assertNoLockOptions = (options: object, holder: string): void => {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`настройки ${holder} — объект, получено ${valueText(options)}`);
  }
  for (const name of ['lockTimeoutMs', 'only']) {
    if ((options as Record<string, unknown>)[name] !== undefined) {
      throw new TypeError(`${name} не действует на ${holder}: держатель не блокирует таблицу`);
    }
  }
};
