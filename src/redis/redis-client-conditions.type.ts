/**
 * Условия отбора клиентов `killClients`; складываются через И. `name` — имя
 * соединения (`CLIENT SETNAME`, в ioredis — `connectionName`), `addr` —
 * адрес клиента `ip:port` целиком, как его печатает `CLIENT LIST` (IPv6 — в
 * скобках: `[::1]:59086`), `ip` — только адрес без порта (все соединения с
 * этого адреса: порт клиента эфемерный; IPv6 — со скобками или без),
 * `libName` — имя библиотеки клиента (Redis 7.2+). `id` — непустой список
 * целых положительных; строковые условия — непустые.
 */
export interface RedisClientConditions {
  readonly id?: number | readonly number[];
  readonly name?: string;
  readonly addr?: string;
  readonly ip?: string;
  readonly libName?: string;
}
