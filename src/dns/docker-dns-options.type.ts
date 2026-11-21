/**
 * Резолвер контейнера. `timeoutSeconds` и `attempts` — опции resolv.conf
 * (`timeout:N`, `attempts:N`): сколько getaddrinfo ждёт ответа на каждую
 * попытку и сколько попыток делает. Не заданы — умолчания glibc (5 с × 2).
 */
export interface DockerDnsOptions {
  readonly nameserver?: string;
  readonly timeoutSeconds?: number;
  readonly attempts?: number;
  /** `ndots:N` — сколько точек в имени, чтобы сначала пробовать его как полное (0..15). */
  readonly ndots?: number;
  /** Домены поиска (`--dns-search`): короткое имя дополняется ими по порядку. */
  readonly search?: readonly string[];
}
