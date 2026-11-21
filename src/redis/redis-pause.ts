import { assertPauseArgs } from './assert-pause-args';
import type { RedisCommander } from './redis-commander.type';
import type { RedisPauseMode } from './redis-pause-mode.type';

/**
 * Поставленная пауза сервера. `unpause()` — `CLIENT UNPAUSE`: в режиме
 * `write` снимает паузу сразу, в режиме `all` команда сама стоит до конца
 * паузы (так устроен Redis) и разрешается, когда пауза истекла: ожидание
 * ограничено длительностью паузы на сервере, а не своим таймером. Повторный
 * вызов — тот же результат. Конструктор проверяет режим и длительность.
 */
export class RedisPause implements AsyncDisposable {
  private _unpaused: Promise<void> | undefined;

  public constructor(
    private readonly _admin: RedisCommander,
    public readonly mode: RedisPauseMode,
    public readonly ms: number,
  ) {
    assertPauseArgs(ms, mode);
  }

  public unpause(): Promise<void> {
    this._unpaused ??= this._admin.call('CLIENT', 'UNPAUSE').then(() => undefined);
    return this._unpaused;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.unpause();
  }
}
