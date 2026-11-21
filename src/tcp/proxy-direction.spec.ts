import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { ProxyDirection } from './proxy-direction';
import type { ProxyState } from './proxy-state.type';
import { QUEUE_HIGH_WATER_BYTES } from './queue-high-water.constant';

/** Сокет-подделка: журнал вызовов вместо сети. `writeResult` — что вернёт `write()` (false — буфер полон). */
class FakeSocket extends EventEmitter {
  public destroyed = false;
  public connecting = false;
  public paused = false;
  public writeResult = true;
  public readonly calls: string[] = [];

  /** Ошибка, с которой завершается запись (колбэк записи), — как у сокета, так и не подключившегося к цели. */
  public writeError: Error | undefined;

  public write(chunk: Buffer, done?: (error?: Error | null) => void): boolean {
    this.calls.push(`write:${chunk.toString()}`);
    done?.(this.writeError ?? null);
    return this.writeResult;
  }

  public end(): void {
    this.calls.push('end');
  }

  public resetAndDestroy(): void {
    this.calls.push('reset');
    this.destroyed = true;
  }

  public destroy(): void {
    this.calls.push('destroy');
    this.destroyed = true;
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
  }
}

const setup = (
  state: ProxyState = { frozen: false, latencyMs: 0 },
): { from: FakeSocket; to: FakeSocket; direction: ProxyDirection; forwarded: number[] } => {
  const from = new FakeSocket();
  const to = new FakeSocket();
  const forwarded: number[] = [];
  const direction = new ProxyDirection(from as unknown as Socket, to as unknown as Socket, state, (bytes) =>
    forwarded.push(bytes),
  );
  return { from, to, direction, forwarded };
};

describe('ProxyDirection (сокеты-подделки)', () => {
  it('запись завершилась ошибкой (цель не подключилась) — байты не считаются переданными', () => {
    const { from, to, forwarded } = setup();
    to.writeError = new Error('ECONNREFUSED');
    from.emit('data', Buffer.from('lost'));
    expect([to.calls, forwarded]).toEqual([['write:lost'], []]);
  });

  it('данные, затем FIN источника — в том же порядке; счётчик — переданные байты', () => {
    const { from, to, forwarded } = setup();
    from.emit('data', Buffer.from('ab'));
    from.emit('data', Buffer.from('cde'));
    from.emit('end');
    from.emit('close', false);
    expect(to.calls).toEqual(['write:ab', 'write:cde', 'end']);
    expect(forwarded).toEqual([2, 3]);
  });

  it('обрыв источника без FIN — RST приёмнику ПОСЛЕ данных, отправленных раньше', () => {
    const { from, to } = setup();
    from.emit('data', Buffer.from('ответ'));
    from.emit('close', true);
    expect(to.calls).toEqual(['write:ответ', 'reset']);
  });

  it('обрыв источника, пока приёмник ещё подключается, — destroy (RST слать некуда)', () => {
    const { from, to } = setup();
    to.connecting = true;
    from.emit('close', true);
    expect(to.calls).toEqual(['destroy']);
  });

  it('под заморозкой не идут ни данные, ни FIN, ни RST; разморозка отдаёт всё по порядку', () => {
    const state: ProxyState = { frozen: true, latencyMs: 0 };
    const { from, to, direction } = setup(state);
    from.emit('data', Buffer.from('x'));
    from.emit('end');
    expect(to.calls).toEqual([]);
    expect(from.paused).toBe(true);
    state.frozen = false;
    direction.pump();
    expect(to.calls).toEqual(['write:x', 'end']);
    expect(from.paused).toBe(false);
  });

  it('RST под заморозкой стоит в очереди до разморозки', () => {
    const state: ProxyState = { frozen: true, latencyMs: 0 };
    const { from, to, direction } = setup(state);
    from.emit('close', true);
    expect(to.calls).toEqual([]);
    state.frozen = false;
    direction.pump();
    expect(to.calls).toEqual(['reset']);
  });

  it('write() === false останавливает передачу до drain: в буфер сокета уходит один кусок, а не вся очередь', () => {
    const { from, to, direction } = setup();
    to.writeResult = false;
    from.emit('data', Buffer.from('1'));
    from.emit('data', Buffer.from('2'));
    from.emit('data', Buffer.from('3'));
    expect(to.calls).toEqual(['write:1']);
    expect(from.paused).toBe(true);
    expect(direction.queuedBytes).toBe(2);
    to.emit('drain');
    expect(to.calls).toEqual(['write:1', 'write:2']);
    to.writeResult = true;
    to.emit('drain');
    expect(to.calls).toEqual(['write:1', 'write:2', 'write:3']);
    expect(from.paused).toBe(false);
    expect(direction.queuedBytes).toBe(0);
  });

  it('очередь дошла до потолка — источник на паузе; ниже потолка — снова читается', () => {
    const state: ProxyState = { frozen: false, latencyMs: 60_000 };
    const { from, direction } = setup(state);
    from.emit('data', Buffer.alloc(QUEUE_HIGH_WATER_BYTES - 1));
    expect(from.paused).toBe(false);
    from.emit('data', Buffer.alloc(1));
    expect(from.paused).toBe(true);
    expect(direction.queuedBytes).toBe(QUEUE_HIGH_WATER_BYTES);
    state.latencyMs = 0;
    direction.pump();
    expect(from.paused).toBe(false);
    expect(direction.queuedBytes).toBe(0);
    direction.dispose();
  });

  it('afterFinal: после доставленного FIN, после RST, после закрытия приёмника; данные — не последнее слово', () => {
    const viaEnd = setup();
    const ended: string[] = [];
    viaEnd.direction.afterFinal(() => ended.push('final'));
    viaEnd.from.emit('data', Buffer.from('x'));
    expect(ended).toEqual([]);
    viaEnd.from.emit('end');
    expect(ended).toEqual(['final']);
    const viaReset = setup();
    const reset: string[] = [];
    viaReset.direction.afterFinal(() => reset.push(viaReset.to.calls.join(',')));
    viaReset.from.emit('close', true);
    expect(reset).toEqual(['reset']);
    const viaClose = setup();
    const closed: string[] = [];
    viaClose.direction.afterFinal(() => closed.push('final'));
    viaClose.to.emit('close', false);
    expect(closed).toEqual(['final']);
    const late: string[] = [];
    viaEnd.direction.afterFinal(() => late.push('сразу'));
    expect(late).toEqual(['сразу']);
  });

  it('потолок очереди — ровно 1 MiB', () => {
    expect(QUEUE_HIGH_WATER_BYTES).toBe(1024 * 1024);
  });

  it('приёмник закрыт — очередь выброшена, дальше ничего не передаётся', () => {
    const state: ProxyState = { frozen: true, latencyMs: 0 };
    const { from, to, direction } = setup(state);
    from.emit('data', Buffer.from('потеряется'));
    to.emit('close', false);
    expect(direction.queuedBytes).toBe(0);
    state.frozen = false;
    from.emit('data', Buffer.from('после'));
    direction.pump();
    expect(to.calls).toEqual([]);
  });

  it('приёмник уничтожен (до события close) — передача не идёт', () => {
    const { from, to } = setup();
    to.destroyed = true;
    from.emit('data', Buffer.from('x'));
    expect(to.calls).toEqual([]);
  });

  it('dispose: события источника после него игнорируются', () => {
    const { from, to, direction } = setup();
    direction.dispose();
    from.emit('data', Buffer.from('x'));
    from.emit('close', true);
    expect(to.calls).toEqual([]);
  });

  it('источник уничтожен — его поток не трогается', () => {
    const state: ProxyState = { frozen: true, latencyMs: 0 };
    const { from, direction } = setup(state);
    from.destroyed = true;
    from.paused = false;
    direction.pump();
    expect(from.paused).toBe(false);
  });

  describe('задержка по часам, которые двигает сама спека', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('кусок уходит ровно по истечении задержки, FIN — после него; уменьшение задержки отпускает сразу', () => {
      const state: ProxyState = { frozen: false, latencyMs: 100 };
      const { from, to, direction } = setup(state);
      from.emit('data', Buffer.from('a'));
      jest.advanceTimersByTime(50);
      from.emit('end');
      jest.advanceTimersByTime(49);
      expect(to.calls).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(to.calls).toEqual(['write:a']);
      jest.advanceTimersByTime(49);
      expect(to.calls).toEqual(['write:a']);
      state.latencyMs = 0;
      direction.pump();
      expect(to.calls).toEqual(['write:a', 'end']);
    });

    it('часы ушли вперёд, пока очередь стояла под заморозкой, — после разморозки всё сразу, по порядку', () => {
      const state: ProxyState = { frozen: true, latencyMs: 100 };
      const { from, to, direction } = setup(state);
      from.emit('data', Buffer.from('1'));
      from.emit('data', Buffer.from('2'));
      jest.advanceTimersByTime(500);
      expect(to.calls).toEqual([]);
      state.frozen = false;
      direction.pump();
      expect(to.calls).toEqual(['write:1', 'write:2']);
    });
  });
});
