/**
 * Идентификатор SQL в двойных кавычках; кавычка внутри удваивается. Пустое
 * имя, NUL и длиннее 63 байт — отказ: длинное имя сервер молча усёк бы до 63
 * байт, и держатель заблокировал бы ДРУГУЮ таблицу с усечённым именем.
 */
export const quoteIdent = (name: string): string => {
  if (name.length === 0 || name.includes('\0')) {
    throw new TypeError('идентификатор SQL — непустая строка без NUL');
  }
  if (Buffer.byteLength(name) > 63) {
    throw new TypeError(`идентификатор SQL длиннее 63 байт (${Buffer.byteLength(name)}): сервер усёк бы его`);
  }
  return `"${name.replaceAll('"', '""')}"`;
};
