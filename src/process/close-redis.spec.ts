import { Redis } from 'ioredis';

import { closeRedis } from '../testing/close-redis';

/**
 * Помощник спек `closeRedis` на клиентах, которые никогда не станут 'ready'.
 * Без сервера: контейнер спек процессов идёт без сети (`--network none`),
 * порт 1 на 127.0.0.1 отвечает отказом. Здесь, а не рядом с помощником:
 * спеки с реальными таймерами переподключения — в одноразовом контейнере.
 */
const settleOrHang = async (pending: Promise<void>, ms: number): Promise<string> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending.then(() => 'закрыт'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('висит'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe('closeRedis: клиент, который не станет ready', () => {
  it('lazyConnect без единой команды (status wait) — закрыт сразу, а не ждёт ready', async () => {
    const client = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true });
    expect(client.status).toBe('wait');
    expect(await settleOrHang(closeRedis(client), 3_000)).toBe('закрыт');
    expect(client.status).toBe('end');
  });

  it('переподключается к недоступному серверу — закрыт по потолку ожидания, попыток после закрытия нет', async () => {
    let attempts = 0;
    const client = new Redis({
      host: '127.0.0.1',
      port: 1,
      retryStrategy: () => 20,
      maxRetriesPerRequest: null,
    });
    client.on('error', () => undefined);
    client.on('connecting', () => {
      attempts += 1;
    });
    expect(await settleOrHang(closeRedis(client), 10_000)).toBe('закрыт');
    const after = attempts;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(attempts).toBe(after);
    expect(client.status).not.toBe('ready');
  }, 20_000);
});
