/**
 * Адрес клиента из `CLIENT LIST` без порта. Redis печатает IPv6 в скобках
 * (`addr=[::1]:59086` — проверено на 7.4 и 8): скобки снимаются, чтобы
 * `ip: '::1'` совпадал. IPv4 — `10.0.0.1:5000` → `10.0.0.1`.
 */
export const hostOf = (addr: string): string => {
  const host = addr.slice(0, Math.max(0, addr.lastIndexOf(':')));
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
};
