import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { LineWaiter } from './line-waiter.type';

/**
 * Один читатель строк на поток — с буфером. Читатель подписывается на поток
 * при создании и читает его до конца: строки, пришедшие между двумя
 * ожиданиями или тем же куском, что и совпавшая, не теряются (прежний
 * `waitForLine` подписывался на каждое ожидание отдельно и терял всё, что
 * пришло после совпавшей строки).
 *
 * `waitFor(образец)` — курсор: ищет среди НЕпрочитанных строк, совпавшую и
 * все строки до неё считает прочитанными. Ожидания, поставленные
 * одновременно, обслуживаются в порядке постановки. `onLine` — наблюдатель
 * каждой строки, ничего не потребляющий.
 *
 * Поток закончился, закрыт без ошибки (`destroy()`) или уже закончился до
 * создания читателя — ожидания без совпадения (и новые) получают отказ с
 * последними строками; ошибка потока — отказ с ней. Строки — по `\n`,
 * завершающий `\r` (CRLF) снимается. Непрочитанных строк держится не больше
 * `maxUnread` (10 000): старейшие сверх потолка отбрасываются, и отказ
 * ожидания говорит, сколько.
 *
 * Байты декодируются как UTF-8 потоково (`StringDecoder`): символ, разрезанный
 * границей куска трубы (64 КиБ), собирается из двух кусков, а не превращается
 * в два `�`. Хвост без перевода строки копится кусками и склеивается один раз,
 * когда строка закончилась: длинная строка — линейная работа, а не квадратичная.
 */
export class LineReader {
  /** Потолок непрочитанных строк: болтливый процесс без ожиданий не растит память без конца. */
  public static readonly maxUnread = 10_000;
  private static readonly _byStream = new WeakMap<Readable, LineReader>();
  private readonly _unread: string[] = [];
  private _dropped = 0;
  private readonly _recent: string[] = [];
  private readonly _waiters: LineWaiter[] = [];
  private readonly _listeners = new Set<(line: string) => void>();
  private readonly _partial: string[] = [];
  private readonly _decoder = new StringDecoder('utf8');
  private _finished: Error | undefined;

  private constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer | string) => {
      // Поток с setEncoding отдаёт уже декодированные строки; байты — через декодер.
      this._consume(typeof chunk === 'string' ? chunk : this._decoder.write(chunk));
    });
    stream.on('end', () => this._close(new Error('поток закончился')));
    stream.on('error', (error: Error) => this._finish(error));
    // Уничтоженный без ошибки поток (`destroy()`) шлёт только 'close': без него
    // ожидания не кончались бы никогда. После 'end'/'error' — уже закончено.
    stream.on('close', () => this._close(new Error('поток закрыт')));
    if (stream.readableEnded || stream.destroyed) {
      // Конец уже наступил до подписки: событий больше не будет.
      this._finish(new Error('поток закончился до подписки'));
    }
  }

  /** Последняя неполная строка — тоже строка; затем отказ всем ожиданиям. */
  private _close(cause: Error): void {
    if (this._finished !== undefined) {
      return;
    }
    this._consume(this._decoder.end());
    if (this._partial.length > 0) {
      this._push(this._partial.join('').replace(/\r$/, ''));
      this._partial.length = 0;
    }
    this._finish(cause);
  }

  /** Читатель потока: первый вызов создаёт его и подписывает на поток, следующие возвращают тот же. */
  public static of(stream: Readable): LineReader {
    let reader = LineReader._byStream.get(stream);
    if (reader === undefined) {
      reader = new LineReader(stream);
      LineReader._byStream.set(stream, reader);
    }
    return reader;
  }

  /** Первая непрочитанная строка, подходящая под образец (подстрока или регулярное выражение). */
  public waitFor(match: string | RegExp): Promise<string> {
    if (match === '') {
      // Пустая подстрока входит в любую строку: такое ожидание «совпадает» с первой же строкой вывода.
      return Promise.reject(new TypeError('образец строки пуст: он совпал бы с любой строкой'));
    }
    // Без флагов g и y: у такого выражения `test` помнит lastIndex, и одна и та же строка совпадала бы через раз.
    const pattern =
      typeof match === 'string' ? match : new RegExp(match.source, match.flags.replaceAll(/[gy]/g, ''));
    const matches = (line: string): boolean =>
      typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
    const at = this._unread.findIndex(matches);
    if (at >= 0) {
      return Promise.resolve(this._unread.splice(0, at + 1)[at] as string);
    }
    if (this._finished !== undefined) {
      return Promise.reject(this._failure(match, this._finished));
    }
    return new Promise<string>((resolve, reject) => this._waiters.push({ match, matches, resolve, reject }));
  }

  /** Наблюдать каждую строку (ничего не потребляет); возвращает отписку. */
  public onLine(listener: (line: string) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _consume(text: string): void {
    let start = 0;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      this._partial.push(text.slice(start, end));
      this._push(this._partial.join('').replace(/\r$/, ''));
      this._partial.length = 0;
      start = end + 1;
    }
    if (start < text.length) {
      this._partial.push(text.slice(start));
    }
  }

  private _push(line: string): void {
    this._recent.push(line);
    if (this._recent.length > 5) {
      this._recent.shift();
    }
    for (const listener of this._listeners) {
      listener(line);
    }
    const at = this._waiters.findIndex((waiter) => waiter.matches(line));
    if (at < 0) {
      this._unread.push(line);
      if (this._unread.length > LineReader.maxUnread) {
        this._unread.shift();
        this._dropped += 1;
      }
      return;
    }
    const [waiter] = this._waiters.splice(at, 1);
    this._unread.length = 0;
    waiter?.resolve(line);
  }

  private _finish(cause: Error): void {
    if (this._finished !== undefined) {
      return;
    }
    this._finished = cause;
    for (const waiter of this._waiters.splice(0)) {
      waiter.reject(this._failure(waiter.match, cause));
    }
  }

  private _failure(match: string | RegExp, cause: Error): Error {
    const dropped =
      this._dropped > 0 ? `; непрочитанных строк отброшено сверх потолка: ${this._dropped}` : '';
    return new Error(
      `${cause.message} без строки ${String(match)}; последние: ${this._recent.join(' | ')}${dropped}`,
      { cause },
    );
  }
}
