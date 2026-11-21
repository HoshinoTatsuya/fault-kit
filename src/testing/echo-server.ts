import { connect, createServer, type Socket } from 'node:net';

/**
 * Эхо-сервер TCP на свободном порту 127.0.0.1 — цель для прокси без внешних
 * зависимостей и свидетель окна (`roundTrip()` — одно эхо по своему
 * соединению). `whenConnections(n)` — событие «у сервера ровно n соединений»:
 * серверная сторона закрывается позже клиентской, и проверка ресурсов
 * процесса без этого события видела бы чужой, ещё не закрытый сокет.
 */
export const startEchoServer = async (): Promise<{
  port: number;
  roundTrip(): Promise<{ sent: string; received: string }>;
  whenConnections(count: number): Promise<void>;
  close(): Promise<void>;
}> => {
  const sockets = new Set<Socket>();
  let waiters: Array<{ count: number; resolve(): void }> = [];
  const changed = (): void => {
    waiters = waiters.filter((waiter) => {
      if (sockets.size === waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    changed();
    socket.on('close', () => {
      sockets.delete(socket);
      changed();
    });
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('эхо-сервер без порта');
  }
  const whenConnections = (count: number): Promise<void> =>
    sockets.size === count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ count, resolve }));
  const witness = connect(address.port, '127.0.0.1');
  // Каждый roundTrip шлёт кадр со своим номером («7\n») и ждёт эхо ИМЕННО этого кадра: параллельные
  // вызовы не делят ответ, и чужой ответ виден (разрешение несёт отправленное и полученное).
  // Разрыв свидетеля — отказ всех ждущих, а не вечное ожидание.
  const pendingEchoes = new Map<
    string,
    { resolve(echo: { sent: string; received: string }): void; reject(error: Error): void }
  >();
  let nextFrame = 0;
  let partial = '';
  let witnessClosed = false;
  // Кадры — номера (ASCII), но декодирование потоковое, как у всех читателей пакета: кусок не режет символ.
  witness.setEncoding('utf8');
  witness.on('data', (chunk: string) => {
    const frames = (partial + chunk).split('\n');
    partial = frames.pop() ?? '';
    for (const frame of frames) {
      pendingEchoes.get(frame)?.resolve({ sent: frame, received: frame });
      pendingEchoes.delete(frame);
    }
  });
  witness.on('error', () => undefined);
  witness.on('close', () => {
    witnessClosed = true;
    for (const waiter of pendingEchoes.values()) {
      waiter.reject(new Error('свидетель эхо-сервера закрыт'));
    }
    pendingEchoes.clear();
  });
  await new Promise<void>((resolve, reject) => {
    witness.once('connect', () => resolve());
    witness.once('close', () => reject(new Error('свидетель не подключился к эхо-серверу')));
  });
  await whenConnections(1);
  return {
    port: address.port,
    roundTrip: () => {
      if (witnessClosed) {
        return Promise.reject(new Error('свидетель эхо-сервера закрыт'));
      }
      nextFrame += 1;
      const frame = String(nextFrame);
      return new Promise<{ sent: string; received: string }>((resolve, reject) => {
        pendingEchoes.set(frame, {
          resolve: (echo) => resolve({ sent: frame, received: echo.received }),
          reject,
        });
        witness.write(`${frame}\n`);
      });
    },
    whenConnections,
    close: async () => {
      witness.destroy();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
