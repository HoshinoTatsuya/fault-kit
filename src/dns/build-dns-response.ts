import { addressToBytes } from './address-to-bytes';
import type { DnsQuery } from './dns-query.type';
import { dnsRecordHeader } from './dns-record-header';
import { dnsSoaRecord } from './dns-soa-record';

/**
 * Ответ на запрос: заголовок с тем же id и флагом RD запроса, вопрос как
 * есть, записи — указателем на имя вопроса (0xC00C). TTL — секунды.
 *
 * Отрицательный ответ (NXDOMAIN или NOERROR без записей) несёт SOA в секции
 * полномочий (RFC 2308): по её полю minimum резолвер кэширует отказ, а
 * строгие резолверы без неё отказ не принимают. Владелец SOA — имя вопроса,
 * minimum — тот же TTL. `truncated` — бит TC без записей: ответ не влез в
 * UDP, клиент повторит запрос по TCP.
 */
export const buildDnsResponse = (
  query: DnsQuery,
  rcode: number,
  answers: readonly { readonly type: number; readonly address: string }[],
  ttlSeconds: number,
  options: { readonly truncated?: boolean } = {},
): Buffer => {
  const truncated = options.truncated === true;
  const records = truncated
    ? []
    : answers.map(({ type, address }) => {
        const data = addressToBytes(address);
        return Buffer.concat([dnsRecordHeader(type, ttlSeconds, data.length), data]);
      });
  const negative = !truncated && records.length === 0 && (rcode === 0 || rcode === 3);
  const authority = negative ? [dnsSoaRecord(ttlSeconds)] : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR=1, opcode запроса, AA=1, TC, RD как в запросе, RA=1, код ответа.
  header.writeUInt16BE(
    0x8000 |
      (query.flags & 0x7800) |
      0x0400 |
      (truncated ? 0x0200 : 0) |
      (query.flags & 0x0100) |
      0x0080 |
      rcode,
    2,
  );
  // Вопрос повторяется как есть: один (первый) или ни одного (запрос без вопроса).
  header.writeUInt16BE(query.question.length > 0 ? 1 : 0, 4);
  header.writeUInt16BE(records.length, 6);
  header.writeUInt16BE(authority.length, 8);
  return Buffer.concat([header, query.question, ...records, ...authority]);
};
