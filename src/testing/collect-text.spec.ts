import { PassThrough } from 'node:stream';

import { collectText } from './collect-text';

describe('collectText (вывод контейнера в runInContainer)', () => {
  it('символ, разрезанный границей куска, собирается, а не превращается в «�»', async () => {
    const stream = new PassThrough();
    const text = collectText(stream);
    const bytes = Buffer.from('{"итог":"всё"}\n');
    for (let at = 0; at < bytes.length; at += 1) {
      stream.write(bytes.subarray(at, at + 1));
    }
    stream.end();
    await new Promise<void>((resolve) => stream.once('end', () => resolve()));
    expect(text()).toBe('{"итог":"всё"}\n');
  });
});
