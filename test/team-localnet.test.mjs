// macOS Local Network permission: denial classifier, verdict over several attempts, state merge, probe targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { isLocalNetworkDenied, localNetworkVerdict, pollVerdict, nextLocalNetwork, parseGateway, localProbeTargets, probeLan, defaultGateway, resetGatewayCache, GATEWAY_TTL_MS, LOCAL_NETWORK_SETTINGS_URL, PRIVACY_SETTINGS_URL } from '../team/localnet.mjs';

const IFACES = { en0: [{ family: 'IPv4', address: '192.168.77.120', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
const MAC = { platform: 'darwin', ifaces: IFACES };

test('isLocalNetworkDenied: EHOSTUNREACH to my /24 on macOS → denied', () => {
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '192.168.77.31:7331', MAC), true);
  assert.equal(isLocalNetworkDenied('ENETUNREACH', '192.168.77.31:7331', MAC), true);
  // the shapes fetch / net errors come in
  assert.equal(isLocalNetworkDenied({ code: 'EHOSTUNREACH' }, '192.168.77.31:7331', MAC), true);
  assert.equal(isLocalNetworkDenied({ cause: { code: 'EHOSTUNREACH' } }, '192.168.77.31', MAC), true);
});

test('isLocalNetworkDenied: other subnet, other errors, loopback, bad input → not denied', () => {
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '192.168.78.31:7331', MAC), false);
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '10.0.0.5:7331', MAC), false);
  for (const e of ['ECONNREFUSED', 'timeout', 'ETIMEDOUT', 'token mismatch', 'HTTP 500', '', null, undefined]) assert.equal(isLocalNetworkDenied(e, '192.168.77.31:7331', MAC), false, String(e));
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '127.0.0.1:7331', MAC), false);
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', 'pc.local:7331', MAC), false);
  assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '', MAC), false);
});

test('isLocalNetworkDenied: never on other platforms', () => {
  for (const platform of ['linux', 'win32']) assert.equal(isLocalNetworkDenied('EHOSTUNREACH', '192.168.77.31:7331', { platform, ifaces: IFACES }), false);
});

test('localNetworkVerdict: any success → ok; all denied → denied; else unknown', () => {
  const den = { host: '192.168.77.31:7331', ok: false, error: 'EHOSTUNREACH' };
  assert.equal(localNetworkVerdict([den, { host: '192.168.77.32:7331', ok: true }], MAC), 'ok');
  assert.equal(localNetworkVerdict([den, { ...den, host: '192.168.77.1:80' }], MAC), 'denied');
  assert.equal(localNetworkVerdict([den, { host: '192.168.77.1:80', ok: false, error: 'timeout' }], MAC), 'unknown');
  assert.equal(localNetworkVerdict([{ ...den, host: '10.0.0.5:7331' }], MAC), 'unknown');
  assert.equal(localNetworkVerdict([], MAC), 'unknown');
  assert.equal(localNetworkVerdict(null, MAC), 'unknown');
  // other platforms: ok / unknown only
  assert.equal(localNetworkVerdict([den], { platform: 'linux', ifaces: IFACES }), 'unknown');
  assert.equal(localNetworkVerdict([{ ...den, ok: true }], { platform: 'linux', ifaces: IFACES }), 'ok');
});

test('nextLocalNetwork: evidence replaces the state, unknown keeps it', () => {
  assert.equal(nextLocalNetwork('unknown', 'denied'), 'denied');
  assert.equal(nextLocalNetwork('denied', 'unknown'), 'denied');
  assert.equal(nextLocalNetwork('denied', 'ok'), 'ok');
  assert.equal(nextLocalNetwork('ok', 'denied'), 'denied');
  assert.equal(nextLocalNetwork(undefined, 'unknown'), 'unknown');
  assert.equal(nextLocalNetwork('ok', 'garbage'), 'ok');
});

test('parseGateway reads `route -n get default`', () => {
  assert.equal(parseGateway('   route to: default\ndestination: default\n    gateway: 192.168.77.1\n  interface: en0\n'), '192.168.77.1');
  assert.equal(parseGateway('route: writing to routing socket: not in table'), '');
  assert.equal(parseGateway('    gateway: fe80::1%en0'), '');
  assert.equal(parseGateway(undefined), '');
});

test('localProbeTargets: same-subnet teammate first, then gateway (or <my /24>.1), at most 2', () => {
  const peers = [{ name: 'far', host: '10.0.0.5:7331' }, { name: 'me', host: '127.0.0.1:7331' }, { name: 'will', host: '192.168.77.31:7331' }];
  assert.deepEqual(localProbeTargets(peers, '192.168.77.1', IFACES), ['192.168.77.31:7331', '192.168.77.1:80']);
  assert.deepEqual(localProbeTargets([], '192.168.77.1', IFACES), ['192.168.77.1:80']);
  // gateway on another subnet / unknown → <my /24>.1
  assert.deepEqual(localProbeTargets([], '10.1.1.1', IFACES), ['192.168.77.1:80']);
  assert.deepEqual(localProbeTargets([], '', IFACES), ['192.168.77.1:80']);
  // the teammate is the gateway address: not twice
  assert.deepEqual(localProbeTargets([{ name: 'gw', host: '192.168.77.1:7331' }], '192.168.77.1', IFACES), ['192.168.77.1:7331']);
  // no LAN interface at all → nothing to knock on
  assert.deepEqual(localProbeTargets(peers, '', { lo0: IFACES.lo0 }), []);
});

test('probeLan: connected or refused counts as getting through; nothing is sent', async () => {
  let got = '';
  const srv = createServer(s => s.on('data', d => { got += d; }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.deepEqual(await probeLan(`127.0.0.1:${port}`), { host: `127.0.0.1:${port}`, ok: true, error: '' });
  await new Promise(r => srv.close(r));
  const refused = await probeLan(`127.0.0.1:${port}`);
  assert.equal(refused.ok, true); assert.equal(refused.error, 'ECONNREFUSED');
  assert.equal(got, '');
});

test('Settings URLs: the Local Network pane, then Privacy & Security', () => {
  assert.equal(LOCAL_NETWORK_SETTINGS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
  assert.match(PRIVACY_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy$/);
});

test('localNetworkVerdict: a loopback teammate (this PC) says nothing — it cannot hide a denial', () => {
  const den = { host: '192.168.77.31:7331', ok: false, error: 'EHOSTUNREACH' };
  assert.equal(localNetworkVerdict([{ host: '127.0.0.1:1', ok: true }, den], MAC), 'denied');
  assert.equal(localNetworkVerdict([{ host: 'localhost:7331', ok: true }, den], MAC), 'denied');
  assert.equal(localNetworkVerdict([{ host: '127.0.0.1:1', ok: true }], MAC), 'unknown');
  // teamPoll's shape: [{ p: peer, r: fetch result }]
  assert.equal(pollVerdict([{ p: { host: '127.0.0.1:7441' }, r: { ok: true } }, { p: { host: den.host }, r: { ok: false, error: 'EHOSTUNREACH' } }], MAC), 'denied');
  assert.equal(pollVerdict([{ p: { host: '192.168.77.32:7331' }, r: { ok: true } }, { p: { host: den.host }, r: { ok: false, error: 'EHOSTUNREACH' } }], MAC), 'ok');
  assert.equal(pollVerdict(null, MAC), 'unknown');
});

// a fake socket for probeLan: what the OS would report
function fakeSocket(act) {
  return () => {
    const s = new EventEmitter(); s.destroyed = false;
    s.setTimeout = (ms, cb) => { if (act === 'timeout') setImmediate(cb); };
    s.destroy = () => { s.destroyed = true; };
    if (act !== 'timeout') setImmediate(() => s.emit('error', Object.assign(new Error(act), { code: act })));
    return s;
  };
}
test('probeLan: a timeout counts as getting through; EHOSTUNREACH does not', async () => {
  assert.deepEqual(await probeLan('192.168.77.1:80', 1500, { connectFn: fakeSocket('timeout') }), { host: '192.168.77.1:80', ok: true, error: 'timeout' });
  assert.deepEqual(await probeLan('192.168.77.1:80', 1500, { connectFn: fakeSocket('EHOSTUNREACH') }), { host: '192.168.77.1:80', ok: false, error: 'EHOSTUNREACH' });
  assert.equal((await probeLan('192.168.77.1:80', 1500, { connectFn: fakeSocket('ECONNRESET') })).ok, true);
  assert.equal((await probeLan('192.168.77.1:80', 1500, { connectFn: fakeSocket('ENETUNREACH') })).ok, false);
});

test('defaultGateway: one `route` run per minute, again at once when my addresses change', async () => {
  resetGatewayCache();
  let runs = 0; const run = async () => { runs++; return '192.168.77.1'; };
  const base = { platform: 'darwin', ifaces: IFACES, run };
  assert.equal(await defaultGateway({ ...base, now: 0 }), '192.168.77.1');
  assert.equal(await defaultGateway({ ...base, now: 5000 }), '192.168.77.1');
  assert.equal(runs, 1);
  await defaultGateway({ ...base, now: GATEWAY_TTL_MS + 1 });
  assert.equal(runs, 2, 'expired');
  await defaultGateway({ ...base, now: GATEWAY_TTL_MS + 2, ifaces: { en0: [{ family: 'IPv4', address: '10.0.0.7', internal: false }] } });
  assert.equal(runs, 3, 'network changed');
  assert.equal(await defaultGateway({ ...base, platform: 'linux' }), '');
  resetGatewayCache();
});
