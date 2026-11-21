import type { DnsQuery } from './dns-query.type';
import { optUdpSize } from './opt-udp-size';

/**
 * Разобрать запрос DNS (RFC 1035 §4.1): заголовок, первый вопрос и, если
 * есть, запись OPT (EDNS0, RFC 6891) в дополнительной секции (на любом месте) —
 * из неё размер UDP-ответа, который примет клиент (не меньше 512). OPT ищется,
 * только когда вопрос один, а секций ответа и полномочий нет (форма запроса):
 * иначе 512. Запрос без вопроса (QDCOUNT 0) разборчив — сервер ответит FORMERR. Метки имени — без
 * сжатия (в вопросе запроса его не шлют), указатель — отказ разбора.
 * Неразборчивый запрос — `undefined`: сервер оставит его без ответа и не
 * посчитает.
 */
export const parseDnsQuery = (message: Buffer): DnsQuery | undefined => {
  if (message.length < 12) {
    return undefined;
  }
  if (message.readUInt16BE(4) === 0) {
    // Запрос без вопроса разборчив: сервер ответит FORMERR без секции вопроса.
    return {
      id: message.readUInt16BE(0),
      flags: message.readUInt16BE(2),
      opcode: (message.readUInt16BE(2) >> 11) & 0x0f,
      questions: 0,
      name: '',
      type: 0,
      qclass: 0,
      udpSize: 512,
      question: Buffer.alloc(0),
    };
  }
  const labels: string[] = [];
  let offset = 12;
  for (;;) {
    const length = message[offset];
    if (length === undefined || length > 63) {
      return undefined;
    }
    offset += 1;
    if (length === 0) {
      break;
    }
    labels.push(message.toString('latin1', offset, offset + length));
    offset += length;
  }
  if (offset + 4 > message.length) {
    return undefined;
  }
  const optSize = optUdpSize(message, offset + 4);
  return {
    id: message.readUInt16BE(0),
    flags: message.readUInt16BE(2),
    opcode: (message.readUInt16BE(2) >> 11) & 0x0f,
    questions: message.readUInt16BE(4),
    name: labels.join('.').toLowerCase(),
    type: message.readUInt16BE(offset),
    qclass: message.readUInt16BE(offset + 2),
    udpSize: optSize === undefined ? 512 : Math.max(512, optSize),
    question: message.subarray(12, offset + 4),
  };
};
