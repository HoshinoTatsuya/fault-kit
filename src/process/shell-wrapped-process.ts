import type { ChildProcess } from 'node:child_process';
import { descendantsIn } from './descendants-in';
import { ExitGuard } from './exit-guard';
import type { ExitInfo } from './exit-info.type';
import { exitOf } from './exit-of';
import { isReaped } from './is-reaped';
import { isZombie } from './is-zombie';
import { killLimitOf } from './kill-limit-of';
import { listProcesses } from './list-processes';
import { orphansOf } from './orphans-of';
import type { ProcessInfo } from './process-info.type';
import { sameProcess } from './same-process';
import { signalQuietly } from './signal-quietly';
import { strayVictims } from './stray-victims';

/**
 * Команда за оболочкой без `exec` (см. `spawnBehindShell`). Оболочка — лидер
 * своей группы процессов: `signal()` бьёт только её (как раннер, шлющий
 * сигнал прямому потомку, — дефект), `signalGroup()` — всю группу (как
 * правильный раннер). После того как Node подобрал код выхода оболочки, её
 * pid и номер группы могут достаться другим процессам: `signal()` и
 * `signalGroup()` тогда не шлют ничего и возвращают `false`.
 *
 * `close()` — уборка без промахов по чужим:
 * 1. пока оболочка не подобрана — снимок потомков и SIGKILL группе и самой
 *    оболочке (номера зарезервированы за ней, адресат точно наш);
 * 2. свежая таблица процессов и поштучный SIGKILL тем, кто ПО НЕЙ
 *    совпадает (pid, момент старта, команда) с потомком или членом группы
 *    из любого снимка этой обёртки (`descendants()` и снимок шага 1), а пока
 *    оболочка не подобрана — и всем членам группы; так добиваются и сироты,
 *    ушедшие в свою сессию;
 * 3. выборка, задевшая процесс спеки или его предков, или жертв больше
 *    `killLimit` (по умолчанию 64) — отказ без поштучных сигналов.
 * Затем ожидание выхода оболочки и закрытие труб stdio.
 *
 * Спека упала, не вызвав `close()`, — при штатном выходе процесса спеки группе
 * и оболочке, ещё не подобранной, уходит SIGKILL (`ExitGuard`); процессы вне
 * группы и выход по SIGKILL раннера так не убираются.
 */
export class ShellWrappedProcess implements AsyncDisposable {
  public readonly exited: Promise<ExitInfo>;
  /**
   * pid оболочки = id её группы процессов. Снят в конструкторе: запасного
   * значения нет — `-1` для `kill()` означает «все процессы пользователя».
   */
  public readonly pid: number;
  private readonly _known: ProcessInfo[] = [];
  private readonly _killLimit: number;
  private _closing: Promise<void> | undefined;

  public constructor(
    public readonly shell: ChildProcess,
    options: { readonly killLimit?: number } = {},
  ) {
    // Отказ запуска приходит событием 'error' ПОСЛЕ конструктора: без слушателя он уронил бы процесс спеки.
    shell.on('error', () => undefined);
    if (shell.pid === undefined) {
      throw new Error('оболочка не запустилась: нет pid');
    }
    this._killLimit = killLimitOf(options.killLimit);
    this.pid = shell.pid;
    const pid = shell.pid;
    ExitGuard.killOnExit(shell, () => {
      // Каждый сигнал — отдельно: отказ группе (EPERM) не отменяет сигнал самой оболочке.
      for (const target of [-pid, pid]) {
        try {
          signalQuietly(target, 'SIGKILL');
        } catch {
          // Уборка при выходе не роняет выход; оставшееся найдёт orphansOf.
        }
      }
    });
    this.exited = exitOf(shell);
    this.exited.catch(() => undefined);
  }

  /** Сигнал только оболочке; оболочка уже подобрана — `false` без сигнала. */
  public signal(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return !isReaped(this.shell) && signalQuietly(this.pid, signal);
  }

  /** Сигнал всей группе процессов оболочки; оболочка уже подобрана — `false` без сигнала (см. `close()`). */
  public signalGroup(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return !isReaped(this.shell) && signalQuietly(-this.pid, signal);
  }

  /**
   * Живые потомки оболочки сейчас — снимок для `orphans()` после её выхода;
   * его же добивает `close()`. Снимается, пока оболочка не подобрана:
   * потомки подобранной — уже чьи-то ещё, и запрос отклоняется. Тем же
   * чтением таблицы обёртка запоминает и живых членов своей группы: после
   * подбора оболочки группа по номеру уже не доказуемо её.
   */
  public async descendants(): Promise<readonly ProcessInfo[]> {
    if (isReaped(this.shell)) {
      throw new Error(`оболочка ${this.pid} уже завершилась: снимок потомков снимают, пока дерево работает`);
    }
    return this._snapshot();
  }

  /**
   * Что живо из группы оболочки (пока она не подобрана) и из снимков:
   * переданного `tracked` и запомненного обёрткой (`descendants()`).
   * Оболочка подобрана, а снимка нет — отказ (см. `orphansOf`).
   */
  public orphans(tracked?: readonly ProcessInfo[]): Promise<readonly ProcessInfo[]> {
    return orphansOf(this.pid, {
      tracked: [...(tracked ?? []), ...this._known],
      exited: () => isReaped(this.shell),
    });
  }

  public close(): Promise<void> {
    this._closing ??= this._close();
    return this._closing;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async _close(): Promise<void> {
    let shellDone = isReaped(this.shell);
    try {
      if (!shellDone) {
        await this._snapshot().catch(() => []);
        if (!isReaped(this.shell)) {
          signalQuietly(-this.pid, 'SIGKILL');
          signalQuietly(this.pid, 'SIGKILL');
        }
        shellDone = true;
      }
      // Подобрана ли оболочка — ПОСЛЕ снятия таблицы, в том же такте, что выборка и
      // сигналы: чтение асинхронно, и подбор посреди него освободил бы номер группы
      // (его мог занять чужой лидер со своими членами в этой же таблице). Не
      // подобрана после чтения — значит, не была подобрана и во время него.
      const table = await listProcesses();
      const victims = strayVictims(table, {
        group: this.pid,
        shellReaped: isReaped(this.shell),
        known: this._known,
        limit: this._killLimit,
      });
      // Отказ на одной жертве (EPERM: чужой setuid-потомок) не оставляет остальных недобитыми.
      const refused: string[] = [];
      for (const victim of victims) {
        try {
          signalQuietly(victim.pid, 'SIGKILL');
        } catch (error) {
          refused.push(`${victim.pid}: ${(error as Error).message}`);
        }
      }
      if (refused.length > 0) {
        throw new Error(`уборка не добила ${refused.length} из ${victims.length}: ${refused.join('; ')}`);
      }
    } finally {
      // Ждать выхода — только если он заведомо наступит (оболочке ушёл SIGKILL или она уже вышла).
      if (shellDone) {
        await this.exited.catch(() => undefined);
      }
      for (const stream of [this.shell.stdin, this.shell.stdout, this.shell.stderr]) {
        stream?.destroy();
      }
    }
  }

  /** Потомки и члены группы из одного чтения таблицы; запоминаются, только если оболочка всё ещё не подобрана. */
  private async _snapshot(): Promise<readonly ProcessInfo[]> {
    const table = await listProcesses();
    const found = descendantsIn(table, this.pid);
    if (!isReaped(this.shell)) {
      this._remember(found);
      this._remember(
        table.filter((info) => info.pgid === this.pid && info.pid !== this.pid && !isZombie(info)),
      );
    }
    return found;
  }

  private _remember(found: readonly ProcessInfo[]): void {
    for (const info of found) {
      if (!this._known.some((seen) => sameProcess(seen, info))) {
        this._known.push(info);
      }
    }
  }
}
