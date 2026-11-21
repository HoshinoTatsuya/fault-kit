/**
 * Кто держит горизонт VACUUM: соединение (`id` — pid), подготовленная
 * транзакция (`id` — gid) или слот репликации (`id` — имя слота). `age` —
 * сколько номеров транзакций прошло с удерживаемого.
 */
export interface HorizonHolder {
  readonly kind: 'backend' | 'prepared' | 'slot';
  readonly id: string;
  readonly age: number;
  readonly applicationName: string | null;
  readonly state: string | null;
  /** `pg_stat_activity.backend_type` соединения (`client backend`, `autovacuum worker`, …); у прочих — `null`. */
  readonly backendType: string | null;
  /**
   * Роль вызова не видит тип и состояние соединения (нет `pg_read_all_stats`,
   * соединение чужой роли): `backendType` и `state` — `null`, держатель
   * засчитан по видимому `backend_xmin`. У подготовленных транзакций и слотов
   * — `false`.
   */
  readonly hidden: boolean;
}
