/** Переменная окружения прогона; нет — отказ, а не пропуск: молчаливо не проверенная спека хуже упавшей. */
export const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} не задан: запускайте через pnpm test (scripts/with-postgres.sh, scripts/with-redis.sh)`,
    );
  }
  return value;
};
