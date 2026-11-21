/** Где слушать и что отвечать. По умолчанию — свободный порт 127.0.0.1, записей нет (любое имя — NXDOMAIN). */
export interface FakeDnsServerOptions {
  readonly host?: string;
  /** 0 — свободный порт, один и тот же для UDP и TCP. 53 — для getaddrinfo в контейнере (см. `dockerDnsArgs`). */
  readonly port?: number;
  /** Имя → адреса IPv4/IPv6. Запрос A отдаёт адреса IPv4 имени, AAAA — IPv6. */
  readonly records?: Readonly<Record<string, readonly string[]>>;
  readonly ttlSeconds?: number;
}
