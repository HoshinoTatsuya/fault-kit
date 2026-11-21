/**
 * `terminateBackends` не довёл снятие до конца: сервер отказал на одном из
 * соединений (`code` — его код, например 42501 — нет прав) или соединения не
 * завершились за `waitMs`. `terminated` — кого успели снять до отказа (они
 * мертвы), `failed` — pid, на которых остановились.
 */
export class BackendTerminationError extends Error {
  public override readonly name = 'BackendTerminationError';

  public constructor(
    message: string,
    public readonly terminated: readonly number[],
    public readonly failed: readonly number[],
    public readonly code: string | undefined,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
