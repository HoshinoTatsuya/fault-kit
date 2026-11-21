import { isIPv6 } from 'node:net';

/** `host:port` для `Resolver.setServers`; IPv6 — в квадратных скобках. */
export const dnsServerAddress = (host: string, port: number): string =>
  isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
