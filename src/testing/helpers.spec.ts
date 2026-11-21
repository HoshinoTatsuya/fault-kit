import { createServer, type Server, type Socket } from 'node:net';

import { startEchoServer } from './echo-server';
import { loggedClient } from './logged-client';
import { pgTarget } from './pg-target';
import { redisTarget } from './redis-target';
import { roundTrips } from './round-trips';

/** Помощники спек сами не должны висеть и искажать: на них стоят утверждения всего пакета. */
const serve = async (
  onSocket: (socket: Socket) => void,
): Promise<{ port: number; close(): Promise<void> }> => {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('нет порта');
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe('помощники спек', () => {
  it('loggedClient: недобор байт и закрытие — отказ с тем, что пришло, а не вечное ожидание', async () => {
    const server = await serve((socket) => socket.end('abc'));
    try {
      const client = await loggedClient(server.port);
      await expect(client.receive(10)).rejects.toThrow('соединение закрыто: пришло 3 байт из 10');
    } finally {
      await server.close();
    }
  });

  it('loggedClient: данные — байты; receive считает байты, а не символы', async () => {
    const payload = Buffer.from([0xff, 0x00, 0xd0, 0xb6]);
    const server = await serve((socket) => socket.write(payload));
    try {
      const client = await loggedClient(server.port);
      expect(await client.receive(4)).toBe(payload.toString());
      expect(client.bytes()).toEqual(payload);
      client.socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('loggedClient: отказ подключения — отказ, а не вечное ожидание', async () => {
    const server = await serve(() => undefined);
    const { port } = server;
    await server.close();
    await expect(loggedClient(port)).rejects.toThrow(`подключение к 127.0.0.1:${port} не удалось`);
  });

  it('эхо-сервер: параллельные roundTrip — каждый получает ответ на СВОЙ кадр; закрытие — отказ ждущих', async () => {
    const echo = await startEchoServer();
    const echoes = await Promise.all(Array.from({ length: 50 }, () => echo.roundTrip()));
    expect(echoes.every((one) => one.received === one.sent)).toBe(true);
    expect(new Set(echoes.map((one) => one.sent)).size).toBe(50);
    const pending = echo.roundTrip();
    await echo.close();
    await expect(pending).rejects.toThrow('свидетель эхо-сервера закрыт');
    await expect(echo.roundTrip()).rejects.toThrow('свидетель эхо-сервера закрыт');
  });

  it('roundTrips: число — целое не меньше 1', async () => {
    await expect(roundTrips(0, async () => undefined)).rejects.toThrow('число обращений свидетеля');
    await expect(roundTrips(1.5, async () => undefined)).rejects.toThrow(RangeError);
  });

  it('адреса тестовых серверов: IPv6 — без скобок, как ждёт net.connect', () => {
    const saved = { pg: process.env.PG_TEST_URL, redis: process.env.REDIS_TEST_URL };
    try {
      process.env.PG_TEST_URL = 'postgres://u:p@[::1]:6543/db';
      process.env.REDIS_TEST_URL = 'redis://[::1]:7000';
      expect({ pg: pgTarget(), redis: redisTarget() }).toEqual({
        pg: { url: 'postgres://u:p@[::1]:6543/db', host: '::1', port: 6543 },
        redis: { host: '::1', port: 7000 },
      });
    } finally {
      for (const [key, value] of [
        ['PG_TEST_URL', saved.pg],
        ['REDIS_TEST_URL', saved.redis],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
