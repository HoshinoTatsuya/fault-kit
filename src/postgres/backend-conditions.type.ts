/**
 * Условия отбора соединений `terminateBackends`; складываются через И.
 * Строки — непустые: пустое `applicationName` совпало бы со всеми
 * соединениями без имени (у node-pg оно пусто по умолчанию).
 */
export interface BackendConditions {
  readonly pid?: number | readonly number[];
  readonly applicationName?: string;
  readonly user?: string;
  readonly database?: string;
  /** Состояние `pg_stat_activity.state`: `idle`, `active`, `idle in transaction` и др. */
  readonly state?: string;
}
