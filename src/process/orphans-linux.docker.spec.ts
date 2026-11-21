import { runInContainer } from '../testing/run-in-container';

/**
 * Таблица процессов Linux (`/proc`, без `ps`) — в контейнере glibc. Node —
 * PID 1 без init: сирота переходит к нему и после SIGKILL остаётся зомби
 * (её никто не подбирает) — `orphansOf` зомби не считает.
 */
const SCRIPT = `
const { spawnBehindShell, waitForLine, processInfoOf } = require('/pkg/dist/process/index.js');
(async () => {
  const reporter = "console.log('pid', process.pid, process.ppid); setInterval(() => undefined, 1 << 30);";
  const wrapped = spawnBehindShell(process.execPath, ['-e', reporter], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [, pid, ppid] = (await waitForLine(wrapped.shell.stdout, /^pid \\d+ \\d+$/)).split(' ').map(Number);
  await wrapped.descendants();
  wrapped.signal('SIGTERM');
  const exit = await wrapped.exited;
  const orphans = (await wrapped.orphans()).map((info) => info.pid);
  const parentAfter = (await processInfoOf(pid)).ppid;
  process.kill(pid, 'SIGKILL');
  for (;;) {
    const info = await processInfoOf(pid);
    if (info === undefined || info.state.startsWith('Z')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const afterKill = (await wrapped.orphans()).map((info) => info.pid);
  await wrapped.close();
  console.log(JSON.stringify({ parentWasShell: ppid === wrapped.pid, exit, orphansAreCommand: orphans.length === 1 && orphans[0] === pid, parentAfter, afterKill }));
})().catch((error) => { console.log(JSON.stringify({ crashed: String(error) })); });
`;

describe('сироты на Linux (/proc) в контейнере', () => {
  it('команда за оболочкой переживает SIGTERM оболочке и находится; после SIGKILL зомби не считается', async () => {
    expect(await runInContainer(SCRIPT)).toEqual({
      parentWasShell: true,
      exit: { code: null, signal: 'SIGTERM' },
      orphansAreCommand: true,
      parentAfter: 1,
      afterKill: [],
    });
  });
});
