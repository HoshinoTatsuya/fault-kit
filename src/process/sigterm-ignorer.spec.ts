import { type ChildProcess, spawn } from 'node:child_process';

import { expectPendingThrough } from '../assert/expect-pending-through';
import { settledResources } from '../testing/settled-resources';
import { processInfoOf } from './process-info-of';
import { signalQuietly } from './signal-quietly';
import { SigtermIgnorer } from './sigterm-ignorer';
import { sigtermIgnorerCommand } from './sigterm-ignorer-command';
import { spawnBehindShell } from './spawn-behind-shell';
import { waitForLine } from './wait-for-line';

describe('процесс, игнорирующий SIGTERM', () => {
  it('SIGTERM дошёл (событие) и не завершил процесс; SIGKILL — завершил', async () => {
    await using ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    for (let round = 1; round <= 2; round += 1) {
      const term = ignorer.nextTerm();
      signalQuietly(ignorer.pid, 'SIGTERM');
      await expectPendingThrough(ignorer.exited, term, 'выход после SIGTERM');
      expect(ignorer.terms).toBe(round);
    }
    expect((await processInfoOf(ignorer.pid))?.state.startsWith('Z')).toBe(false);
    await ignorer.close();
    expect(await ignorer.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('за оболочкой: SIGTERM всей группе убивает оболочку, а игнорирующий остаётся сиротой', async () => {
    const { command, args } = sigtermIgnorerCommand();
    await using wrapped = spawnBehindShell(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout = wrapped.shell.stdout;
    if (stdout === null) {
      throw new Error('нет stdout');
    }
    const pid = Number((await waitForLine(stdout, /^ready \d+$/)).split(' ')[1]);
    try {
      await wrapped.descendants();
      const term = waitForLine(stdout, `term ${pid}`);
      wrapped.signalGroup('SIGTERM');
      await term;
      expect(await wrapped.exited).toEqual({ code: null, signal: 'SIGTERM' });
      expect((await wrapped.orphans()).map((info) => info.pid)).toEqual([pid]);
    } finally {
      // Сирота SIGTERM игнорирует и группу оболочки покинула: close() её не
      // добивает. Без этого прогон оставлял живые процессы (16.11.2026 — три).
      signalQuietly(pid, 'SIGKILL');
    }
  });

  it('close освобождает процесс и трубы', async () => {
    const baseline = await settledResources();
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    await ignorer.close();
    expect(await settledResources()).toEqual(baseline);
  });

  it('процесс умер: ожидающий nextTerm и новый nextTerm — отказ, а не вечное ожидание', async () => {
    const ignorer = SigtermIgnorer.start();
    try {
      await ignorer.ready;
      const term = ignorer.nextTerm();
      signalQuietly(ignorer.pid, 'SIGKILL');
      await expect(term).rejects.toThrow(`процесс ${ignorer.pid} завершился (SIGKILL)`);
      await expect(ignorer.nextTerm()).rejects.toThrow('не дождавшись события');
    } finally {
      await ignorer.close();
    }
  });

  it('процесс умер до готовности — ready отклонено с кодом выхода', async () => {
    const create = SigtermIgnorer as unknown as new (child: ChildProcess) => SigtermIgnorer;
    const ignorer = new create(
      spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    await expect(ignorer.ready).rejects.toThrow(
      `процесс ${ignorer.pid} завершился (код 3), не дождавшись события`,
    );
    await ignorer.close();
  });
});
