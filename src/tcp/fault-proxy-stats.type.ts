/**
 * Счётчики прокси с момента старта. Байты — ПЕРЕДАННЫЕ дальше, а не принятые:
 * во время заморозки они не растут, хотя клиент пишет. Передано — запись в
 * сокет приёмника завершилась (колбэк записи без ошибки): отданное сокету
 * цели, который так и не подключился, не считается.
 */
export interface FaultProxyStats {
  /** Принято клиентских соединений всего (включая поглощённые). */
  readonly accepted: number;
  /** Открытых клиентских соединений сейчас. */
  readonly active: number;
  /** Соединений, поглощённых `blackholeNew()` с момента старта (накопительно, как `accepted`). */
  readonly blackholed: number;
  readonly bytesToUpstream: number;
  readonly bytesToClient: number;
  /** Байт, стоящих сейчас в очередях направлений (заморозка, задержка, обратное давление). */
  readonly queuedToUpstream: number;
  readonly queuedToClient: number;
}
