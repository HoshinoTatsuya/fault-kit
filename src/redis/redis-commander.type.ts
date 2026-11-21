/**
 * Соединение, которым выполняются административные команды: `ioredis`
 * (`Redis`, узел `Cluster`) или любой клиент с тем же `call`. Пакет `ioredis`
 * не импортирует — ставится без него.
 */
export interface RedisCommander {
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
}
