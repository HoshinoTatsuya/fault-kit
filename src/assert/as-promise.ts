/**
 * Обещание из работы — ровно один вызов `then` у thenable. Ленивый thenable
 * (построитель запроса) выполняет работу на каждый `then`: два
 * `Promise.resolve(work)` в разных местах выполнили бы INSERT дважды.
 */
export const asPromise = <T>(work: PromiseLike<T>): Promise<T> =>
  work instanceof Promise ? (work as Promise<T>) : Promise.resolve(work);
