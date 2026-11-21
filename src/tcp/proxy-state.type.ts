/** Общее состояние прокси, которое читает каждое направление при каждой передаче. */
export interface ProxyState {
  frozen: boolean;
  latencyMs: number;
}
