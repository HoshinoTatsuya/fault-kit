import type { Readable } from 'node:stream';

/**
 * Копить весь текст потока UTF-8. `setEncoding` декодирует потоково: символ,
 * разрезанный границей куска, не превращается в два `�` (что даёт
 * `chunk.toString()` на каждом куске). Возвращает чтение накопленного.
 */
export const collectText = (stream: Readable): (() => string) => {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    text += chunk;
  });
  return () => text;
};
