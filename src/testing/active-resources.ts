import { PENDING_DNS_QUERIES } from './pending-dns-queries';
import { SPEC_TIMERS } from './spec-timers';

/**
 * Открытые ресурсы процесса (таймеры, сокеты, серверы, незавершённые запросы
 * `dns.Resolver` — `QUERYWRAP`) мультимножеством «тип → сколько»; таймеры —
 * только заведённые кодом спеки (`SPEC_TIMERS`). Сравнение до и после — проверка «примитив
 * освободил всё»: висящий таймер, сокет или запрос держал бы процесс спеки
 * живым после прогона.
 */
export const activeResources = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const timeouts = SPEC_TIMERS.refCount();
  if (timeouts > 0) {
    counts.Timeout = timeouts;
  } else {
    delete counts.Timeout;
  }
  const queries = PENDING_DNS_QUERIES.count();
  if (queries > 0) {
    counts.QUERYWRAP = queries;
  }
  return counts;
};
