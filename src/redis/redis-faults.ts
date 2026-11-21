import { assertPauseArgs } from './assert-pause-args';
import { hostOf } from './host-of';
import { parseClientList } from './parse-client-list';
import type { RedisClientFilter } from './redis-client-filter.type';
import type { RedisCommander } from './redis-commander.type';
import { RedisPause } from './redis-pause';
import type { RedisPauseMode } from './redis-pause-mode.type';

/**
 * Отказы сервера Redis через административное соединение: пауза всех
 * клиентов и обрыв выбранных. Соединение `admin` — отдельное от проверяемого
 * клиента: оно само не обрывается и в фильтр не попадает.
 */
export class RedisFaults {
  public constructor(private readonly _admin: RedisCommander) {}

  /**
   * `CLIENT PAUSE ms mode`: сервер жив, соединения открыты, команды не
   * исполняются — так выглядит долгий fork для снимка, failover, перегруз.
   * Режим обязателен: `all` останавливает и само административное
   * соединение, досрочно не снимается (`unpause()` и `await using` ждут всю
   * паузу); `write` снимается сразу (см. `REDIS_PAUSE_MODE`).
   */
  public async pause(ms: number, mode: RedisPauseMode): Promise<RedisPause> {
    assertPauseArgs(ms, mode);
    await this._admin.call('CLIENT', 'PAUSE', ms, mode);
    return new RedisPause(this._admin, mode, ms);
  }

  /**
   * Оборвать клиентов, подходящих под фильтр (`CLIENT KILL ID` каждому), —
   * как рестарт сервера или сброс соединений балансировщиком. Возвращает id
   * оборванных по возрастанию. Административное соединение не обрывается
   * никогда: `CLIENT KILL ID` по умолчанию `SKIPME yes`, сервер сам не
   * убивает вызывающего (своя проверка рядом была бы вторым рубежом, который
   * не отличить мутацией, — спека проверяет поведение сервера). Пустой
   * фильтр и пустая строка в условии — отказ: «оборвать всех» пишется
   * условием явно. `ip` — без порта; IPv6 — с квадратными скобками или без
   * (`'::1'` и `'[::1]'`), `addr` — как печатает `CLIENT LIST`
   * (`[::1]:59086`).
   */
  public async killClients(filter: RedisClientFilter): Promise<readonly number[]> {
    if (
      [filter.id, filter.name, filter.addr, filter.ip, filter.libName].every(
        (condition) => condition === undefined,
      )
    ) {
      throw new TypeError('фильтр клиентов пуст: задайте id, name, addr, ip или libName');
    }
    for (const [field, value] of Object.entries({
      name: filter.name,
      addr: filter.addr,
      ip: filter.ip,
      libName: filter.libName,
    })) {
      if (value !== undefined && (typeof value !== 'string' || value === '')) {
        // Пустая строка — не условие: name '' совпал бы со всеми безымянными клиентами, то есть почти со всеми.
        throw new TypeError(`${field} — непустая строка, получено ${JSON.stringify(value)}`);
      }
    }
    // IPv6 можно задать и в скобках, как его печатает CLIENT LIST.
    const ip = filter.ip === undefined ? undefined : hostOf(`${filter.ip}:0`);
    const ids =
      filter.id === undefined ? undefined : typeof filter.id === 'number' ? [filter.id] : [...filter.id];
    if (ids !== undefined && (ids.length === 0 || !ids.every((id) => Number.isSafeInteger(id) && id >= 1))) {
      throw new TypeError(
        `id клиентов — непустой список целых положительных, получено ${JSON.stringify(filter.id)}`,
      );
    }
    const clients = parseClientList(String(await this._admin.call('CLIENT', 'LIST')));
    const malformed = clients.filter((client) => !/^\d+$/.test(client.id ?? ''));
    if (malformed.length > 0) {
      throw new Error(`CLIENT LIST вернул строку без числового id: ${JSON.stringify(malformed[0])}`);
    }
    if (filter.libName !== undefined && clients.some((client) => !('lib-name' in client))) {
      throw new Error(
        'сервер не сообщает lib-name клиентов (Redis старше 7.2): фильтр по libName молча не нашёл бы никого',
      );
    }
    const victims = clients
      .filter((client) => ids === undefined || ids.includes(Number(client.id)))
      .filter((client) => filter.name === undefined || client.name === filter.name)
      .filter((client) => filter.addr === undefined || client.addr === filter.addr)
      .filter((client) => ip === undefined || hostOf(client.addr ?? '') === ip)
      .filter((client) => filter.libName === undefined || client['lib-name'] === filter.libName)
      .map((client) => Number(client.id));
    const killed: number[] = [];
    for (const id of victims) {
      if (Number(await this._admin.call('CLIENT', 'KILL', 'ID', id)) === 1) {
        killed.push(id);
      }
    }
    return Object.freeze(killed.sort((a, b) => a - b));
  }
}
