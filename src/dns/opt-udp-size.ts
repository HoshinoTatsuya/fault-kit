/**
 * Размер UDP из записи OPT дополнительной секции, начинающейся с `offset`;
 * `undefined` — записи нет или запрос не той формы. Имена записей — метки или
 * указатель сжатия (2 байта).
 */
export const optUdpSize = (message: Buffer, start: number): number | undefined => {
  if (message.readUInt16BE(4) !== 1 || message.readUInt16BE(6) !== 0 || message.readUInt16BE(8) !== 0) {
    return undefined;
  }
  let offset = start;
  for (let record = 0; record < message.readUInt16BE(10); record += 1) {
    for (;;) {
      const length = message[offset];
      if (length === undefined) {
        return undefined;
      }
      if ((length & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      offset += 1 + length;
      if (length === 0) {
        break;
      }
    }
    if (offset + 10 > message.length) {
      return undefined;
    }
    if (message.readUInt16BE(offset) === 41) {
      return message.readUInt16BE(offset + 2);
    }
    offset += 10 + message.readUInt16BE(offset + 8);
  }
  return undefined;
};
