import { connect, type Socket } from 'node:net';

/**
 * Клиент TCP с журналом событий: всё, что с ним случилось (`error:<код>`,
 * `end`, `close`), видно утверждению. Данные копятся БАЙТАМИ (`bytes()`;
 * `received()` — они же строкой UTF-8): бинарный протокол не искажается, а
 * `receive(n)` ждёт n БАЙТ, не символов. Соединение закрылось раньше, чем
 * пришло n байт, — отказ с тем, что пришло (а не вечное ожидание). Отказ
 * подключения — отказ создания клиента. `allowHalfOpen` — клиент, который
 * после FIN собеседника сам не закрывается.
 */
export const loggedClient = async (
  port: number,
  options: { readonly allowHalfOpen?: boolean } = {},
): Promise<{
  socket: Socket;
  events: string[];
  received(): string;
  bytes(): Buffer;
  receive(bytes: number): Promise<string>;
  closed: Promise<void>;
}> => {
  const socket = connect({ port, host: '127.0.0.1', allowHalfOpen: options.allowHalfOpen ?? false });
  const events: string[] = [];
  let data = Buffer.alloc(0);
  let finished = false;
  let waiters: Array<{ bytes: number; resolve(text: string): void; reject(error: Error): void }> = [];
  const settle = (): void => {
    waiters = waiters.filter((waiter) => {
      if (data.length >= waiter.bytes) {
        waiter.resolve(data.toString());
        return false;
      }
      if (finished) {
        waiter.reject(new Error(`соединение закрыто: пришло ${data.length} байт из ${waiter.bytes}`));
        return false;
      }
      return true;
    });
  };
  socket.on('data', (chunk: Buffer) => {
    data = Buffer.concat([data, chunk]);
    settle();
  });
  socket.on('error', (error: NodeJS.ErrnoException) => events.push(`error:${error.code}`));
  socket.on('end', () => events.push('end'));
  const closed = new Promise<void>((resolve) =>
    socket.on('close', () => {
      events.push('close');
      finished = true;
      settle();
      resolve();
    }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('close', () =>
      reject(new Error(`подключение к 127.0.0.1:${port} не удалось: ${events.join(', ')}`)),
    );
  });
  return {
    socket,
    events,
    closed,
    received: () => data.toString(),
    bytes: () => data,
    receive: (bytes) =>
      new Promise<string>((resolve, reject) => {
        waiters.push({ bytes, resolve, reject });
        settle();
      }),
  };
};
