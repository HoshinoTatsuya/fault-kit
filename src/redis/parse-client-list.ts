/** Ответ `CLIENT LIST` — строки `ключ=значение` через пробел — в записи. */
export const parseClientList = (reply: string): ReadonlyArray<Readonly<Record<string, string>>> =>
  reply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      Object.fromEntries(
        line.split(' ').map((pair) => {
          const at = pair.indexOf('=');
          return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
        }),
      ),
    );
