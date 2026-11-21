/** Куда проксировать и где слушать. По умолчанию прокси слушает свободный порт 127.0.0.1. */
export interface FaultProxyOptions {
  readonly host: string;
  readonly port: number;
  readonly listenHost?: string;
  readonly listenPort?: number;
}
