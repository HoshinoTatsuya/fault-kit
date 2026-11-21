import type { BackendFilter } from './postgres/backend-filter.type';
import type { HolderOptions } from './postgres/holder-options.type';
import type { LockHoldOptions } from './postgres/lock-hold-options.type';
import type { RedisClientFilter } from './redis/redis-client-filter.type';

/**
 * Отказы ТИПОВ: проверяет `pnpm typecheck` (tsc по всем файлам src), а не
 * этот прогон jest — ts-jest здесь типы не проверяет. Неиспользованная
 * директива `@ts-expect-error` — ошибка компиляции: снятое ограничение типа
 * роняет typecheck.
 */
const typeContracts = (lockOptions: LockHoldOptions): unknown[] => {
  // @ts-expect-error пустой фильтр соединений не означает «все»
  const emptyBackend: BackendFilter = {};
  // @ts-expect-error database и anyDatabase вместе противоречат друг другу
  const both: BackendFilter = { database: 'x', anyDatabase: true };
  // @ts-expect-error anyDatabase без условия — тоже пустой фильтр
  const scopeOnly: BackendFilter = { anyDatabase: true };
  // @ts-expect-error пустой фильтр клиентов не означает «все»
  const emptyRedis: RedisClientFilter = {};
  // @ts-expect-error настройки держателя блокировки не передаются держателю без блокировки
  const lockToPlain: HolderOptions = lockOptions;
  const fine: [BackendFilter, BackendFilter, RedisClientFilter, HolderOptions] = [
    { pid: 1 },
    { applicationName: 'worker', anyDatabase: true },
    { ip: '::1' },
    { timeoutMs: 1000 },
  ];
  return [emptyBackend, both, scopeOnly, emptyRedis, lockToPlain, fine];
};

describe('контракты типов', () => {
  it('файл компилируется tsc (pnpm typecheck); здесь — только существование', () => {
    expect(typeof typeContracts).toBe('function');
  });
});
