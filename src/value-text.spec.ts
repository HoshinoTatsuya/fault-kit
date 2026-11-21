import { expectSettlesBefore } from './assert/expect-settles-before';
import { dockerDnsArgs } from './dns/docker-dns-args';
import { FakeDnsServer } from './dns/fake-dns-server';
import { BackendTerminationError } from './postgres/backend-termination.error';
import { holdLock } from './postgres/hold-lock';
import { holdSnapshot } from './postgres/hold-snapshot';
import { LOCK_MODE } from './postgres/lock-mode.constant';
import type { Queryable } from './postgres/queryable.type';
import { terminateBackends } from './postgres/terminate-backends';
import { RedisFaults } from './redis/redis-faults';
import { REDIS_PAUSE_MODE } from './redis/redis-pause-mode.constant';
import { FaultProxy } from './tcp/fault-proxy';
import { valueText } from './value-text';

const STRANGE = [
  ['без прототипа', (): unknown => Object.create(null)],
  [
    'с бросающим toString',
    (): unknown => ({
      toString: () => {
        throw new Error('toString');
      },
    }),
  ],
  [
    'с бросающим Symbol.toPrimitive',
    (): unknown => ({
      [Symbol.toPrimitive]: () => {
        throw new Error('toPrimitive');
      },
    }),
  ],
] as const;

/** Адрес, по которому держатель не соединяется: отказ настроек обязан прийти раньше. */
const NOWHERE = 'postgres://fault-kit@127.0.0.1:1/none';

describe('valueText: текст брошенного значения не бросает', () => {
  it('значение без прототипа — тег объекта', () => {
    expect(valueText(Object.create(null))).toBe('[object Object]');
  });

  it('бросающий toString — message, если это строка', () => {
    const value = {
      message: 'исходная причина',
      toString: () => {
        throw new Error('toString');
      },
    };
    expect(valueText(value)).toBe('исходная причина');
  });

  it('бросающий Symbol.toPrimitive — тег объекта', () => {
    const value = {
      [Symbol.toPrimitive]: () => {
        throw new Error('toPrimitive');
      },
    };
    expect(valueText(value)).toBe('[object Object]');
  });

  it('бросающий геттер message вместе с бросающим toString — запасной текст', () => {
    const value = Object.create(null, {
      message: {
        get: () => {
          throw new Error('message');
        },
      },
    });
    expect(valueText(value)).toBe('[значение без текста]');
  });

  it('обычная ошибка — «Имя: сообщение»', () => {
    expect(valueText(new TypeError('плохой аргумент'))).toBe('TypeError: плохой аргумент');
  });

  it('строка, символ и undefined — как String()', () => {
    expect(valueText('текст')).toBe('текст');
    expect(valueText(Symbol('метка'))).toBe('Symbol(метка)');
    expect(valueText(undefined)).toBe('undefined');
  });
});

/**
 * «Странное» значение — в настройках из JavaScript мимо типов или брошенное
 * соединением вызывающего — доходит до ветки, которая строит текст отказа.
 * Ответ обязан остаться тем же отказом с текстом, а не TypeError вместо него.
 */
describe('«странное» значение в ветке отказа — понятный отказ, а не TypeError', () => {
  describe('tcp', () => {
    let proxy: FaultProxy | undefined;

    afterEach(async () => {
      await proxy?.close();
      proxy = undefined;
    });

    it.each(STRANGE)('FaultProxy.start: port — значение %s', async (_label, make) => {
      await expect(FaultProxy.start({ host: '127.0.0.1', port: make() as number })).rejects.toThrow(
        'port — целое 1..65535, получено [object Object]',
      );
    });

    it.each(STRANGE)('latency, drop, blackholeNew — значение %s', async (_label, make) => {
      proxy = await FaultProxy.start({ host: '127.0.0.1', port: 9 });
      const started = proxy;
      expect(() => started.latency(make() as number)).toThrow('мс от 0 до 2147483647');
      expect(() => started.latency(make() as number)).toThrow('получено [object Object]');
      expect(() => started.drop(make() as never)).toThrow('неизвестный способ обрыва: [object Object]');
      expect(() => started.blackholeNew(make() as boolean)).toThrow(
        'blackholeNew — true или false, получено [object Object]',
      );
    });
  });

  describe('dns', () => {
    let server: FakeDnsServer | undefined;

    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    it.each(STRANGE)('FakeDnsServer.start: host и ttlSeconds — значение %s', async (_label, make) => {
      await expect(FakeDnsServer.start({ host: make() as string })).rejects.toThrow(
        'сервер DNS слушает адрес IP, получено [object Object]',
      );
      await expect(FakeDnsServer.start({ ttlSeconds: make() as number })).rejects.toThrow(
        'TTL — целое от 0 до 2147483647 секунд (TTL — целое неотрицательное), получено [object Object]',
      );
    });

    it.each(STRANGE)('delay и waitForQueries — значение %s', async (_label, make) => {
      server = await FakeDnsServer.start();
      const started = server;
      expect(() => started.delay(make() as number)).toThrow('получено [object Object]');
      await expect(started.waitForQueries(make() as number)).rejects.toThrow(
        'число запросов — целое не меньше 1, получено [object Object]',
      );
    });

    it.each(STRANGE)('dockerDnsArgs: nameserver, attempts, search — значение %s', (_label, make) => {
      expect(() => dockerDnsArgs({ nameserver: make() as string })).toThrow(
        'адрес сервера DNS — IP, получено [object Object]',
      );
      expect(() => dockerDnsArgs({ attempts: make() as number })).toThrow(
        'attempts — целое число не меньше 1, получено [object Object]',
      );
      expect(() => dockerDnsArgs({ search: [make() as string] })).toThrow(
        'домен поиска — имя DNS, получено [object Object]',
      );
    });
  });

  describe('postgres', () => {
    it.each(STRANGE)('holdLock: mode — значение %s', async (_label, make) => {
      await expect(holdLock(NOWHERE, 'jobs', make() as never)).rejects.toThrow(
        'неизвестный режим блокировки: [object Object]',
      );
    });

    it.each(STRANGE)('holdLock: only, timeoutMs, lockTimeoutMs — значение %s', async (_label, make) => {
      await expect(
        holdLock(NOWHERE, 'jobs', LOCK_MODE.accessShare, { only: make() as boolean }),
      ).rejects.toThrow('only — true или false, получено [object Object]');
      await expect(
        holdLock(NOWHERE, 'jobs', LOCK_MODE.accessShare, { timeoutMs: make() as number }),
      ).rejects.toThrow('(потолок таймера Node), получено [object Object]');
      await expect(
        holdLock(NOWHERE, 'jobs', LOCK_MODE.accessShare, { lockTimeoutMs: make() as number }),
      ).rejects.toThrow('lockTimeoutMs — целое неотрицательное число мс, получено [object Object]');
    });

    it('holdSnapshot: настройки — функция с бросающим toString', async () => {
      const options = Object.assign(() => undefined, {
        toString: () => {
          throw new Error('toString');
        },
      });
      await expect(holdSnapshot(NOWHERE, options as never)).rejects.toThrow(
        'настройки holdSnapshot — объект, получено',
      );
    });

    /** Соединение вызывающего: одно соединение-кандидат, снятие отвечает отказом `failure`. */
    const scripted = (failure: () => unknown): Queryable =>
      ({
        query: (text: string) => {
          if (text.includes('server_version_num')) {
            return Promise.resolve({ rows: [{ v: '170000' }] });
          }
          if (text.includes('pg_terminate_backend')) {
            return Promise.reject(failure());
          }
          return Promise.resolve({ rows: [{ pid: 4242, hidden: false }] });
        },
      }) as unknown as Queryable;

    it.each(STRANGE)('terminateBackends: waitMs — значение %s', async (_label, make) => {
      await expect(
        terminateBackends(
          scripted(() => new Error('не должен вызываться')),
          { applicationName: 'x' },
          {
            waitMs: make() as number,
          },
        ),
      ).rejects.toThrow('waitMs — целое положительное число мс, получено [object Object]');
    });

    it.each([...STRANGE, ['null', (): unknown => null] as const])(
      'terminateBackends: соединение отказало значением %s — BackendTerminationError с текстом',
      async (_label, make) => {
        const failure = await terminateBackends(scripted(make), { applicationName: 'x' }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(BackendTerminationError);
        const termination = failure as BackendTerminationError;
        expect({
          message: termination.message,
          code: termination.code,
          terminated: termination.terminated,
          failed: termination.failed,
        }).toEqual({
          message: `сервер отказал в снятии соединения 4242 (без кода): ${make() === null ? 'null' : '[object Object]'}; уже сняты: []`,
          code: undefined,
          terminated: [],
          failed: [4242],
        });
      },
    );
  });

  describe('redis и утверждения', () => {
    const admin = { call: () => Promise.reject(new Error('не должен вызываться')) };

    it.each(STRANGE)('RedisFaults.pause: ms и mode — значение %s', async (_label, make) => {
      const faults = new RedisFaults(admin);
      await expect(faults.pause(make() as number, REDIS_PAUSE_MODE.all)).rejects.toThrow(
        'длительность паузы — целое положительное число мс, получено [object Object]',
      );
      await expect(faults.pause(1000, make() as never)).rejects.toThrow(
        'неизвестный режим паузы: [object Object]',
      );
    });

    it.each(STRANGE)('expectSettlesBefore: turns — значение %s', async (_label, make) => {
      await expect(expectSettlesBefore(Promise.resolve(1), { turns: make() as number })).rejects.toThrow(
        'число оборотов — целое неотрицательное, получено [object Object]',
      );
    });
  });
});
