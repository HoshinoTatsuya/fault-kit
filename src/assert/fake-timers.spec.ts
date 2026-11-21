import { connect, createServer } from 'node:net';

import { expectPendingThrough } from './expect-pending-through';
import { expectSettlesBefore } from './expect-settles-before';
import { FaultAssertionError } from './fault-assertion.error';
import { nextTurn } from './next-turn';
import { turnsDuring } from './turns-during';

/**
 * Под фальшивыми таймерами jest (`jest.useFakeTimers()`) глобальные
 * `setImmediate`, `nextTick` и `queueMicrotask` подменены и без
 * `jest.advanceTimersByTime` не срабатывают. Обороты пакета идут по
 * настоящему циклу событий (`setImmediate` модуля `node:timers`, `nextTick`
 * настоящего процесса): утверждения работают, а не висят до таймаута теста.
 * Потолок каждой проверки — 5 с: прежде они висели.
 */
describe.each([
  ['современные', { legacyFakeTimers: false }],
  ['устаревшие (legacy)', { legacyFakeTimers: true }],
])('фальшивые таймеры jest: %s', (_name, config) => {
  beforeEach(() => {
    jest.useFakeTimers(config);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('nextTurn и окно из оборотов не висят', async () => {
    await nextTurn();
    await expect(expectPendingThrough(new Promise(() => undefined), { turns: 5 })).resolves.toBeUndefined();
    await expect(expectSettlesBefore(new Promise(() => undefined), { turns: 5 })).rejects.toThrow(
      FaultAssertionError,
    );
    expect(await expectSettlesBefore(Promise.resolve('сразу'), { turns: 5 })).toBe('сразу');
  }, 5000);

  it('окно-событие: проверка «окно нулевой длины» и ввод-вывод работают', async () => {
    await expect(expectPendingThrough(new Promise(() => undefined), Promise.resolve())).rejects.toThrow(
      'окно нулевой длины',
    );
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('нет порта');
    }
    const socket = connect(address.port, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      const echo = new Promise<void>((resolve) => {
        socket.once('data', () => resolve());
        socket.write('.');
      });
      await expect(expectPendingThrough(new Promise(() => undefined), echo)).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5000);

  it('turnsDuring считает обороты', async () => {
    const report = await turnsDuring(async () => {
      await nextTurn();
      await nextTurn();
    });
    expect(report.turns).toBe(3);
  }, 5000);
});
