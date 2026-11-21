import type { SettleState } from './settle-state.type';

/**
 * Наблюдатель исхода работы. Подписывается сразу, поэтому отказ работы,
 * случившийся позже, не становится «необработанным»: его увидит тот, кто
 * спросит `state()`, или тот, кто сам ждёт работу.
 *
 * Принимает уже обещание, а не thenable: `Promise.resolve(thenable)` зовёт
 * его `then` — ленивый построитель запроса выполнил бы запрос на каждый
 * такой вызов. Преобразует вызывающий, ровно один раз (`asPromise`).
 */
export const observeSettle = <T>(work: Promise<T>): { state(): SettleState<T> } => {
  let state: SettleState<T> = { kind: 'pending' };
  work.then(
    (value) => {
      state = { kind: 'resolved', value };
    },
    (reason: unknown) => {
      state = { kind: 'rejected', reason };
    },
  );
  return { state: () => state };
};
