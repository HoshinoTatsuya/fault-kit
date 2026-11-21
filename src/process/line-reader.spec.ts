import { PassThrough } from 'node:stream';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { nextTurn } from '../assert/next-turn';
import { LineReader } from './line-reader';
import { waitForLine } from './wait-for-line';

describe('LineReader и waitForLine: один читатель с буфером', () => {
  it('две строки одним куском: второе ожидание после первого видит вторую строку', async () => {
    const stream = new PassThrough();
    const first = waitForLine(stream, 'ready');
    stream.write('ready\ndone\n');
    expect(await first).toBe('ready');
    expect(await waitForLine(stream, 'done')).toBe('done');
  });

  it('строка, пришедшая между двумя ожиданиями, не теряется', async () => {
    const stream = new PassThrough();
    const first = waitForLine(stream, 'a');
    stream.write('a\n');
    await first;
    stream.write('b\n');
    await nextTurn();
    expect(await waitForLine(stream, 'b')).toBe('b');
  });

  it('«не напечатал done» не зелёное, когда done напечатан тем же куском', async () => {
    const stream = new PassThrough();
    const first = waitForLine(stream, 'ready');
    stream.write('ready\ndone\n');
    await first;
    await expect(expectPendingThrough(waitForLine(stream, 'done'), { turns: 5 })).rejects.toThrow(
      "разрешилась значением 'done'",
    );
  });

  it('курсор: совпавшая и все строки до неё прочитаны; следующая ищется после', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    stream.write('x 1\ny\nx 2\n');
    await nextTurn();
    expect(await reader.waitFor('y')).toBe('y');
    expect(await reader.waitFor('x')).toBe('x 2');
    stream.end();
    await expect(reader.waitFor('x 1')).rejects.toThrow('поток закончился без строки x 1');
  });

  it('строка по кускам, без перевода строки до конца потока — последняя строка тоже строка', async () => {
    const stream = new PassThrough();
    const tail = waitForLine(stream, /^last \d+$/);
    stream.write('la');
    stream.write('st 4');
    stream.end('2');
    expect(await tail).toBe('last 42');
  });

  it('одновременные ожидания — каждое получает свою строку', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    const term = reader.waitFor('term');
    const ready = reader.waitFor('ready');
    stream.write('ready 1\nterm 1\n');
    expect(await Promise.all([ready, term])).toEqual(['ready 1', 'term 1']);
  });

  it('поток закончился — ожидание без совпадения получает отказ с последними строками, новое — тоже', async () => {
    const stream = new PassThrough();
    const pending = waitForLine(stream, 'never');
    stream.end('1\n2\n3\n4\n5\n6\n');
    await expect(pending).rejects.toThrow('поток закончился без строки never; последние: 2 | 3 | 4 | 5 | 6');
    await expect(waitForLine(stream, 'never')).rejects.toThrow('без строки never');
    expect(await waitForLine(stream, '6')).toBe('6');
  });

  /** Отказ или «висит» — за 2 с: без 'close' ожидание на уничтоженном потоке не кончалось никогда. */
  const settleOrHang = async (pending: Promise<string>): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.then(
          (line) => `строка ${line}`,
          (error: Error) => `отказ: ${error.message}`,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('висит'), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  it('поток уничтожен без ошибки (destroy) — ожидания получают отказ, последняя неполная строка видна', async () => {
    const stream = new PassThrough();
    const waiting = waitForLine(stream, 'ready');
    stream.write('starting\npartial');
    await nextTurn();
    stream.destroy();
    expect(await settleOrHang(waiting)).toMatch(
      /^отказ: поток закрыт без строки ready; последние: starting \| partial$/,
    );
    expect(await settleOrHang(waitForLine(stream, 'later'))).toMatch(/^отказ: поток закрыт/);
  });

  it('читатель поднят на уже закончившемся или уничтоженном потоке — отказ, а не вечное ожидание', async () => {
    const ended = new PassThrough();
    ended.end();
    ended.resume();
    await new Promise((resolve) => ended.once('end', resolve));
    expect(await settleOrHang(waitForLine(ended, 'x'))).toMatch(/^отказ: поток закончился до подписки/);
    const destroyed = new PassThrough();
    destroyed.destroy();
    expect(await settleOrHang(waitForLine(destroyed, 'x'))).toMatch(/^отказ: поток закончился до подписки/);
  });

  it('ошибка потока — отказ с ней', async () => {
    const stream = new PassThrough();
    const pending = waitForLine(stream, 'x');
    stream.destroy(new Error('труба сломалась'));
    await expect(pending).rejects.toThrow('труба сломалась без строки x');
  });

  it('регулярное выражение с флагом g совпадает с каждой подходящей строкой, а не через раз', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    stream.write('id 1\nid 2\n');
    await nextTurn();
    const pattern = /^id \d$/g;
    expect([await reader.waitFor(pattern), await reader.waitFor(pattern)]).toEqual(['id 1', 'id 2']);
  });

  it('onLine видит каждую строку и ничего не потребляет; отписка работает', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    const seen: string[] = [];
    const off = reader.onLine((line) => seen.push(line));
    stream.write('a\nb\n');
    await nextTurn();
    off();
    stream.write('c\n');
    await nextTurn();
    expect(seen).toEqual(['a', 'b']);
    expect(await reader.waitFor('a')).toBe('a');
  });

  it('один поток — один читатель', () => {
    const stream = new PassThrough();
    expect(LineReader.of(stream)).toBe(LineReader.of(stream));
    expect(LineReader.of(new PassThrough())).not.toBe(LineReader.of(stream));
  });

  it('CRLF: завершающий \\r снимается — /^ready$/ совпадает', async () => {
    const stream = new PassThrough();
    const ready = waitForLine(stream, /^ready$/);
    stream.write('ready\r\nnext\r');
    stream.end();
    expect(await ready).toBe('ready');
    expect(await waitForLine(stream, /^next$/)).toBe('next');
  });

  it('непрочитанных строк не больше maxUnread: старейшие отброшены, отказ называет число', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    const total = LineReader.maxUnread + 3;
    stream.end(Array.from({ length: total }, (_, index) => `line ${index}`).join('\n'));
    await nextTurn();
    await expect(reader.waitFor(/^line 2$/)).rejects.toThrow(
      'непрочитанных строк отброшено сверх потолка: 3',
    );
    expect(await reader.waitFor(/^line 3$/)).toBe('line 3');
  });

  it('курсор: строка, совпавшая с ЖДУЩИМ, делает прочитанными и непрочитанные строки до неё', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    stream.write('early\n');
    await nextTurn();
    const late = reader.waitFor('late');
    stream.write('late\n');
    expect(await late).toBe('late');
    stream.end();
    await expect(reader.waitFor('early')).rejects.toThrow('без строки early');
  });

  it('символ UTF-8, разрезанный границей куска, собирается: строка находится, а не превращается в «�»', async () => {
    const stream = new PassThrough();
    const ready = waitForLine(stream, 'сервер готов');
    const bytes = Buffer.from('сервер готов\n');
    // Середина второй буквы: «е» — два байта, кусок кончается на первом.
    stream.write(bytes.subarray(0, 3));
    await nextTurn();
    stream.write(bytes.subarray(3));
    expect(await ready).toBe('сервер готов');
  });

  it('граница куска трубы (64 КиБ) внутри «ё» после длинного вывода — ожидание русской строки находит её', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    const ready = reader.waitFor('всё готово');
    // 65 530 + перевод строки + «в», «с» по два байта = 65 535: первый кусок в 65 536 байт кончается
    // ровно на первом байте «ё».
    const filler = 'x'.repeat(65_530);
    const bytes = Buffer.from(`${filler}\nвсё готово\n`);
    const cut = 65_536;
    expect(bytes.subarray(cut - 1, cut + 1)).toEqual(Buffer.from('ё'));
    stream.write(bytes.subarray(0, cut));
    await nextTurn();
    stream.end(bytes.subarray(cut));
    expect(await ready).toBe('всё готово');
  });

  it('конец потока сразу после разрезанного символа — хвост декодируется, а не теряется', async () => {
    const stream = new PassThrough();
    const reader = LineReader.of(stream);
    const lines: string[] = [];
    reader.onLine((line) => lines.push(line));
    const bytes = Buffer.from('конец');
    stream.write(bytes.subarray(0, 3));
    await nextTurn();
    stream.end(bytes.subarray(3));
    await expect(reader.waitFor('нет такой')).rejects.toThrow('поток закончился');
    expect(lines).toEqual(['конец']);
  });

  it('пустой образец — отказ: пустая подстрока совпала бы с первой же строкой', async () => {
    const stream = new PassThrough();
    stream.write('что угодно\n');
    await expect(waitForLine(stream, '')).rejects.toThrow('образец строки пуст');
    await expect(LineReader.of(stream).waitFor('')).rejects.toThrow(TypeError);
    expect(await waitForLine(stream, 'что угодно')).toBe('что угодно');
  });

  it('длинная строка мелкими кусками — линейная работа: время потока на куски ~ как на один кусок', async () => {
    // Доля, а не порог в мс: процессорное время ЭТОГО потока на 8 МиБ кусками по 8 КиБ против 8 МиБ одним
    // куском. Прежняя склейка `хвост + кусок` и разбиение всего хвоста на каждом куске давали квадрат: по
    // замеру — больше чем в 100 раз; линейная — около 1–3 раз. Отношение от скорости машины не зависит.
    const text = 'y'.repeat(8 * 1024 * 1024);
    const cpu = (): number => {
      const usage = process.threadCpuUsage();
      return usage.user + usage.system;
    };
    const feed = (chunks: readonly string[]): number => {
      const stream = new PassThrough({ objectMode: true });
      const reader = LineReader.of(stream);
      const lines: number[] = [];
      reader.onLine((line) => lines.push(line.length));
      const started = cpu();
      for (const chunk of chunks) {
        stream.emit('data', chunk);
      }
      stream.emit('data', '\n');
      const spent = cpu() - started;
      expect(lines).toEqual([text.length]);
      return spent;
    };
    const step = 8 * 1024;
    const pieces = Array.from({ length: text.length / step }, (_, index) =>
      text.slice(index * step, (index + 1) * step),
    );
    const whole = Math.max(feed([text]), 1000);
    const chunked = feed(pieces);
    expect(chunked / whole).toBeLessThan(20);
  });
});
