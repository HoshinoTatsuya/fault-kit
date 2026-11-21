/** Заголовок записи ответа: имя — указатель на имя вопроса (0xC00C), класс IN, TTL, длина данных. */
export const dnsRecordHeader = (type: number, ttlSeconds: number, length: number): Buffer => {
  const record = Buffer.alloc(12);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(type, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(ttlSeconds, 6);
  record.writeUInt16BE(length, 10);
  return record;
};
