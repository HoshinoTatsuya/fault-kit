// A shell wrapper without exec and its orphans; a process that ignores SIGTERM. Linux or macOS.
import { SigtermIgnorer, spawnBehindShell } from '@hoshinotatsuya/fault-kit/process';

it('a signal to the shell only leaves the command an orphan', async () => {
  await using wrapped = spawnBehindShell('sleep', ['30'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const snapshot = await wrapped.descendants(); // while the tree runs, BEFORE the signal
  wrapped.signal('SIGTERM'); // only the shell — like a defective runner
  await wrapped.exited;
  expect(await wrapped.orphans(snapshot)).toHaveLength(1); // close() kills it on dispose
});

it('a process that ignores SIGTERM', async () => {
  await using ignorer = SigtermIgnorer.start();
  await ignorer.ready;
  const term = ignorer.nextTerm();
  process.kill(ignorer.pid, 'SIGTERM');
  await term; // delivered and ignored: the process is known to be alive
});
