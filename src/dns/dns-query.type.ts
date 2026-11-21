/** Разобранный запрос: всё, что нужно для ответа на первый вопрос. */
export interface DnsQuery {
  readonly id: number;
  readonly flags: number;
  /** Код операции из заголовка: 0 — обычный запрос (QUERY). */
  readonly opcode: number;
  /** Сколько вопросов объявлено в заголовке (отвечаем только на ровно один). */
  readonly questions: number;
  /** Имя в нижнем регистре, без завершающей точки. */
  readonly name: string;
  readonly type: number;
  /** Класс вопроса: 1 — IN. */
  readonly qclass: number;
  /** Сколько байт клиент примет по UDP: из записи OPT (EDNS0), без неё — 512. */
  readonly udpSize: number;
  /** Сырые байты секции вопроса — ответ повторяет её как есть. */
  readonly question: Buffer;
}
