import type { HorizonHolder } from './horizon-holder.type';

/** Возраст горизонта (0 — никто не держит) и держатели, старейший первым. */
export interface HorizonReport {
  readonly age: number;
  readonly holders: readonly HorizonHolder[];
}
