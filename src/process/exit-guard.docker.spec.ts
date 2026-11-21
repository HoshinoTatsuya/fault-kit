import { runInContainer } from '../testing/run-in-container';

/**
 * Спека упала, не вызвав close(), и процесс спеки вышел штатно: запущенное
 * пакетом добито обработчиком выхода. В контейнере — процесс, который
 * запускает и выходит, а проверяющий смотрит таблицу после его выхода.
 */
const SCRIPT = `
const { spawnSync } = require('node:child_process');
const { processInfoOf } = require('/pkg/dist/process/index.js');
const child = \`
  const { SigtermIgnorer, spawnBehindShell, waitForLine } = require('/pkg/dist/process/index.js');
  (async () => {
    const ignorer = SigtermIgnorer.start();
    await ignorer.ready;
    const wrapped = spawnBehindShell(process.execPath, ['-e', "console.log('pid', process.pid); setInterval(() => {}, 1e9)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const line = await waitForLine(wrapped.shell.stdout, /^pid [0-9]+$/);
    console.log(JSON.stringify({ ignorer: ignorer.pid, command: Number(line.split(' ')[1]) }));
    process.exit(0);
  })();
\`;
(async () => {
  const run = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 20000 });
  const pids = JSON.parse(run.stdout.trim().split('\\n').pop());
  const alive = async (pid) => { const info = await processInfoOf(pid); return info !== undefined && !info.state.startsWith('Z'); };
  const result = {};
  for (const [name, pid] of Object.entries(pids)) {
    for (let i = 0; i < 100 && (await alive(pid)); i += 1) await new Promise((r) => setTimeout(r, 20));
    result[name] = await alive(pid);
  }
  console.log(JSON.stringify(result));
})().catch((error) => console.log(JSON.stringify({ crashed: String(error) })));
`;

describe('ExitGuard при настоящем выходе процесса (контейнер)', () => {
  it('SigtermIgnorer и команда за оболочкой без close() — мертвы после выхода запустившего', async () => {
    expect(await runInContainer(SCRIPT)).toEqual({ ignorer: false, command: false });
  });
});
