import { FaultProxy } from '../tcp/fault-proxy';

/**
 * «Redis отвечает медленно»: прокси к серверу с задержкой `latencyMs` в обе
 * стороны. Клиент подключается к `proxy.host:proxy.port`; задержку можно
 * менять на ходу (`proxy.latency(ms)`), заморозить (`freeze()`) — это
 * обычный `FaultProxy`. Медленным становится только этот путь: остальные
 * клиенты и административное соединение ходят напрямую.
 */
export const slowRedis = async (target: {
  readonly host: string;
  readonly port: number;
  readonly latencyMs: number;
}): Promise<FaultProxy> => {
  const proxy = await FaultProxy.start({ host: target.host, port: target.port });
  try {
    proxy.latency(target.latencyMs);
  } catch (error) {
    await proxy.close();
    throw error;
  }
  return proxy;
};
