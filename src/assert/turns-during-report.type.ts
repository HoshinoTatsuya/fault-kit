/**
 * Итог `turnsDuring`. `turns` — в скольких оборотах цикла событий
 * выполнялся код работы; `longestTurnShare` — доля самого длинного из них в
 * процессорном времени всей работы (0..1; работа без времени — 0).
 */
export interface TurnsDuringReport<T> {
  readonly value: T;
  readonly turns: number;
  readonly longestTurnShare: number;
}
