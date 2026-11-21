/** Запрос, дошедший до сервера, — независимо от того, ответил ли сервер. */
export interface DnsQueryRecord {
  readonly name: string;
  readonly type: number;
  readonly transport: 'udp' | 'tcp';
}
