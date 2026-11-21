import { isIPv4, isIPv6 } from 'node:net';

/** Адрес IPv4 или IPv6 в байтах записи A/AAAA. Не адрес — отказ: опечатка в фикстуре не должна стать «нет записи». */
export const addressToBytes = (address: string): Buffer => {
  if (isIPv4(address)) {
    return Buffer.from(address.split('.').map(Number));
  }
  if (!isIPv6(address)) {
    throw new TypeError(`не адрес IPv4/IPv6: ${address}`);
  }
  let text = address.replace(/%.*$/, '');
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (embedded !== undefined) {
    const v4 = addressToBytes(embedded);
    text = `${text.slice(0, -embedded.length)}${v4.readUInt16BE(0).toString(16)}:${v4.readUInt16BE(2).toString(16)}`;
  }
  // Пустая группа ('' слева или справа от '::') читается как 0 — счёт групп от этого не меняется.
  const [head = '', tail] = text.split('::');
  const left = head.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - tail.split(':').length).fill('0'), ...tail.split(':')];
  const bytes = Buffer.alloc(16);
  for (const [index, group] of groups.entries()) {
    bytes.writeUInt16BE(group === '' ? 0 : Number.parseInt(group, 16), index * 2);
  }
  return bytes;
};
