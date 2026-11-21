// The freezing proxy's controls and the fake DNS server with Node's own resolver.
import { Resolver } from 'node:dns/promises';
import { dockerDnsArgs, FakeDnsServer } from '@hoshinotatsuya/fault-kit/dns';
import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';

it('proxy controls', async () => {
  await using proxy = await FaultProxy.start({ host: '127.0.0.1', port: 5432 });
  proxy.latency(500); // every event in both directions, closes included
  proxy.latency(0);
  proxy.drop(); // RST to current connections; drop('close') sends FIN
  proxy.blackholeNew(); // new connections are accepted and never served
  expect(proxy.stats()).toMatchObject({ accepted: 0, active: 0 });
});

it('DNS: records, NXDOMAIN, silence', async () => {
  await using dns = await FakeDnsServer.start({ records: { 'api.test': ['10.1.2.3', '2001:db8::7'] } });
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([dns.address]);

  expect(await resolver.resolve4('api.test')).toEqual(['10.1.2.3']);
  await expect(resolver.resolve4('missing.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });

  dns.silence(); // queries are received and never answered
  const pending = resolver.resolve4('api.test');
  await dns.waitForQueries(3); // "the query arrived" — an event, not a timer
  resolver.cancel(); // otherwise the query lives until the resolver's own timeout
  await expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
});

// getaddrinfo reads only /etc/resolv.conf, so it is tested inside a container whose resolver points at the fake server.
export const dockerArgs = ['run', '--rm', ...dockerDnsArgs({ timeoutSeconds: 1, attempts: 1 }), 'node:24-bookworm-slim'];
