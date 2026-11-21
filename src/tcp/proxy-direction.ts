import type { Socket } from 'node:net';

import type { ProxyQueueItem } from './proxy-queue-item.type';
import type { ProxyState } from './proxy-state.type';
import { QUEUE_HIGH_WATER_BYTES } from './queue-high-water.constant';

/**
 * Одно направление соединения через прокси: события источника — в очередь,
 * из очереди — в приёмник, когда прокси не заморожен и задержка истекла.
 *
 * Очередь одна и FIFO, срок каждого события — «момент прихода + ТЕКУЩАЯ
 * задержка»: уменьшение задержки отпускает накопленное сразу и никогда не
 * переставляет события местами (таймер на каждый кусок со своей задержкой
 * переставил бы и испортил бы поток протокола). Закрытие источника — тоже
 * событие очереди (`end` — FIN, `reset` — обрыв без FIN): ответ, после
 * которого цель закрыла соединение, доходит целиком и только потом FIN;
 * замороженный прокси не передаёт и закрытие.
 *
 * Обратное давление: `write() === false` останавливает передачу до 'drain'
 * (иначе вся очередь уходила бы в буфер записи сокета, и заморозка не
 * задержала бы уже переданное туда); очередь больше `QUEUE_HIGH_WATER_BYTES`
 * — источник на паузе.
 */
export class ProxyDirection {
  private readonly _queue: ProxyQueueItem[] = [];
  private _queuedBytes = 0;
  private _timer: NodeJS.Timeout | undefined;
  private _sourceEnded = false;
  private _congested = false;
  private _disposed = false;
  private _final = false;
  private readonly _afterFinal: Array<() => void> = [];

  public constructor(
    private readonly _from: Socket,
    private readonly _to: Socket,
    private readonly _state: ProxyState,
    private readonly _onForwarded: (bytes: number) => void,
  ) {
    _from.on('data', (chunk: Buffer) => this._enqueue({ kind: 'data', chunk, arrivedAt: performance.now() }));
    _from.on('end', () => {
      this._sourceEnded = true;
      this._enqueue({ kind: 'end', arrivedAt: performance.now() });
    });
    _from.on('close', () => {
      if (!this._sourceEnded) {
        this._enqueue({ kind: 'reset', arrivedAt: performance.now() });
      }
    });
    _to.on('drain', () => {
      this._congested = false;
      this.pump();
    });
    _to.on('close', () => this.dispose());
  }

  /**
   * Выполнить, когда направление сказало последнее слово: приёмнику ушёл FIN
   * или RST либо приёмник закрыт. Прокси по нему закрывает сторону, у которой
   * больше нет собеседника, — после того, как ей доставлено всё, что для неё
   * стояло в очереди.
   */
  public afterFinal(callback: () => void): void {
    if (this._final) {
      callback();
    } else {
      this._afterFinal.push(callback);
    }
  }

  /** Сколько байт данных стоит в очереди (ещё не передано приёмнику). */
  public get queuedBytes(): number {
    return this._queuedBytes;
  }

  /** Передать всё, что можно передать сейчас; на остальное — один таймер. */
  public pump(): void {
    this._clearTimer();
    if (this._disposed || this._to.destroyed) {
      this.dispose();
      return;
    }
    while (this._queue.length > 0 && !this._state.frozen && !this._congested) {
      const head = this._queue[0] as ProxyQueueItem;
      const wait = head.arrivedAt + this._state.latencyMs - performance.now();
      if (wait > 0) {
        this._timer = setTimeout(() => this.pump(), Math.ceil(wait));
        break;
      }
      this._queue.shift();
      if (head.kind === 'data') {
        this._queuedBytes -= head.chunk.length;
        const length = head.chunk.length;
        // Счёт — по факту записи (колбэк без ошибки): байты, отданные ещё не
        // подключённому сокету цели, при отказе подключения не переданы никуда.
        this._congested = !this._to.write(head.chunk, (error) => {
          if (error === undefined || error === null) {
            this._onForwarded(length);
          }
        });
      } else if (head.kind === 'end') {
        this._to.end();
        this._markFinal();
      } else {
        this._reset();
        return;
      }
    }
    this._updateFlow();
  }

  /** Сбросить очередь и таймер и больше ничего не передавать: приёмник закрыт или соединение обрывают. */
  public dispose(): void {
    this._disposed = true;
    this._clearTimer();
    this._queue.length = 0;
    this._queuedBytes = 0;
    this._markFinal();
  }

  private _enqueue(item: ProxyQueueItem): void {
    // После dispose очередь не передаётся: pump увидит _disposed и снова её сбросит.
    if (item.kind === 'data') {
      this._queuedBytes += item.chunk.length;
    }
    this._queue.push(item);
    this.pump();
  }

  private _markFinal(): void {
    if (!this._final) {
      this._final = true;
      for (const callback of this._afterFinal.splice(0)) {
        callback();
      }
    }
  }

  private _reset(): void {
    // Сначала RST, потом dispose: dispose будит afterFinal, и закрытие FIN не должно опередить RST.
    if (this._to.connecting) {
      this._to.destroy();
    } else {
      this._to.resetAndDestroy();
    }
    this.dispose();
  }

  private _updateFlow(): void {
    if (this._from.destroyed) {
      return;
    }
    if (this._state.frozen || this._congested || this._queuedBytes >= QUEUE_HIGH_WATER_BYTES) {
      this._from.pause();
    } else {
      this._from.resume();
    }
  }

  private _clearTimer(): void {
    clearTimeout(this._timer);
    this._timer = undefined;
  }
}
