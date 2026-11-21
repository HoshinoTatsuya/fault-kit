import { createHook } from 'node:async_hooks';

/**
 * Живые (и удерживающие процесс) таймеры, которые завёл код СПЕКИ, — а не
 * раннер тестов и не то, что жило в процессе до подключения этого модуля.
 *
 * Таймеры раннера: отложенная перерисовка строки состояния репортера jest
 * (`Status._debouncedEmit`), таймер потолка теста jest-circus. Когда jest
 * гонит файл в своём процессе, они живут рядом со спекой: тест длиннее
 * секунды заводит таймер репортера, он попадал в «базу» следующей проверки
 * ресурсов и к её концу срабатывал — проверка «примитив освободил всё»
 * краснела на исправном коде в зависимости от порядка тестов. Таймер —
 * раннера, если кадр, вызвавший `setTimeout`, — код jest в node_modules.
 *
 * Таймеры, заведённые ДО подключения модуля (воркер jest между файлами,
 * предыдущий файл того же воркера), хук не видел вовсе: прежде их считали
 * вычитанием «все активные минус раннера», и такой таймер, сработавший
 * посреди проверки, краснил её на исправном коде (jest 30.5, 2 прогона из 4).
 * Теперь считаются только таймеры, чьё создание хук видел, — код спеки
 * подключает этот модуль раньше, чем заводит свои.
 */
export const SPEC_TIMERS: { refCount(): number } = ((): { refCount(): number } => {
  const runnerFrame =
    /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@jest[\\/]|jest-[\w-]+[\\/])/;
  const timers = new Map<number, { hasRef(): boolean; _destroyed?: boolean }>();
  createHook({
    init(asyncId, type, _trigger, resource) {
      if (type !== 'Timeout') {
        return;
      }
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 30;
      const frames = String(new Error().stack).split('\n').slice(1);
      Error.stackTraceLimit = limit;
      // Кадр, вызвавший setTimeout/setInterval: выше него — сам этот слушатель и внутренности node.
      const at = frames.findIndex((frame) => /\bset(?:Timeout|Interval)\b/.test(frame));
      const caller = at < 0 ? undefined : frames[at + 1];
      if (caller === undefined || !runnerFrame.test(caller)) {
        timers.set(asyncId, resource as { hasRef(): boolean; _destroyed?: boolean });
      }
    },
    destroy(asyncId) {
      timers.delete(asyncId);
    },
  }).enable();
  // Снятый с учёта (unref) таймер в process.getActiveResourcesInfo() не виден — и здесь не считается.
  // Снятый clearTimeout или сработавший — тоже: событие destroy хука приходит позже, а `_destroyed`
  // стоит сразу (hasRef() у него по-прежнему true).
  return {
    refCount: () =>
      [...timers.values()].filter((timer) => timer._destroyed !== true && timer.hasRef()).length,
  };
})();
