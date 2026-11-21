import { isIPv4, isIPv6 } from 'node:net';
import { valueText } from '../value-text';
import type { DockerDnsOptions } from './docker-dns-options.type';

/**
 * Аргументы `docker run`, которые направляют getaddrinfo контейнера на
 * заданный адрес. По умолчанию — 127.0.0.1 ВНУТРИ контейнера: там процесс
 * спеки сам поднимает `FakeDnsServer` на порту 53 и управляет ответами
 * (молчание, задержка, адреса), и ни один пакет не уходит из контейнера.
 *
 * Вариант «DNS в никуда» для образа, где свой сервер не поднять, —
 * `nameserver` с адресом, пакеты на который сеть теряет (не отвечающий узел
 * частной сети). Он зависит от сети хоста: где маршрута нет, ядро ответит
 * «недоступно» сразу, и getaddrinfo откажет мгновенно, а не зависнет.
 *
 * Домены поиска хоста в контейнер не попадают: без `search` — `--dns-search .`.
 *
 * Работает на сети bridge по умолчанию (resolv.conf пишется как есть); в
 * пользовательской сети docker отвечает встроенным DNS 127.0.0.11 и
 * пересылает запросы — заданный адрес будет вышестоящим, а не первым.
 */
export const dockerDnsArgs = (options: DockerDnsOptions = {}): readonly string[] => {
  const nameserver = options.nameserver ?? '127.0.0.1';
  if (typeof nameserver !== 'string' || (!isIPv4(nameserver) && !isIPv6(nameserver))) {
    throw new TypeError(`адрес сервера DNS — IP, получено ${valueText(nameserver)}`);
  }
  const args = ['--dns', nameserver];
  for (const [option, value, min] of [
    ['timeout', options.timeoutSeconds, 1],
    ['attempts', options.attempts, 1],
    ['ndots', options.ndots, 0],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(value) || value < min || (option === 'ndots' && value > 15)) {
      throw new RangeError(`${option} — целое число не меньше ${min}, получено ${valueText(value)}`);
    }
    args.push('--dns-option', `${option}:${value}`);
  }
  const search = options.search ?? [];
  if (search.length === 0) {
    // Без своего списка docker передал бы контейнеру домены поиска ХОСТА: на облачной машине
    // getaddrinfo после отказа повторял имя с их суффиксом (silent.test.<регион>.compute.internal)
    // — набор запросов и время ожидания зависели от машины. `.` — «доменов поиска нет».
    args.push('--dns-search', '.');
  }
  for (const domain of search) {
    if (
      typeof domain !== 'string' ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain)
    ) {
      throw new TypeError(`домен поиска — имя DNS, получено ${valueText(domain)}`);
    }
    args.push('--dns-search', domain);
  }
  return Object.freeze(args);
};
