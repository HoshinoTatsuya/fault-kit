import { Redis } from 'ioredis';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { closeRedis } from '../testing/close-redis';
import { startEchoServer } from '../testing/echo-server';
import { redisTarget } from '../testing/redis-target';
import { resourcesLeft } from '../testing/resources-left';
import { roundTrips } from '../testing/round-trips';
import { settledResources } from '../testing/settled-resources';
import { RedisFaults } from './redis-faults';
import { RedisPause } from './redis-pause';
import { REDIS_PAUSE_MODE } from './redis-pause-mode.constant';

describe('RedisFaults на настоящем Redis', () => {
  const clients: Redis[] = [];
  const open = (name?: string): Redis => {
    const { host, port } = redisTarget();
    const client = new Redis(port, host, name === undefined ? {} : { connectionName: name });
    client.on('error', () => undefined);
    clients.push(client);
    return client;
  };

  let baseline: Record<string, number>;

  beforeEach(async () => {
    baseline = await settledResources();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => closeRedis(client)));
    // Тест освобождает всё, что открыл: таймер `disconnect()` оборванного клиента держал воркер jest после файла.
    expect(resourcesLeft(baseline, await settledResources())).toEqual({});
  });

  it('pause(write): запись стоит, пока чтение другого клиента проходит 20 раз; unpause — запись проходит', async () => {
    const admin = open();
    const writer = open();
    const reader = open();
    await Promise.all([admin.ping(), writer.ping(), reader.ping()]);
    const pause = await new RedisFaults(admin).pause(60_000, REDIS_PAUSE_MODE.write);
    const write = writer.set('fault-kit:paused', 'written');
    await expectPendingThrough(
      write,
      roundTrips(20, () => reader.get('fault-kit:paused')),
      'SET под паузой',
    );
    await pause.unpause();
    expect(await write).toBe('OK');
    expect(await reader.get('fault-kit:paused')).toBe('written');
  });

  it('pause(all): стоят и чтения, пока эхо-свидетель ответил 50 раз; пауза истекает — команда выполняется', async () => {
    const admin = open();
    const client = open();
    await client.set('fault-kit:all', 'value');
    const echo = await startEchoServer();
    try {
      const pause = await new RedisFaults(admin).pause(1500, REDIS_PAUSE_MODE.all);
      expect(pause.mode).toBe('ALL');
      const read = client.get('fault-kit:all');
      await expectPendingThrough(read, roundTrips(50, echo.roundTrip), 'GET под паузой ALL');
      await pause.unpause();
      expect(await read).toBe('value');
    } finally {
      await echo.close();
    }
  });

  it('pause: неположительная длительность и неизвестный режим — отказ без команды', async () => {
    const faults = new RedisFaults(open());
    await expect(faults.pause(0, REDIS_PAUSE_MODE.write)).rejects.toThrow(RangeError);
    await expect(faults.pause(100, undefined as never)).rejects.toThrow('неизвестный режим паузы: undefined');
    await expect(faults.pause(100, 'READ' as never)).rejects.toThrow('неизвестный режим паузы');
  });

  it('killClients: обрывает ровно подходящих; соседа и административное соединение — нет', async () => {
    const name = `victim-${process.pid}-${Date.now().toString(36)}`;
    const admin = open(name);
    const victim = open(name);
    const bystander = open('bystander');
    const victimId = Number(await victim.call('CLIENT', 'ID'));
    const bystanderId = Number(await bystander.call('CLIENT', 'ID'));
    const adminId = Number(await admin.call('CLIENT', 'ID'));
    const closed = new Promise((resolve) => victim.once('close', resolve));
    expect(await new RedisFaults(admin).killClients({ name })).toEqual([victimId]);
    await closed;
    expect(Number(await victim.call('CLIENT', 'ID'))).not.toBe(victimId);
    expect(Number(await bystander.call('CLIENT', 'ID'))).toBe(bystanderId);
    expect(Number(await admin.call('CLIENT', 'ID'))).toBe(adminId);
  });

  it('killClients по id и адресу; несовпавшее условие — никого', async () => {
    const admin = open();
    const victim = open();
    const id = Number(await victim.call('CLIENT', 'ID'));
    const faults = new RedisFaults(admin);
    const adminId = Number(await admin.call('CLIENT', 'ID'));
    expect(await faults.killClients({ id: adminId })).toEqual([]);
    expect(Number(await admin.call('CLIENT', 'ID'))).toBe(adminId);
    expect(await faults.killClients({ id, name: 'other-name' })).toEqual([]);
    expect(await faults.killClients({ id: [id] })).toEqual([id]);
  });

  it('killClients: пустой фильтр — отказ, а не «оборвать всех»', async () => {
    // Мимо типов (вызов из JavaScript): тип пустой фильтр не пропускает.
    await expect(new RedisFaults(open()).killClients({} as never)).rejects.toThrow('фильтр клиентов пуст');
  });

  it.each([
    ['EVAL скрипта без флага no-writes', (client: Redis) => client.call('EVAL', 'return 1', '0')],
    ['PUBLISH', (client: Redis) => client.publish('fault-kit:channel', 'x')],
    ['PFCOUNT', (client: Redis) => client.pfcount('fault-kit:hll')],
  ])(
    'pause(write) останавливает и %s, пока чтение другого клиента проходит 20 раз',
    async (_name, command) => {
      const admin = open();
      const client = open();
      const reader = open();
      await Promise.all([admin.ping(), client.ping(), reader.ping()]);
      const pause = await new RedisFaults(admin).pause(60_000, REDIS_PAUSE_MODE.write);
      const stalled = command(client);
      await expectPendingThrough(
        stalled,
        roundTrips(20, () => reader.get('fault-kit:paused')),
        'команда под паузой WRITE',
      );
      await pause.unpause();
      await stalled;
    },
  );

  it('pause(write): истёкший ключ невидим для чтения, но не удаляется до снятия паузы', async () => {
    const admin = open();
    const { host, port } = redisTarget();
    const own = new Redis(port, host, { db: 15 });
    own.on('error', () => undefined);
    clients.push(own);
    await own.flushdb();
    const key = `fault-kit:expiring:${process.pid}`;
    await own.set(key, 'v', 'PX', 20);
    const pause = await new RedisFaults(admin).pause(60_000, REDIS_PAUSE_MODE.write);
    try {
      // Пауза, а не замер: срок ключа (20 мс) заведомо истёк за 200 мс.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect({ value: await own.get(key), size: await own.dbsize() }).toEqual({ value: null, size: 1 });
    } finally {
      await pause.unpause();
    }
    expect(await own.get(key)).toBe(null);
    expect(await own.dbsize()).toBe(0);
  });

  it('await using с паузой WRITE снимает её сразу при выходе из блока', async () => {
    const admin = open();
    const writer = open();
    await Promise.all([admin.ping(), writer.ping()]);
    {
      await using pause = await new RedisFaults(admin).pause(60_000, REDIS_PAUSE_MODE.write);
      expect(pause.ms).toBe(60_000);
    }
    expect(await writer.set('fault-kit:after-using', '1')).toBe('OK');
  });

  it('killClients по addr — ровно клиент с этим адресом', async () => {
    const admin = open();
    const victim = open();
    const bystander = open();
    const id = Number(await victim.call('CLIENT', 'ID'));
    const bystanderId = Number(await bystander.call('CLIENT', 'ID'));
    const info = String(await victim.call('CLIENT', 'INFO'));
    const addr = /addr=(\S+)/.exec(info)?.[1] ?? '';
    expect(await new RedisFaults(admin).killClients({ addr })).toEqual([id]);
    expect(Number(await bystander.call('CLIENT', 'ID'))).toBe(bystanderId);
  });

  it('разбор CLIENT LIST по пробелам корректен: сервер не принимает пробелы в имени и lib-name', async () => {
    const client = open();
    await expect(client.call('CLIENT', 'SETNAME', 'a b')).rejects.toThrow(/spaces/i);
    await expect(client.call('CLIENT', 'SETINFO', 'LIB-NAME', 'a b')).rejects.toThrow(/spaces|newlines/i);
  });

  it('killClients по ip — все соединения с адреса, порт не важен', async () => {
    const admin = open();
    const first = open('by-ip');
    const second = open('by-ip');
    const ids = [Number(await first.call('CLIENT', 'ID')), Number(await second.call('CLIENT', 'ID'))];
    const info = String(await first.call('CLIENT', 'INFO'));
    const ip = (/addr=(\S+):\d+/.exec(info)?.[1] ?? '') as string;
    // Административное соединение с того же адреса не обрывается (SKIPME); остальные с адреса — да.
    const killed = await new RedisFaults(admin).killClients({ ip, name: 'by-ip' });
    expect(killed).toEqual([...ids].sort((a, b) => a - b));
  });

  it('killClients по libName — по полю lib-name из CLIENT LIST', async () => {
    const admin = open();
    const victim = open();
    const id = Number(await victim.call('CLIENT', 'ID'));
    await victim.call('CLIENT', 'SETINFO', 'LIB-NAME', `fk-lib-${process.pid}`);
    expect(await new RedisFaults(admin).killClients({ libName: `fk-lib-${process.pid}` })).toEqual([id]);
  });
});

describe('RedisFaults на подделке административного соединения', () => {
  it('libName на сервере без lib-name (Redis < 7.2) — отказ, а не «никого не нашлось»', async () => {
    const calls: string[][] = [];
    const admin = {
      call: async (...args: Array<string | number>): Promise<unknown> => {
        calls.push(args.map(String));
        return 'id=5 addr=127.0.0.1:5000 name=worker\nid=6 addr=127.0.0.1:5001 name=\n';
      },
    };
    await expect(new RedisFaults(admin).killClients({ libName: 'ioredis' })).rejects.toThrow(
      'сервер не сообщает lib-name клиентов',
    );
    expect(await new RedisFaults(admin).killClients({ name: 'nobody' })).toEqual([]);
    expect(calls.every((call) => call[1] === 'LIST')).toBe(true);
  });

  it('id в фильтре: пустой список, NaN, дробь, ноль — отказ без команд', async () => {
    const calls: unknown[] = [];
    const admin = { call: async (...args: Array<string | number>): Promise<unknown> => calls.push(args) };
    for (const id of [[], Number.NaN, 1.5, 0, [3, -1]] as never[]) {
      await expect(new RedisFaults(admin).killClients({ id })).rejects.toThrow(
        'id клиентов — непустой список',
      );
    }
    expect(calls).toEqual([]);
  });

  it('строка CLIENT LIST без числового id — отказ, а не CLIENT KILL ID NaN', async () => {
    const admin = { call: async (): Promise<unknown> => 'id=x name=w\n' };
    await expect(new RedisFaults(admin).killClients({ name: 'w' })).rejects.toThrow('без числового id');
  });

  it('ip без порта: IPv4 и IPv6 в формате сервера (скобки: addr=[::1]:59086 — так печатают Redis 7.4 и 8)', async () => {
    const admin = {
      call: async (...args: Array<string | number>): Promise<unknown> => {
        if (args[1] === 'LIST') {
          return [
            'id=1 addr=10.0.0.1:5000',
            'id=2 addr=10.0.0.11:5001',
            'id=3 addr=[::1]:59086',
            'id=4 addr=10.0.0.1:7000',
            'id=5 addr=[2001:db8::7]:6000',
            'id=6 addr=[::11]:6001',
            '',
          ].join('\n');
        }
        return 1;
      },
    };
    const faults = new RedisFaults(admin);
    expect(await faults.killClients({ ip: '10.0.0.1' })).toEqual([1, 4]);
    expect(await faults.killClients({ ip: '::1' })).toEqual([3]);
    expect(await faults.killClients({ ip: '[::1]' })).toEqual([3]);
    expect(await faults.killClients({ ip: '2001:db8::7' })).toEqual([5]);
    expect(await faults.killClients({ addr: '[::1]:59086' })).toEqual([3]);
  });

  it.each([
    ['name', { name: '' }],
    ['addr', { addr: '' }],
    ['ip', { ip: '' }],
    ['libName', { libName: '' }],
  ])('пустая строка в %s — отказ без команд: name "" оборвал бы всех безымянных', async (field, filter) => {
    const calls: unknown[] = [];
    const admin = {
      call: async (...args: Array<string | number>): Promise<unknown> => {
        calls.push(args);
        return 'id=3 addr=127.0.0.1:5000 name= lib-name=\nid=4 addr=127.0.0.1:5001 name= lib-name=\n';
      },
    };
    await expect(new RedisFaults(admin).killClients(filter)).rejects.toThrow(`${field} — непустая строка`);
    expect(calls).toEqual([]);
  });

  it('RedisPause: конструктор проверяет режим и длительность', () => {
    const admin = { call: async (): Promise<unknown> => 'OK' };
    expect(() => new RedisPause(admin, 'READ' as never, 100)).toThrow('неизвестный режим паузы');
    expect(() => new RedisPause(admin, REDIS_PAUSE_MODE.write, 0)).toThrow(RangeError);
  });

  it('id оборванных — по возрастанию; не оборванный сервером (0) — не в списке', async () => {
    const admin = {
      call: async (...args: Array<string | number>): Promise<unknown> => {
        if (args[1] === 'LIST') {
          return 'id=9 name=w\nid=3 name=w\nid=7 name=w\n';
        }
        return args[3] === 7 ? 0 : 1;
      },
    };
    expect(await new RedisFaults(admin).killClients({ name: 'w' })).toEqual([3, 9]);
  });
});
