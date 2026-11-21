/**
 * Настоящий объект процесса Node — мимо глобального `process`. jest отдаёт
 * спеке КОПИЮ процесса (`jest-util createProcessObject`, без `_events`) и ту
 * же копию на `require('node:process')`: подписка на её 'exit' или сигнал не
 * сработает никогда — копия не завершается. До jest 30.5 настоящий процесс
 * отдавал `process.getBuiltinModule('node:process')`; jest 30.5 подменил
 * `getBuiltinModule` копии своим реестром, и тот отдаёт ту же копию. Поэтому
 * `process` берётся из основного realm Node: конструктор функций — у
 * встроенной функции Node, которую окружение jest отдаёт как есть (`Buffer`).
 * Вне jest это тот же realm и тот же `process`.
 *
 * Фальшивые таймеры (`jest.useFakeTimers()`) подменяют `nextTick` копии, а
 * не настоящего процесса, — поэтому и `nextTick` пакета берётся отсюда.
 */
export const realProcess: NodeJS.Process =
  (new (Buffer.constructor as FunctionConstructor)(
    'return typeof process === "object" ? process : undefined',
  )() as NodeJS.Process | undefined) ?? globalThis.process;
