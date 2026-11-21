import { createHook } from 'node:async_hooks';

/**
 * Незавершённые запросы `dns.Resolver` (c-ares, тип `QUERYWRAP`) процесса спеки.
 * `process.getActiveResourcesInfo()` их не показывает (сокеты c-ares — не
 * ресурсы Node), а процесс они держат до потолка резолвера: запрос к
 * молчащему серверу с `timeout: 120_000` держал воркер jest после файла, и
 * jest снимал его силой («worker process has failed to exit gracefully»).
 * Запрос живёт от создания до ответа, отказа или `resolver.cancel()`.
 * Считаются запросы, созданные ПОСЛЕ подключения модуля (хук ставится при
 * импорте): спека импортирует его раньше, чем заводит резолверы, а запрос,
 * поставленный до импорта, — не её (как у `SPEC_TIMERS`).
 */
export const PENDING_DNS_QUERIES: { count(): number } = ((): { count(): number } => {
  const live = new Set<number>();
  createHook({
    init(asyncId, type) {
      if (type === 'QUERYWRAP') {
        live.add(asyncId);
      }
    },
    destroy(asyncId) {
      live.delete(asyncId);
    },
  }).enable();
  return { count: () => live.size };
})();
