/**
 * Настройки любого держателя. `applicationName` — чтобы держатель был виден в
 * `pg_stat_activity` и его можно было снять `terminateBackends`; по умолчанию
 * — имя из настроек соединения (строка подключения, `application_name`,
 * `PGAPPNAME`), а если там пусто — `fault-kit:<что держит>`. `timeoutMs` —
 * потолок открытия (подключение и все запросы) и освобождения (ROLLBACK и
 * закрытие): держатель за замёрзшим прокси или перед недоступным сервером
 * отказывает, а не висит до таймаута теста. По умолчанию 10 000, не больше
 * 2 147 483 647 (потолок таймера Node).
 */
export interface HolderBaseOptions {
  readonly applicationName?: string;
  readonly timeoutMs?: number;
}
