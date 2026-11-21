import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { runInContainer } from '../testing/run-in-container';

/**
 * `killClients({ ip: '::1' })` на НАСТОЯЩЕМ Redis: сервер печатает IPv6 в
 * `CLIENT LIST` в скобках (`addr=[::1]:59086`), и прежний разбор адреса
 * («всё до последнего двоеточия») давал `[::1]` — фильтр не находил никого.
 *
 * Redis — в своём контейнере без сети, слушает 127.0.0.1 и ::1; программа
 * Node — в контейнере, разделяющем его сетевое пространство
 * (`--network container:<redis>`), и подключается к нему по обоим адресам.
 * Клиент Redis — свой, на сокете: в контейнер приезжает только `dist`.
 */
const SCRIPT = `
const net = require('node:net');
const { RedisFaults } = require('/pkg/dist/redis/index.js');
const open = (host) => new Promise((resolve, reject) => {
  const socket = net.connect(6379, host);
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let closed = false;
  const parse = () => {
    const end = buffer.indexOf('\\r\\n');
    if (end < 0) return undefined;
    const kind = String.fromCharCode(buffer[0]);
    const line = buffer.subarray(1, end).toString('utf8');
    if (kind === '$') {
      const length = Number(line);
      if (length < 0) { buffer = buffer.subarray(end + 2); return { value: null }; }
      if (buffer.length < end + 2 + length + 2) return undefined;
      const value = buffer.subarray(end + 2, end + 2 + length).toString('utf8');
      buffer = buffer.subarray(end + 2 + length + 2);
      return { value };
    }
    buffer = buffer.subarray(end + 2);
    if (kind === '-') return { error: new Error(line) };
    return { value: kind === ':' ? Number(line) : line };
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let reply = parse(); reply !== undefined; reply = parse()) {
      const waiter = waiters.shift();
      if (reply.error) waiter.reject(reply.error); else waiter.resolve(reply.value);
    }
  });
  socket.on('close', () => { closed = true; for (const w of waiters.splice(0)) w.reject(new Error('закрыто')); });
  socket.on('error', () => undefined);
  socket.once('connect', () => resolve({
    call: (...args) => new Promise((ok, fail) => {
      waiters.push({ resolve: ok, reject: fail });
      socket.write('*' + args.length + '\\r\\n' + args.map((a) => { const s = String(a); return '$' + Buffer.byteLength(s) + '\\r\\n' + s + '\\r\\n'; }).join(''));
    }),
    closed: () => closed,
    whenClosed: () => new Promise((done) => (closed ? done() : socket.once('close', done))),
    end: () => socket.destroy(),
  }));
  socket.once('error', reject);
});
(async () => {
  const admin = await open('127.0.0.1');
  const victim = await open('::1');
  const bystander = await open('127.0.0.1');
  await victim.call('CLIENT', 'SETNAME', 'victim6');
  const victimId = await victim.call('CLIENT', 'ID');
  const bystanderId = await bystander.call('CLIENT', 'ID');
  const victimAddr = /addr=(\\S+)/.exec(await victim.call('CLIENT', 'INFO'))[1];
  const version = /redis_version:(\\S+)/.exec(await admin.call('INFO', 'server'))[1];
  const faults = new RedisFaults(admin);
  const byIp = await faults.killClients({ ip: '::1' });
  await victim.whenClosed();
  const bystanderAfter = await bystander.call('CLIENT', 'ID');
  const victim2 = await open('::1');
  const victim2Id = await victim2.call('CLIENT', 'ID');
  const victim2Addr = /addr=(\\S+)/.exec(await victim2.call('CLIENT', 'INFO'))[1];
  const byAddr = await faults.killClients({ addr: victim2Addr });
  await victim2.whenClosed();
  const result = {
    version,
    victimAddrBracketed: /^\\[::1\\]:\\d+$/.test(victimAddr),
    byIpIsVictim: byIp.length === 1 && byIp[0] === victimId,
    bystanderUntouched: bystanderAfter === bystanderId,
    byAddrIsVictim: byAddr.length === 1 && byAddr[0] === victim2Id,
  };
  admin.end(); bystander.end();
  console.log(JSON.stringify(result));
})().catch((error) => console.log(JSON.stringify({ crashed: String(error && error.stack || error) })));
`;

const IMAGES = (process.env.FAULT_KIT_REDIS_IMAGES ?? 'redis:7.4-alpine,redis:8-alpine').split(',');

const docker = (args: readonly string[]): string => {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) {
    throw new Error(`docker ${args.join(' ')}: ${run.stderr}`);
  }
  return run.stdout;
};

describe('killClients по IPv6 на настоящем Redis (контейнер)', () => {
  it.each(IMAGES.map((image) => [image]))(
    '%s: ip "::1" и addr "[::1]:порт" находят ровно клиента с ::1',
    async (image) => {
      const name = `fault-kit-redis6-${randomBytes(6).toString('hex')}`;
      docker([
        'run',
        '-d',
        '--rm',
        '--network',
        'none',
        '--name',
        name,
        image,
        'redis-server',
        '--bind',
        '127.0.0.1 ::1',
        '--save',
        '',
      ]);
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            spawnSync('docker', ['exec', name, 'redis-cli', 'ping'], { encoding: 'utf8' }).stdout.includes(
              'PONG',
            )
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const result = (await runInContainer(SCRIPT, ['--network', `container:${name}`])) as Record<
          string,
          unknown
        >;
        expect({ ...result, version: typeof result.version }).toEqual({
          version: 'string',
          victimAddrBracketed: true,
          byIpIsVictim: true,
          bystanderUntouched: true,
          byAddrIsVictim: true,
        });
      } finally {
        spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
      }
    },
  );
});
