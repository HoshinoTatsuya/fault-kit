/**
 * Свидетель окна: `count` последовательных обращений по ИСПРАВНОМУ пути (тот
 * же сервер напрямую, соседний сервер). Окно «сервер успел ответить двадцать
 * раз, а клиент за отказом — ни разу» не зависит от скорости машины так, как
 * порог по часам: медленная машина замедляет обе стороны.
 */
export const roundTrips = async (count: number, once: () => PromiseLike<unknown>): Promise<void> => {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`число обращений свидетеля — целое не меньше 1, получено ${count}`);
  }
  for (let index = 0; index < count; index += 1) {
    await once();
  }
};
