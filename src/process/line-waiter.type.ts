/** Ожидание строки в `LineReader`. */
export interface LineWaiter {
  readonly match: string | RegExp;
  matches(line: string): boolean;
  resolve(line: string): void;
  reject(error: Error): void;
}
