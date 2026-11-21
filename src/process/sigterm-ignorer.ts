import { type ChildProcess, spawn } from 'node:child_process';
import { ExitGuard } from './exit-guard';
import type { ExitInfo } from './exit-info.type';
import { exitOf } from './exit-of';
import { LineReader } from './line-reader';
import { signalQuietly } from './signal-quietly';
import { sigtermIgnorerCommand } from './sigterm-ignorer-command';

/**
 * Запущенный процесс, игнорирующий SIGTERM. `ready` — обработчик стоит, слать
 * можно; `nextTerm()` — событие «ещё один SIGTERM дошёл и проигнорирован»:
 * после него процесс заведомо жив, и проверка «его добили SIGKILL» не
 * зависит от пауз. Процесс умер раньше — `ready` и ожидающие `nextTerm()`
 * получают отказ (а не висят до таймаута теста), `nextTerm()` после смерти —
 * отказ сразу. `close()` — SIGKILL и ожидание выхода. Спека упала, не вызвав
 * `close()`, — процесс добивается при штатном выходе процесса спеки
 * (`ExitGuard`); выход по SIGKILL раннера не перехватывается.
 */
export class SigtermIgnorer implements AsyncDisposable {
  public readonly ready: Promise<void>;
  public readonly exited: Promise<ExitInfo>;
  private _terms = 0;
  private readonly _termWaiters = new Set<{ after: number; resolve(): void; reject(error: Error): void }>();
  private _closing: Promise<void> | undefined;
  private _died: Error | undefined;
  private readonly _pid: number;

  private constructor(public readonly child: ChildProcess) {
    // Отказ запуска приходит событием 'error' ПОСЛЕ конструктора: без слушателя он уронил бы процесс спеки.
    child.on('error', () => undefined);
    const stdout = child.stdout;
    if (stdout === null || child.pid === undefined) {
      throw new Error('процесс не запустился');
    }
    this._pid = child.pid;
    const pid = child.pid;
    ExitGuard.killOnExit(child, () => signalQuietly(pid, 'SIGKILL'));
    this.exited = exitOf(child);
    let markReady: () => void = () => undefined;
    let failReady: (error: Error) => void = () => undefined;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    // Отказ `ready` после смерти виден тому, кто его ждёт; необработанным он не становится.
    this.ready.catch(() => undefined);
    LineReader.of(stdout).onLine((line) => {
      if (line.startsWith('ready ')) {
        markReady();
      } else if (line.startsWith('term ')) {
        this._terms += 1;
        for (const waiter of this._termWaiters) {
          if (this._terms > waiter.after) {
            this._termWaiters.delete(waiter);
            waiter.resolve();
          }
        }
      }
    });
    const die = (how: string): void => {
      this._died = new Error(`процесс ${this._pid} завершился (${how}), не дождавшись события`);
      failReady(this._died);
      for (const waiter of this._termWaiters) {
        waiter.reject(this._died);
      }
      this._termWaiters.clear();
    };
    this.exited.then(
      (info) => die(info.signal ?? `код ${info.code}`),
      (error: Error) => die(error.message),
    );
  }

  public static start(): SigtermIgnorer {
    const { command, args } = sigtermIgnorerCommand();
    return new SigtermIgnorer(spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] }));
  }

  /** Снят в конструкторе: запасного значения нет — `-1` для `kill()` означает «все процессы». */
  public get pid(): number {
    return this._pid;
  }

  /** Сколько SIGTERM процесс получил и проигнорировал. */
  public get terms(): number {
    return this._terms;
  }

  /** Разрешается, когда счётчик `terms` превысит значение на момент вызова; процесс умер — отказ. */
  public nextTerm(): Promise<void> {
    if (this._died !== undefined) {
      return Promise.reject(this._died);
    }
    const after = this._terms;
    return new Promise<void>((resolve, reject) => this._termWaiters.add({ after, resolve, reject }));
  }

  /**
   * SIGKILL и ожидание выхода. Уже завершённому (Node подобрал его код)
   * сигнал не шлётся: его pid мог достаться другому процессу.
   */
  public close(): Promise<void> {
    this._closing ??= (async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        signalQuietly(this._pid, 'SIGKILL');
      }
      await this.exited.catch(() => undefined);
      this.child.stdout?.destroy();
    })();
    return this._closing;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
