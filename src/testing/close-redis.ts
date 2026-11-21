import type { Redis } from 'ioredis';

/**
 * Закрыть клиент ioredis так, чтобы после него не осталось ни сокета, ни
 * таймера: QUIT и ожидание 'end' (сокет закрыт).
 *
 * `disconnect()` здесь не годится. Клиента, оборванного сервером
 * (`killClients`), ioredis переподключает; `disconnect()` в это время зовёт
 * `stream.end()` на уже закрытом сокете и ставит таймер `disconnectTimeout`
 * (2 с), который снимается только событием 'close' этого сокета — а оно уже
 * было. Таймер держал воркер jest после файла, и jest снимал его силой;
 * 'end' при этом не приходит вовсе. Поэтому переподключающийся клиент
 * сначала дожидается 'ready' и только потом уходит по QUIT.
 *
 * Два случая, когда 'ready' не наступит никогда:
 * - `lazyConnect` без единой команды (status `wait`): сокета нет —
 *   `disconnect()` закрывает сразу, без таймера, и шлёт 'end';
 * - сервер недоступен (замёрзший прокси, закрытый порт) и `retryStrategy`
 *   не сдаётся: ожидание 'ready' ограничено `readyTimeoutMs`, после него —
 *   `disconnect()` (переподключений больше нет; таймер `disconnectTimeout`
 *   прежнего сокета доживает свои 2 с — это лучше вечного ожидания).
 */
export const closeRedis = async (client: Redis, { readyTimeoutMs = 5_000 } = {}): Promise<void> => {
  if (client.status === 'end') {
    return;
  }
  if (client.status === 'wait') {
    const ended = new Promise((resolve) => client.once('end', resolve));
    client.disconnect();
    await ended;
    return;
  }
  if (client.status !== 'ready') {
    // 'end' вместо 'ready' — клиент без переподключения (retryStrategy вернула null): закрывать нечего.
    const event = await new Promise<'ready' | 'end' | 'timeout'>((resolve) => {
      const ready = (): void => settle('ready');
      const end = (): void => settle('end');
      const timer = setTimeout(() => settle('timeout'), readyTimeoutMs);
      const settle = (name: 'ready' | 'end' | 'timeout'): void => {
        clearTimeout(timer);
        client.off('ready', ready);
        client.off('end', end);
        resolve(name);
      };
      client.on('ready', ready);
      client.on('end', end);
    });
    if (event === 'end') {
      return;
    }
    if (event === 'timeout') {
      client.disconnect();
      return;
    }
  }
  const ended = new Promise((resolve) => client.once('end', resolve));
  // Отказ QUIT (сервер оборвал соединение раньше ответа) — тоже закрытие: дальше ждём 'end'.
  await client.quit().catch(() => undefined);
  await ended;
};
