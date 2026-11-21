/**
 * Отказ утверждения пакета: работа не завершилась до дедлайна, завершилась в
 * окне, где не должна была, или множества не совпали. Своё имя — чтобы в
 * отчёте раннера было видно, что упало утверждение об отказе, а не код.
 */
export class FaultAssertionError extends Error {
  public override readonly name = 'FaultAssertionError';
}
