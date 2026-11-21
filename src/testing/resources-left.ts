/**
 * Что осталось открытым сверх базы: «тип → на сколько больше». Убывшее не в
 * счёт: база, снятая в начале файла, содержит ресурсы раннера (каналы и
 * дочерние процессы jest), которые закрываются сами, пока идут тесты.
 */
export const resourcesLeft = (
  baseline: Readonly<Record<string, number>>,
  now: Readonly<Record<string, number>>,
): Record<string, number> => {
  const left: Record<string, number> = {};
  for (const [kind, count] of Object.entries(now)) {
    const grown = count - (baseline[kind] ?? 0);
    if (grown > 0) {
      left[kind] = grown;
    }
  }
  return left;
};
