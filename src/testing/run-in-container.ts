import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { collectText } from './collect-text';

/**
 * Выполнить программу Node в одноразовом контейнере node:24-bookworm-slim
 * (glibc, Linux) с собранным `dist` пакета в /pkg/dist и вернуть последнюю
 * строку вывода, разобранную как JSON.
 *
 * `dist` приезжает в контейнер архивом через stdin, а не томом: при
 * docker-in-docker (CI) путь тома искался бы на машине демона, где его нет.
 * `--rm`: контейнер удаляется при любом исходе; потолок — таймаут теста и
 * свой таймер (по нему процесс docker снимается).
 */
export const runInContainer = async (
  script: string,
  dockerArgs: readonly string[] = [],
): Promise<unknown> => {
  const dist = resolve(__dirname, '..', '..', 'dist');
  // Имя — чтобы по таймауту снять сам контейнер: убитый клиент docker его не останавливает.
  const name = `fault-kit-spec-${randomBytes(6).toString('hex')}`;
  const tar = spawn('tar', ['-C', dist, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const docker = spawn(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      ...dockerArgs,
      process.env.FAULT_KIT_DOCKER_IMAGE ?? 'node:24-bookworm-slim',
      'sh',
      '-c',
      'mkdir -p /pkg/dist && tar -xf - -C /pkg/dist && exec node -e "$0"',
      script,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  tar.stdout.pipe(docker.stdin);
  // docker вышел, не дочитав архив (неверный аргумент, нет демона или образа):
  // Node закрывает его stdin, pipe отцепляется, и tar, которому некуда писать,
  // висел бы до таймера (проба в контейнере: tar не выходит); запись в уже
  // закрытую трубу — EPIPE на stdin без обработчика. Чтение tar закрывается —
  // tar получает SIGPIPE и выходит; коды покажет отказ ниже.
  const stopTar = (): void => {
    tar.stdout.destroy();
  };
  docker.stdin.on('error', stopTar);
  docker.stdin.on('close', stopTar);
  const failedToStart = new Promise<never>((_, reject) => {
    for (const [tool, child] of [
      ['tar', tar],
      ['docker', docker],
    ] as const) {
      child.once('error', (error) =>
        reject(new Error(`не запустился ${tool} (нужен ${tool} в PATH): ${error.message}`)),
      );
    }
  });
  failedToStart.catch(() => undefined);
  const stdoutText = collectText(docker.stdout);
  const timer = setTimeout(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    docker.kill('SIGKILL');
  }, 100_000);
  try {
    const [tarCode, dockerCode] = await Promise.race([
      failedToStart,
      Promise.all(
        [tar, docker].map(
          (child) => new Promise<number | null>((done) => child.once('close', (code) => done(code))),
        ),
      ),
    ]);
    if (tarCode !== 0 || dockerCode !== 0) {
      throw new Error(
        `контейнер не отработал: tar ${tarCode}, docker ${dockerCode}; вывод: ${stdoutText().slice(-500)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
  const output = stdoutText().trim();
  if (output === '') {
    throw new Error('контейнер ничего не напечатал: ожидалась последняя строка вывода в JSON');
  }
  const lines = output.split('\n');
  return JSON.parse(lines[lines.length - 1] as string);
};
