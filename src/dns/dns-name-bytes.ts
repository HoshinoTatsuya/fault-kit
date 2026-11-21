/** Имя DNS в метках без сжатия: `ns.example` → 2 'ns' 7 'example' 0. */
export const dnsNameBytes = (name: string): Buffer =>
  Buffer.concat([
    ...name
      .split('.')
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')])),
    Buffer.from([0]),
  ]);
