/** Расхождение двух наборов без учёта порядка: чего не хватает и что лишнее (с кратностью). */
export interface MembersDiff<T> {
  readonly missing: readonly T[];
  readonly unexpected: readonly T[];
}
