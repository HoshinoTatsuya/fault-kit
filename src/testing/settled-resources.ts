import { nextTurn } from '../assert/next-turn';
import { activeResources } from './active-resources';

/**
 * Ресурсы процесса после того, как улеглись запросы (ConnectWrap живёт до
 * следующего оборота после 'connect'): `ready` — событие «внешние стороны
 * пришли в ожидаемое состояние», затем два оборота цикла.
 */
export const settledResources = async (
  ready: PromiseLike<unknown> = Promise.resolve(),
): Promise<Record<string, number>> => {
  await ready;
  await nextTurn();
  await nextTurn();
  return activeResources();
};
