import { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';

import { realProcess } from '../real-process';
import type { ExitGuardRegistry } from './exit-guard-registry.type';

/**
 * Добить запущенное пакетом при выходе процесса спеки, если спека не вызвала
 * `close()` (упала раньше, раннер завершает процесс). Слушатели — на
 * НАСТОЯЩЕМ процессе (`realProcess`): jest отдаёт спеке копию `process`,
 * которая не завершается никогда, и подписка на неё не срабатывала.
 *
 * - 'exit' — штатный выход (`process.exit`, конец цикла событий, воркер jest
 *   по сообщению о конце); в нём только синхронная работа — `kill` такова;
 * - SIGTERM и SIGINT — так jest-worker снимает невышедший воркер и так
 *   прерывают прогон. Если на сигнал больше никто не подписан, процесс
 *   добивает своё и завершается тем же сигналом, как завершился бы без
 *   пакета (pid 1 в контейнере сигнал по умолчанию себе не доставит —
 *   тогда выход с кодом 128 + номер). Есть другой слушатель — решает он:
 *   процесс может и не завершаться, а если завершится — сработает 'exit'.
 *
 * Выход по SIGKILL (и по сигналу без обработчика, кроме этих двух) не
 * перехватывается ничем — это ограничение.
 */
export class ExitGuard {
  /** Ключ реестра на настоящем процессе; номер — версия формы реестра. */
  private static readonly _registryKey = Symbol.for('@hoshinotatsuya/fault-kit/exit-guard@1');

  /**
   * Метка слушателей пакета на процессе: слушатель другой версии пакета (свой
   * реестр) — не «чужой обработчик», иначе две версии уступали бы сигнал друг
   * другу и процесс не завершился бы вовсе.
   */
  private static readonly _listenerMark = Symbol.for('@hoshinotatsuya/fault-kit/exit-guard/listener');

  /** Сигналы, по которым процесс спеки завершается штатно: jest-worker снимает воркер SIGTERM, Ctrl+C — SIGINT. */
  private static readonly _terminating = ['SIGTERM', 'SIGINT'] as const;

  public static killOnExit(child: ChildProcess, kill: () => void): void {
    // Только настоящий дочерний процесс: у подделки из спеки pid выдуман, и сигнал по нему ушёл бы чужому.
    if (!(child instanceof ChildProcess)) {
      return;
    }
    const { live } = ExitGuard._registry();
    live.set(child, kill);
    child.once('exit', () => live.delete(child));
  }

  private static _registry(): ExitGuardRegistry {
    const holder = realProcess as unknown as Record<symbol, ExitGuardRegistry | undefined>;
    const existing = holder[ExitGuard._registryKey];
    if (existing !== undefined) {
      return existing;
    }
    const registry: ExitGuardRegistry = { live: new Map() };
    // Неперечислимое и символьное: копии процесса, которые делает jest, его не переносят.
    Object.defineProperty(realProcess, ExitGuard._registryKey, { value: registry, enumerable: false });
    const onExit = (): void => ExitGuard._killAll(registry.live);
    realProcess.once('exit', Object.assign(onExit, { [ExitGuard._listenerMark]: true }));
    for (const signal of ExitGuard._terminating) {
      const onSignal = (): void => {
        if (realProcess.listeners(signal).some((listener) => !(ExitGuard._listenerMark in listener))) {
          return;
        }
        ExitGuard._killAll(registry.live);
        realProcess.removeListener(signal, onSignal);
        if (realProcess.listenerCount(signal) > 0) {
          return; // слушатель другой версии пакета ещё впереди: завершит процесс он
        }
        if (realProcess.pid > 1) {
          realProcess.kill(realProcess.pid, signal);
        } else {
          realProcess.exit(128 + constants.signals[signal]);
        }
      };
      realProcess.on(signal, Object.assign(onSignal, { [ExitGuard._listenerMark]: true }));
    }
    return registry;
  }

  private static _killAll(live: ExitGuardRegistry['live']): void {
    // Подобранный Node процесс удаляется из реестра в том же такте, что и событие 'exit' (код выхода
    // ставится перед ним синхронно), поэтому всё, что в реестре, ещё не подобрано: pid и группа — его.
    for (const kill of live.values()) {
      try {
        kill();
      } catch {
        // Выход процесса спеки не должен падать из-за уборки: оставшееся найдёт orphansOf.
      }
    }
  }
}
