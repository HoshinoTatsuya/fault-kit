import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realProcess } from '../real-process';
import { runInContainer } from '../testing/run-in-container';

/**
 * Помощник спек `runInContainer` против ПОДДЕЛЬНОГО `docker` в PATH. Спека
 * лежит здесь, а не рядом с помощником: она запускает процессы, а такие
 * спеки идут только в одноразовом Linux-контейнере (`pnpm run test:process`).
 */
describe('runInContainer: отказы docker', () => {
  let bin: string;
  let path: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'fake-docker-'));
    // PATH настоящего процесса: spawn читает его, а не копию окружения, которую jest отдаёт спеке.
    path = realProcess.env.PATH;
    realProcess.env.PATH = `${bin}:${path ?? ''}`;
  });

  afterEach(() => {
    realProcess.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  const fakeDocker = (body: string): void => {
    const file = join(bin, 'docker');
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  /** docker вышел сразу (неверный аргумент, нет демона), пока tar ещё пишет dist: запись в закрытую трубу — EPIPE. */
  it('docker вышел, не читая stdin, — отказ с кодами, а не tar, висящий до таймера', async () => {
    fakeDocker('exit 125');
    await expect(runInContainer('console.log(1)')).rejects.toThrow(/контейнер не отработал: .*docker 125/);
  });

  it('контейнер ничего не напечатал — отказ с причиной, а не SyntaxError разбора', async () => {
    fakeDocker('cat >/dev/null; exit 0');
    await expect(runInContainer('void 0')).rejects.toThrow('контейнер ничего не напечатал');
  });
});
