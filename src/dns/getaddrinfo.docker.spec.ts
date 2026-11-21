import { runInContainer } from '../testing/run-in-container';
import { dockerDnsArgs } from './docker-dns-args';

/**
 * getaddrinfo (`dns.lookup`) читает только resolv.conf, порт там не задать —
 * поэтому проверка в контейнере: `dockerDnsArgs()` направляет резолвер на
 * 127.0.0.1, а программа в контейнере сама поднимает `FakeDnsServer` на :53.
 * Ни один пакет из контейнера не уходит.
 */
const SCRIPT = `
const dns = require('node:dns');
const { FakeDnsServer } = require('/pkg/dist/dns/index.js');
const lookup = (name) => new Promise((resolve) =>
  dns.lookup(name, { family: 4 }, (error, address) => resolve(error ? { error: error.code } : { address })));
(async () => {
  const server = await FakeDnsServer.start({ host: '127.0.0.1', port: 53, records: { 'api.test': ['10.1.2.3'] } });
  const answered = await lookup('api.test');
  server.silence();
  const before = server.queries().length;
  const silent = await lookup('silent.test');
  const silentQueries = server.queries().slice(before).map((q) => q.name);
  await server.close();
  console.log(JSON.stringify({ answered, silent, silentQueries }));
})().catch((error) => { console.log(JSON.stringify({ crashed: String(error) })); });
`;

describe('getaddrinfo в контейнере через FakeDnsServer', () => {
  it('ответ — заданный адрес; молчание — запрос дошёл, ответа нет, EAI_AGAIN после потолка resolv.conf', async () => {
    const result = (await runInContainer(SCRIPT, dockerDnsArgs({ timeoutSeconds: 1, attempts: 1 }))) as {
      silentQueries: string[];
    };
    expect(result).toEqual({
      answered: { address: '10.1.2.3' },
      silent: { error: 'EAI_AGAIN' },
      silentQueries: expect.any(Array),
    });
    expect(result.silentQueries.length).toBeGreaterThanOrEqual(1);
    expect(new Set(result.silentQueries)).toEqual(new Set(['silent.test']));
  });
});
