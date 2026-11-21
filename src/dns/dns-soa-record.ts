import { dnsNameBytes } from './dns-name-bytes';
import { dnsRecordHeader } from './dns-record-header';

/** SOA для отрицательного ответа (RFC 2308): владелец — имя вопроса, minimum — TTL отказа. */
export const dnsSoaRecord = (ttlSeconds: number): Buffer => {
  const timers = Buffer.alloc(20);
  for (const [index, value] of [1, 3600, 600, 86_400, ttlSeconds].entries()) {
    timers.writeUInt32BE(value, index * 4);
  }
  const data = Buffer.concat([
    dnsNameBytes('ns.fault-kit.invalid'),
    dnsNameBytes('hostmaster.fault-kit.invalid'),
    timers,
  ]);
  return Buffer.concat([dnsRecordHeader(6, ttlSeconds, data.length), data]);
};
