import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { runInThisContext } from 'node:vm';

import { FakeDnsServer } from '../dns/fake-dns-server';
import { activeResources } from './active-resources';
import { resourcesLeft } from './resources-left';
import { settledResources } from './settled-resources';

/**
 * Таймер, заведённый кодом раннера jest (кадр стека в node_modules/@jest или
 * jest-*), — не ресурс спеки: проверка «освободил всё» его не считает. Код
 * раннера здесь подставлен — функция с именем файла репортера jest; таймер
 * спеки с тем же телом — считается.
 */
const startTimerFrom = (filename: string): (() => NodeJS.Timeout) =>
  runInThisContext('(function start() { return setTimeout(function tick() {}, 60000); })', { filename });

describe('activeResources: таймеры раннера тестов не считаются', () => {
  it('таймер из кода jest не виден, таймер спеки — виден; снятый с учёта (unref) — не виден нигде', () => {
    const before = activeResources().Timeout ?? 0;
    const runner = startTimerFrom(
      '/repo/node_modules/.pnpm/@jest+reporters@30.2.0/node_modules/@jest/reporters/build/index.js',
    )();
    const circus = startTimerFrom('/repo/node_modules/jest-circus/build/index.js')();
    const own = startTimerFrom('/repo/src/postgres/held-transaction.js')();
    try {
      expect((activeResources().Timeout ?? 0) - before).toBe(1);
      runner.unref();
      expect((activeResources().Timeout ?? 0) - before).toBe(1);
      clearTimeout(own);
      expect((activeResources().Timeout ?? 0) - before).toBe(0);
    } finally {
      clearTimeout(runner);
      clearTimeout(circus);
      clearTimeout(own);
    }
  });
});

describe('activeResources: снятый таймер раннера не вычитается из таймеров спеки', () => {
  it('clearTimeout таймера раннера: до события destroy хук ещё видит его, но вычитать его нельзя', () => {
    const before = activeResources().Timeout ?? 0;
    const circus = startTimerFrom('/repo/node_modules/jest-circus/build/index.js')();
    const own = startTimerFrom('/repo/src/postgres/held-transaction.js')();
    try {
      expect((activeResources().Timeout ?? 0) - before).toBe(1);
      clearTimeout(circus);
      expect((activeResources().Timeout ?? 0) - before).toBe(1);
      clearTimeout(own);
      expect((activeResources().Timeout ?? 0) - before).toBe(0);
    } finally {
      clearTimeout(circus);
      clearTimeout(own);
    }
  });
});

describe('activeResources: таймер, заведённый до подключения модуля, не считается', () => {
  // Воркер jest между файлами и прошлый файл того же воркера заводят таймеры раньше, чем спека
  // подключила модуль; такой таймер, сработавший посреди проверки, краснил её на исправном коде.
  it('чужой ранний таймер ушёл — счёт тот же; таймер, заведённый после подключения, — виден', () => {
    const early = setTimeout(() => undefined, 60000);
    try {
      let fresh: typeof import('./active-resources') | undefined;
      jest.isolateModules(() => {
        fresh = require('./active-resources') as typeof import('./active-resources');
      });
      const count = (): number => fresh?.activeResources().Timeout ?? 0;
      const base = count();
      clearTimeout(early);
      expect(count()).toBe(base);
      const own = setTimeout(() => undefined, 60000);
      try {
        expect(count() - base).toBe(1);
      } finally {
        clearTimeout(own);
      }
      expect(count()).toBe(base);
    } finally {
      clearTimeout(early);
    }
  });
});

describe('activeResources: незавершённые запросы dns.Resolver видны', () => {
  it('запрос к молчащему серверу — QUERYWRAP, пока его не отменили; отвеченный и отменённый — не видны', async () => {
    const silent = createSocket('udp4');
    await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', resolve));
    const server = await FakeDnsServer.start({ records: { 'a.test': ['10.0.0.1'] } });
    const resolver = new Resolver({ timeout: 120_000, tries: 1 });
    try {
      const baseline = await settledResources();
      resolver.setServers([server.address]);
      expect(await resolver.resolve4('a.test')).toEqual(['10.0.0.1']);
      expect(await settledResources()).toEqual(baseline);
      resolver.setServers([`127.0.0.1:${silent.address().port}`]);
      const received = new Promise((resolve) => silent.once('message', resolve));
      const pending = resolver.resolve4('a.test');
      pending.catch(() => undefined);
      await received;
      expect(await settledResources()).toEqual({ ...baseline, QUERYWRAP: 1 });
      resolver.cancel();
      await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
      expect(await settledResources()).toEqual(baseline);
    } finally {
      resolver.cancel();
      await server.close();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('resourcesLeft: что осталось сверх базы', () => {
  it('выросшее — на сколько выросло, новое — целиком; убывшее и неизменное — не в счёт', () => {
    expect(
      resourcesLeft(
        { Timeout: 1, PipeWrap: 8, ProcessWrap: 2, TCPSocketWrap: 1 },
        { Timeout: 3, TCPSocketWrap: 1, QUERYWRAP: 1 },
      ),
    ).toEqual({ Timeout: 2, QUERYWRAP: 1 });
    expect(resourcesLeft({ Timeout: 1 }, { Timeout: 1 })).toEqual({});
  });
});
