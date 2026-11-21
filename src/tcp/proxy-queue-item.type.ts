/**
 * Событие направления в очереди: кусок данных, FIN источника (`end`) или
 * обрыв источника без FIN (`reset`: RST, отказ подключения, уничтожение
 * сокета). Закрытие стоит в той же очереди, что и данные: под заморозкой оно
 * не доходит, под задержкой приходит ПОСЛЕ данных, отправленных раньше него.
 */
export type ProxyQueueItem =
  | { readonly kind: 'data'; readonly chunk: Buffer; readonly arrivedAt: number }
  | { readonly kind: 'end' | 'reset'; readonly arrivedAt: number };
