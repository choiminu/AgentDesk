// Team sharing: config parsing, snapshot sanitizing, signed HTTP requests / responses, peer fetch, notes, discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pingPeerSigned, classifyMove, onHomeNetwork, withHomeSubnets, NONCE_TTL_MS, NONCE_MAX, NONCE_PER_IP } from '../team/peer.mjs';
import { readTeamConfig, writeTeamExample, sanitizeSessions, startTeamServer, fetchPeer, TEAM_EXAMPLE, signRequest, requestSignature, responseSignature, verifyRequest, createNonceGuard, noteRateCheck, validHostHeader, sameSubnet, myPrefixes, SESSIONS_MAX, RESPONSE_MAX } from '../team/peer.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentdesk-team-'));
const ID = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };
// a signed request the way fetchPeer / postNote build it (for tests that need to send something odd)
const signedFetch = (host, token, method, path, body = '', extra = {}) => {
  const s = signRequest(token, method, host, path, body);
  return fetch(`http://${host}${path}`, { method, headers: { ...s.headers, Host: host, ...extra }, body: body || undefined });
};

test('readTeamConfig: missing → null, example token → error, valid → normalized; no token → 127.0.0.1 and no beacon', () => {
  const f = join(dir, 'team.json');
  assert.equal(readTeamConfig(f), null);
  assert.equal(writeTeamExample(f), true);
  assert.match(readTeamConfig(f).error, /real token/);
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 's3cret', peers: [{ name: 'will', host: '10.0.0.5:7331' }, { bad: 1 }] }));
  assert.deepEqual(readTeamConfig(f), { name: 'neo', token: 's3cret', port: 7331, bind: '0.0.0.0', peers: [{ name: 'will', host: '10.0.0.5:7331' }] });
  assert.equal(writeTeamExample(f), false);
  // not in a team: whatever the file says, nothing is exposed
  writeFileSync(f, JSON.stringify({ name: 'neo', token: '', bind: '0.0.0.0', discovery: true }));
  const c = readTeamConfig(f);
  assert.deepEqual([c.bind, c.discovery], ['127.0.0.1', false]);
});

test('sanitizeSessions drops prompts, tool inputs and full paths', () => {
  const [o] = sanitizeSessions([{ id: 'wt1::/Users/x/project/agentdesk', name: 'front-desk', status: 'running', prompt: 'SECRET prompt', toolInput: '/Users/x/.env', repo: '/Users/x/project/agentdesk', cwd: '/Users/x/project/agentdesk', now: 'reading README', subagents: [{ state: 'running' }, { state: 'done' }], loop: { reason: 'fail', tool: 'Bash', input: 'rm -rf' }, ctxPct: 42 }]);
  assert.deepEqual(o, { id: 'wt1', name: 'front-desk', status: 'running', ctxPct: 42, repo: 'agentdesk', cwd: 'agentdesk', now: 'reading README', loop: { reason: 'fail', tool: 'Bash' }, subagents: 1 });
  assert.ok(!JSON.stringify(o).includes('SECRET') && !JSON.stringify(o).includes('/Users/'));
});

test('sanitizeSessions forces types, lengths and characters (a modified teammate cannot push markup or junk)', () => {
  const evil = {
    id: 'x'.repeat(300), name: 'n\u0000a\u2028m\u009fe' + 'y'.repeat(300), branch: 'b'.repeat(500), tool: 't'.repeat(100), status: 'running" onmouseover="alert(1)',
    agent: '<img src=x>', ctxPct: '42"><script>', needsInput: 'yes', stuck: 1, ended: 'false', isSub: {}, hookOnly: true,
    time: '"><b>', askSince: -5, stuckSince: 1700000000000, now: 'z'.repeat(1000), report: { text: 'r'.repeat(1000), at: 'soon' },
    files: Array.from({ length: 50 }, (_, i) => `src/f${i}.js`).concat(['f'.repeat(500)]), jira: 'EP-1<script>', subagents: 7, parentId: 'p::/Users/x',
  };
  const [o] = sanitizeSessions([evil]);
  assert.equal(o.status, 'done', 'unknown status → done');
  assert.equal(o.agent, '', 'unknown agent → ""');
  assert.equal(o.ctxPct, undefined, 'non-numeric ctx dropped');
  assert.deepEqual([o.needsInput, o.stuck, o.ended, o.isSub, o.hookOnly], [false, false, false, false, true], 'booleans: only true is true');
  assert.equal(o.time, undefined); assert.equal(o.askSince, undefined); assert.equal(o.stuckSince, 1700000000000);
  assert.equal(o.id.length, 80); assert.equal(o.name.length, 120); assert.equal(o.branch.length, 120); assert.equal(o.tool.length, 40);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(o.name), 'control / line-separator characters removed');
  assert.equal(o.now.length, 200); assert.equal(o.report.text.length, 200); assert.equal(o.report.at, 0);
  assert.equal(o.files.length, 20); assert.ok(o.files.every(f => f.length <= 200));
  assert.equal(o.jira, undefined); assert.equal(o.subagents, 7); assert.equal(o.parentId, 'p');
  assert.equal(sanitizeSessions([{ ctxPct: 140.6 }])[0].ctxPct, 100);
  assert.equal(sanitizeSessions([{ ctxPct: -3 }])[0].ctxPct, 0);
  assert.equal(sanitizeSessions([{ agent: 'codex', status: 'waiting' }])[0].agent, 'codex');
  assert.equal(sanitizeSessions([{ subagents: '9' }])[0].subagents, 0);
  assert.equal(sanitizeSessions(Array.from({ length: 500 }, (_, i) => ({ id: `s${i}` }))).length, SESSIONS_MAX);
  assert.deepEqual(sanitizeSessions([null, 'x', 5, { id: 'ok' }]).map(s => s.id), ['ok']);
});

test('sanitizeSessions masks secrets in free text', () => {
  const [o] = sanitizeSessions([{ id: 'a', name: 'deploy xoxb-1234567890-abcdefghij', now: 'connecting mysql://app:pw@db.internal:3306/pay as neo@eximbay.com', tool: 'Bearer abcdefghijklmnop', branch: 'fix/4111111111111111', report: { text: 'card 4111 1111 1111 1111 refunded', at: 1 }, files: ['src/AKIAABCDEFGHIJKLMNOP.txt'] }]);
  const all = JSON.stringify(o);
  for (const leak of ['xoxb-', 'mysql://', 'eximbay.com', 'abcdefghijklmnop', '4111111111111111', '4111 1111', 'AKIAABCDEFGHIJKLMNOP']) assert.ok(!all.includes(leak), leak);
});

test('request signatures: valid once, within ±120 s, bound to body, path and the receiving host', () => {
  const guard = createNonceGuard();
  const body = '{"to":"a","text":"hi"}';
  const s = signRequest('tok', 'POST', '10.0.0.5:7331', '/v1/notes', body, 1_000_000);
  const req = (o = {}) => ({ method: 'POST', host: '10.0.0.5:7331', path: '/v1/notes', body, headers: { 'x-ad-ts': s.ts, 'x-ad-nonce': s.nonce, 'x-ad-sig': s.headers['X-AD-Sig'] }, ...o });
  assert.equal(verifyRequest('tok', req({ host: '10.0.0.6:7331' }), guard, 1_000_000).error, 'bad signature', 'relayed to another teammate');
  assert.equal(verifyRequest('tok', req({ host: '10.0.0.5:7332' }), guard, 1_000_000).error, 'bad signature', 'another port');
  assert.deepEqual(verifyRequest('tok', req({ body: body.replace('hi', 'rm') }), guard, 1_000_000), { ok: false, error: 'bad signature' }, 'tampered body');
  assert.equal(verifyRequest('tok', req({ path: '/v1/hello' }), guard, 1_000_000).error, 'bad signature', 'other path');
  assert.equal(verifyRequest('other', req(), guard, 1_000_000).error, 'bad signature', 'other token');
  assert.equal(verifyRequest('tok', req(), guard, 1_000_000 + 121_000).error, 'clock skew');
  assert.equal(verifyRequest('tok', req(), guard, 1_000_000 - 121_000).error, 'clock skew');
  assert.equal(verifyRequest('tok', req({ headers: {} }), guard, 1_000_000).error, 'unsigned request');
  assert.equal(verifyRequest('', req(), guard, 1_000_000).error, 'not in a team yet');
  const ok = verifyRequest('tok', req(), guard, 1_000_000 + 100_000);
  assert.deepEqual([ok.ok, ok.ts, ok.nonce], [true, s.ts, s.nonce]);
  assert.equal(verifyRequest('tok', req(), guard, 1_000_000 + 100_000).error, 'replayed', 'the same nonce twice');
  assert.equal(requestSignature('tok', 'get', 'h:1', '/v1/sessions', '1', 'n', ''), requestSignature('tok', 'GET', 'h:1', '/v1/sessions', '1', 'n', ''));
  // the response signature covers the status code and the host
  assert.notEqual(responseSignature('tok', 200, 'h:1', '1', 'n', ''), responseSignature('tok', 401, 'h:1', '1', 'n', ''));
  assert.notEqual(responseSignature('tok', 200, 'h:1', '1', 'n', ''), responseSignature('tok', 200, 'h:2', '1', 'n', ''));
  // the guard forgets after its TTL and refuses (rather than forgets early) when full
  const g = createNonceGuard({ ttlMs: 1000, max: 2 });
  assert.deepEqual([g.check('a', 0), g.check('b', 10), g.check('c', 20), g.check('a', 1500), g.size], ['ok', 'ok', 'busy', 'ok', 1]);
  assert.equal(NONCE_TTL_MS, 250000); assert.ok(NONCE_TTL_MS > 2 * 120000, 'longer than the whole ts window');
});

test('nonce guard: per-IP cap only blocks that IP; expiry frees the budget', () => {
  const g = createNonceGuard({ ttlMs: 1000, max: 100, perIp: 2 });
  assert.deepEqual([g.check('n1', 0, '10.0.0.5'), g.check('n2', 1, '10.0.0.5'), g.check('n3', 2, '10.0.0.5')], ['ok', 'ok', 'busy-ip']);
  assert.equal(g.check('n4', 3, '10.0.0.6'), 'ok', 'another IP is not affected');
  assert.equal(g.check('n5', 1500, '10.0.0.5'), 'ok', 'after the TTL the IP has budget again');
  assert.equal(NONCE_PER_IP, 600); assert.equal(NONCE_MAX, 50000);
});

test('server: per-IP nonce cap answers 429 to that IP only', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k' }, () => ({ at: 1, sessions: [] }), { nonceGuard: createNonceGuard({ perIp: 2 }) });
  const host = await listen(server);
  try {
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).ok, true);
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).ok, true);
    const r = await signedFetch(host, 't0k', 'GET', '/v1/sessions');
    assert.equal(r.status, 429);
  } finally { server.close(); }
});

test('Host header must be an IP literal, localhost or empty (no DNS rebinding)', async () => {
  for (const h of ['10.0.0.5:7331', '127.0.0.1', 'localhost:7331', '[::1]:7331', '', undefined]) assert.equal(validHostHeader(h), true, String(h));
  for (const h of ['evil.example.com', 'evil.example.com:7331', '10.0.0.5.nip.io:7331', 'localhost.evil:1']) assert.equal(validHostHeader(h), false, h);
  const server = startTeamServer({ name: 'neo', token: 't0k' }, () => ({}));
  const host = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      import('node:http').then(http => http.get({ host: '127.0.0.1', port: server.address().port, path: '/v1/ping', headers: { Host: 'attacker.example:7331' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    });
    assert.equal(status, 400);
    assert.equal((await fetch(`http://${host}/v1/ping`)).status, 200);
  } finally { server.close(); }
});

// a GET with an arbitrary Host header (node:http; fetch() would replace it)
const rawGet = (port, path, headers) => import('node:http').then(http => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); }).on('error', reject);
}));
test('server: Host must be this PC (my address + the port it listens on), else a signed 401 "wrong host"', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => ({ at: 1, sessions: [] }));
  const host = await listen(server); const port = server.address().port;
  try {
    for (const other of [`10.255.255.1:${port}`, `127.0.0.1:${port + 1}`]) {
      // signed for the other host (a relay of a request meant for someone else) and sent with that Host header
      const s = signRequest('t0k', 'GET', other, '/v1/sessions');
      const r = await rawGet(port, '/v1/sessions', { ...s.headers, Host: other });   // fetch() always sends the URL's host
      assert.equal(r.status, 401, other); assert.equal(JSON.parse(r.text).error, 'wrong host');
      assert.equal(r.headers['x-ad-sig'], responseSignature('t0k', 401, other, s.ts, s.nonce, r.text), 'the 401 is signed too');
    }
    // signed for another host but sent with my Host header → the signature does not match
    const s = signRequest('t0k', 'GET', '10.0.0.9:7331', '/v1/sessions');
    const r = await fetch(`http://${host}/v1/sessions`, { headers: { ...s.headers, Host: host } });
    assert.equal(r.status, 401); assert.equal((await r.json()).error, 'bad signature');
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).ok, true);
  } finally { server.close(); }
});

test('server: ping is open without name or instance id, sessions need a signature, peer fetch round-trips signed', async () => {
  const cfg = { name: 'neo', token: 't0k', port: 0, bind: '127.0.0.1', instanceId: ID.a, peers: [] };
  const server = startTeamServer(cfg, () => ({ at: 123, sessions: [{ id: 'a', name: 'x', status: 'waiting', prompt: 'hidden' }] }));
  const host = await listen(server);
  try {
    const ping = await (await fetch(`http://${host}/v1/ping`)).json();
    assert.deepEqual(Object.keys(ping), ['at']);
    assert.deepEqual(await pingPeerSigned({ host }, 't0k'), { ok: true, instanceId: ID.a }, 'a signed ping gets the instance id');
    assert.equal((await pingPeerSigned({ host }, 'wrong')).ok, false);
    assert.equal((await fetch(`http://${host}/v1/sessions`)).status, 401);
    assert.equal((await fetch(`http://${host}/v1/sessions`, { headers: { Authorization: 'Bearer t0k' } })).status, 401, 'a plain bearer token is not accepted any more');
    const bad = await fetchPeer({ name: 'p', host }, 'wrong');
    assert.deepEqual([bad.ok, bad.error], [false, 'token mismatch']);
    const good = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(good.ok, true); assert.equal(good.remoteName, 'neo'); assert.equal(good.theirAt, 123); assert.equal(good.instanceId, ID.a);
    assert.deepEqual(good.sessions, [{ id: 'a', name: 'x', status: 'waiting', repo: '', cwd: '', subagents: 0 }]);
    const down = await fetchPeer({ name: 'q', host: '127.0.0.1:1' }, 't0k');
    assert.equal(down.ok, false); assert.ok(down.error);
    // a replayed request (same headers) is refused
    const s = signRequest('t0k', 'GET', host, '/v1/sessions');
    assert.equal((await fetch(`http://${host}/v1/sessions`, { headers: s.headers })).status, 200);
    const replay = await fetch(`http://${host}/v1/sessions`, { headers: s.headers }); const rt = await replay.text();
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.get('x-ad-sig'), responseSignature('t0k', 401, host, s.ts, s.nonce, rt));
    // the server signs its reply over status, my host and my ts / nonce
    const s2 = signRequest('t0k', 'GET', host, '/v1/sessions');
    const r = await fetch(`http://${host}/v1/sessions`, { headers: s2.headers }); const text = await r.text();
    assert.equal(r.headers.get('x-ad-sig'), responseSignature('t0k', 200, host, s2.ts, s2.nonce, text));
    assert.notEqual(r.headers.get('x-ad-sig'), responseSignature('t0k', 304, host, s2.ts, s2.nonce, text), 'status is part of it');
  } finally { server.close(); }
});

test('fetchPeer drops unsigned / forged replies, redirects and oversized bodies', async () => {
  let mode = 'unsigned';
  const fake = createServer((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); return res.end(); }
    if (mode === 'big') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"sessions":"' + 'x'.repeat(RESPONSE_MAX + 10) + '"}'); }
    const body = JSON.stringify({ name: 'evil', at: 1, sessions: [{ id: 'a', status: 'running' }] });
    const h = { 'Content-Type': 'application/json' };
    if (mode === 'forged') h['X-AD-Sig'] = responseSignature('t0k', 200, req.headers.host, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], body + ' ');   // signs another body
    if (mode === 'status') { h['X-AD-Sig'] = responseSignature('t0k', 200, req.headers.host, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], ''); res.writeHead(304, h); return res.end(); }   // a 200 signature on a 304
    res.writeHead(200, h); res.end(body);
  });
  const host = await listen(fake);
  try {
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).error, 'bad signature');
    mode = 'forged'; assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).error, 'bad signature');
    mode = 'status'; assert.equal((await fetchPeer({ name: 'p', host }, 't0k', { etag: '"x"' })).error, 'bad signature', 'a signature for another status code');
    mode = 'redirect'; assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).error, 'redirect refused');
    mode = 'big'; assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).error, 'response too large');
  } finally { fake.close(); }
});

// ── phase 2 ──
import { ensureInstanceId, addPeerToConfig, postNote, validateNote, NOTE_MAX, rotateTeamToken, removePeerFromConfig, writeTeamJson } from '../team/peer.mjs';
import { encodeBeacon, parseBeacon, broadcastAddresses, startDiscovery } from '../team/discovery.mjs';

test('instance id is created once and kept; adding a peer keeps the token and skips duplicates; files stay private', () => {
  const f = join(dir, 'team2.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok-keep', peers: [{ name: 'teammate', host: '192.168.0.10:7331' }] }));
  const id = ensureInstanceId(f);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(ensureInstanceId(f), id);
  assert.equal(readTeamConfig(f).instanceId, id);
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.7:7331' }), { ok: true, added: true, name: 'will' });
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.7:7331' }), { ok: true, added: false, name: 'will' });
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.8:7331' }), { ok: true, added: true, name: 'will-2' });
  assert.equal(addPeerToConfig(f, { name: 'x', host: 'http://evil/' }).ok, false);
  const raw = JSON.parse(readFileSync(f, 'utf-8'));
  assert.equal(raw.token, 'tok-keep');
  assert.deepEqual(raw.peers.map(p => p.host), ['10.0.0.7:7331', '10.0.0.8:7331'], 'the example placeholder peer is dropped');
  assert.deepEqual(removePeerFromConfig(f, 'will-2'), { ok: true });
  assert.equal(removePeerFromConfig(f, 'nobody').ok, false);
  assert.deepEqual(readTeamConfig(f).peers.map(p => p.name), ['will']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f).mode & 0o777, 0o600, 'team.json 0600');
    const sub = join(dir, 'private', 'team.json'); writeTeamJson(sub, { name: 'x', token: '' });
    assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700, 'folder 0700');
  }
});

test('token reissue: the old token stops working at once', async () => {
  const f = join(dir, 'team-rotate.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'old-token-123', peers: [{ name: 'will', host: '10.0.0.7:7331' }] }));
  let cfg = readTeamConfig(f);
  const live = { get name() { return cfg.name; }, get token() { return cfg.token; }, get peers() { return cfg.peers; } };
  const server = startTeamServer(live, () => ({ at: 1, sessions: [] }));
  const host = await listen(server);
  try {
    assert.equal((await fetchPeer({ name: 'p', host }, 'old-token-123')).ok, true);
    assert.equal(rotateTeamToken(f), true);
    cfg = readTeamConfig(f);
    assert.notEqual(cfg.token, 'old-token-123'); assert.ok(cfg.token.length >= 32);
    assert.deepEqual(cfg.peers.map(p => p.name), ['will'], 'peers stay');
    assert.equal((await fetchPeer({ name: 'p', host }, 'old-token-123')).error, 'token mismatch');
    assert.equal((await fetchPeer({ name: 'p', host }, cfg.token)).ok, true);
  } finally { server.close(); }
});

test('sanitizeSessions phase 2: repo-relative files, report summary, ticket key — never absolute paths', () => {
  const [o] = sanitizeSessions([{ id: 'a', files: ['src/A.java', '/Users/x/secret/B.java', '../up/C.java', 'src/A.java', '~/D.txt'], report: { text: 'x'.repeat(300), at: 5 }, jira: 'EP-12' }]);
  assert.deepEqual(o.files, ['src/A.java', 'B.java', 'C.java', 'D.txt']);
  assert.equal(o.report.text.length, 200); assert.equal(o.report.at, 5);
  assert.equal(o.jira, 'EP-12');
  assert.equal(sanitizeSessions([{ id: 'b', jira: 'not a key; rm -rf' }])[0].jira, undefined);
  assert.ok(!JSON.stringify(o).includes('/Users/'));
});

test('sessions: ETag / since give 304 (signed) until the snapshot changes', async () => {
  let snap = { at: 100, sessions: [{ id: 'a', name: 'x', status: 'running' }] };
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => snap);
  const host = await listen(server);
  try {
    const first = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(first.ok, true); assert.equal(first.instanceId, ID.a); assert.ok(first.etag); assert.equal(typeof first.rtt, 'number');
    const again = await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag });
    assert.deepEqual([again.ok, again.notModified], [true, true]);
    const s = signRequest('t0k', 'GET', host, '/v1/sessions?since=100');
    const bySince = await fetch(`http://${host}/v1/sessions?since=100`, { headers: s.headers });
    assert.equal(bySince.status, 304); assert.equal(await bySince.text(), '');
    assert.equal(bySince.headers.get('x-ad-sig'), responseSignature('t0k', 304, host, s.ts, s.nonce, ''), '304 signs an empty body');
    snap = { at: 200, sessions: [{ id: 'a', name: 'x', status: 'waiting' }] };
    const changed = await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag, since: 100 });
    assert.equal(changed.notModified, undefined); assert.equal(changed.sessions[0].status, 'waiting'); assert.notEqual(changed.etag, first.etag);
    // same content republished (new at, same body) → the ETag still says "unchanged"
    snap = { at: 300, sessions: [{ id: 'a', name: 'x', status: 'waiting' }] };
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k', { etag: changed.etag })).notModified, true);
  } finally { server.close(); }
});

test('notes: signature required, sender taken from the registered peer at the caller IP, length checked, rate limited', async () => {
  const got = []; let clock = 1_000_000;
  const cfg = { name: 'neo', token: 't0k', peers: [{ name: 'will', host: '127.0.0.1:7441' }, { name: 'amy', host: '127.0.0.1:7551' }] };
  const server = startTeamServer(cfg, () => ({}), { onNote: n => got.push(n), now: () => clock });
  const host = await listen(server);
  const post = (body, token = 't0k') => signedFetch(host, token, 'POST', '/v1/notes', typeof body === 'string' ? body : JSON.stringify(body), { 'Content-Type': 'application/json' });
  try {
    assert.equal((await post({ to: 'wt1', text: 'hi' }, 'bad')).status, 401);
    assert.equal((await fetch(`http://${host}/v1/notes`)).status, 401, 'unsigned → refused before the method check');
    assert.equal((await signedFetch(host, 't0k', 'GET', '/v1/notes')).status, 405);
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post({ to: 'wt1', text: '가'.repeat(NOTE_MAX + 1) })).status, 400);
    assert.equal((await post({ to: 'wt1', text: 'x'.repeat(5000) })).status, 413);
    assert.equal((await post({ text: 'hi' })).status, 400);
    // "from" in the body is ignored: the note is from whoever I registered at 127.0.0.1 (port hint picks amy)
    const ok = await post({ to: 'wt1', toName: 'front', from: 'the CEO', text: '가'.repeat(NOTE_MAX), port: 7551 });
    assert.equal(ok.status, 202);
    assert.equal(got.length, 1); assert.deepEqual([got[0].to, got[0].toName, got[0].from, got[0].at], ['wt1', 'front', 'amy', clock]); assert.ok(got[0].id);
    assert.equal((await post({ to: 'wt1', from: 'x', text: 'no hint' })).status, 202);
    assert.equal(got[1].from, 'will', 'no port hint → the first peer at that IP');
    for (let i = 0; i < 8; i++) assert.equal((await post({ to: 'wt1', from: `sender${i}`, text: `n${i}` })).status, 202);
    assert.equal((await post({ to: 'wt1', from: 'someone else', text: 'one too many' })).status, 429, 'the limit is per IP, whatever "from" says');
    clock += 61000;
    assert.equal((await post({ to: 'wt1', text: 'next minute' })).status, 202);
    assert.equal(got.length, 11);
    const viaClient = await postNote({ name: 'p', host }, 't0k', { to: 'wt1', from: 'zed', text: 'hello' });
    assert.deepEqual(viaClient, { ok: true });
    assert.equal((await postNote({ name: 'p', host }, 'bad', { to: 'wt1', from: 'zed', text: 'x' })).error, 'token mismatch');
  } finally { server.close(); }
  // nobody registered at the caller's IP → 403
  const lonely = startTeamServer({ name: 'neo', token: 't0k', peers: [{ name: 'will', host: '10.0.0.5:7331' }] }, () => ({}), { onNote: n => got.push(n) });
  const h2 = await listen(lonely);
  try {
    const r = await postNote({ name: 'p', host: h2 }, 't0k', { to: 'wt1', from: 'will', text: 'spoof' });
    assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'not registered on their side']);
  } finally { lonely.close(); }
});

test('note rate limit: 10 a minute per key, idle keys pruned, map capped at 1000', () => {
  const m = new Map();
  for (let i = 0; i < 10; i++) assert.equal(noteRateCheck(m, '10.0.0.5', 1000 + i), true);
  assert.equal(noteRateCheck(m, '10.0.0.5', 2000), false);
  assert.equal(noteRateCheck(m, '10.0.0.6', 2000), true, 'another IP has its own budget');
  assert.equal(noteRateCheck(m, '10.0.0.5', 62000), true, 'a minute later');
  for (let i = 0; i < 1200; i++) noteRateCheck(m, `ip${i}`, 700_000 + i);
  assert.ok(m.size <= 1000);
  assert.ok(!m.has('10.0.0.5'), 'idle for over 10 minutes → pruned');
});

test('validateNote trims, strips control characters and bounds fields', () => {
  assert.deepEqual(validateNote({ to: ' a ', from: ' b ', text: ' hi ' }), { note: { to: 'a', from: 'b', text: 'hi' } });
  assert.deepEqual(validateNote({ to: 'a', from: 'b', text: 'line1\nline2\u0007\u2028' }).note.text, 'line1\nline2');
  assert.match(validateNote({ to: 'a', from: 'b', text: '   ' }).error, /text/);
  assert.match(validateNote(null).error, /to/);
});

test('subnet check: only my own /24 (and this PC) is polled', () => {
  const ifaces = { lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], en0: [{ family: 'IPv4', address: '192.168.10.120', internal: false }], utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }] };
  assert.deepEqual(myPrefixes(ifaces), ['192.168.10', '10.8.0']);
  assert.equal(sameSubnet('192.168.10.7:7331', ifaces), true);
  assert.equal(sameSubnet('10.8.0.99:7331', ifaces), true);
  assert.equal(sameSubnet('127.0.0.1:7331', ifaces), true);
  assert.equal(sameSubnet('192.168.11.7:7331', ifaces), false);
  assert.equal(sameSubnet('172.16.0.4:7331', ifaces), false);
  assert.equal(sameSubnet('teammate.local:7331', ifaces), false, 'host names are not polled');
  assert.equal(sameSubnet('192.168.10.7:7331', {}), false, 'offline');
});

test('discovery beacon: serialize / parse, no token, junk rejected', () => {
  const buf = encodeBeacon({ name: 'will', port: 7331, id: ID.b, token: 'SECRET' });
  assert.ok(!buf.toString().includes('SECRET'));
  const p = parseBeacon(buf, { address: '::ffff:10.0.0.5' });
  assert.deepEqual([p.name, p.host, p.id], ['will', '10.0.0.5:7331', ID.b]);
  assert.equal(parseBeacon(encodeBeacon({ name: '김 윌.dev-1', port: 7331, id: ID.b }), { address: '10.0.0.5' }).name, '김 윌.dev-1');
  assert.equal(parseBeacon(Buffer.from('hello'), { address: '10.0.0.5' }), null);
  assert.equal(parseBeacon(Buffer.from(JSON.stringify({ app: 'other', v: 1, name: 'x', port: 1, id: ID.b })), { address: '10.0.0.5' }), null);
  assert.equal(parseBeacon(encodeBeacon({ name: 'will', port: 70000, id: ID.b }), { address: '10.0.0.5' }), null);
  assert.equal(parseBeacon(encodeBeacon({ name: 'will', port: 7331.5, id: ID.b }), { address: '10.0.0.5' }), null);
  for (const name of ['<img src=x onerror=alert(1)>', 'a"b', "o'neil", 'x\u2028y', '   ', '']) assert.equal(parseBeacon(encodeBeacon({ name, port: 7331, id: ID.b }), { address: '10.0.0.5' }), null, name);
  for (const id of ['abc', 'A', `${ID.b}x`, '"><script>']) assert.equal(parseBeacon(encodeBeacon({ name: 'will', port: 7331, id }), { address: '10.0.0.5' }), null, id);
  assert.equal(parseBeacon(buf, { address: 'fe80::1' }), null, 'IPv4 only');
  assert.deepEqual(broadcastAddresses({ en0: [{ family: 'IPv4', address: '192.168.10.120', netmask: '255.255.255.0', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }] }), ['255.255.255.255', '192.168.10.255']);
});

test('discovery: two beacons on 127.0.0.1 hear each other and ignore themselves', async () => {
  const heardA = [], heardB = [];
  const a = startDiscovery({ name: 'neo', port: 7331, id: ID.a, bindPort: 0, bindAddress: '127.0.0.1', targets: [], intervalMs: 50, onPeer: p => heardA.push(p) });
  const b = startDiscovery({ name: 'will', port: 7441, id: ID.b, bindPort: 0, bindAddress: '127.0.0.1', targets: [], intervalMs: 50, onPeer: p => heardB.push(p) });
  await Promise.all([a.ready, b.ready]);
  const pa = a.address().port, pb = b.address().port;
  // targets: [] keeps the test off the real network; a plain socket plays the other PC's broadcast
  const { createSocket } = await import('node:dgram');
  const s = createSocket('udp4');
  try {
    await new Promise(r => s.send(encodeBeacon({ name: 'will', port: 7441, id: ID.b }), pa, '127.0.0.1', r));
    await new Promise(r => s.send(encodeBeacon({ name: 'neo', port: 7331, id: ID.a }), pb, '127.0.0.1', r));
    await new Promise(r => s.send(encodeBeacon({ name: 'neo', port: 7331, id: ID.a }), pa, '127.0.0.1', r));   // its own id
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(heardA.map(p => [p.name, p.host, p.id]), [['will', '127.0.0.1:7441', ID.b]]);
    assert.deepEqual(heardB.map(p => [p.name, p.host, p.id]), [['neo', '127.0.0.1:7331', ID.a]]);
  } finally { s.close(); a.stop(); b.stop(); }
});

test('office network: homeSubnets kept from team.json, onHomeNetwork / withHomeSubnets', () => {
  const office = { en0: [{ family: 'IPv4', address: '192.168.10.120', internal: false }] };
  const cafe = { en0: [{ family: 'IPv4', address: '172.20.3.4', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.equal(onHomeNetwork(['192.168.10'], office), true);
  assert.equal(onHomeNetwork(['192.168.10'], cafe), false);
  assert.equal(onHomeNetwork(['192.168.10', '172.20.3'], cafe), true);
  assert.equal(onHomeNetwork(undefined, cafe), true, 'no list (older team.json) → not restricted');
  assert.equal(onHomeNetwork(['192.168.10'], {}), false, 'offline');
  assert.deepEqual(withHomeSubnets(['192.168.10'], cafe), ['192.168.10', '172.20.3']);
  assert.deepEqual(withHomeSubnets(['192.168.10'], office), ['192.168.10']);
  const f = join(dir, 'team-home.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 't', homeSubnets: ['192.168.10', 'evil', '1.2.3.4', 5] }));
  assert.deepEqual(readTeamConfig(f).homeSubnets, ['192.168.10']);
});

test('moved hello: the old address still answering as that instance → reject; silent or someone else → pending', async () => {
  const alive = startTeamServer({ name: 'will', token: 't0k', instanceId: ID.b }, () => ({}));
  const host = await listen(alive);
  try {
    assert.equal(await classifyMove({ oldHost: host, instanceId: ID.b }, 't0k'), 'reject');
    assert.equal(await classifyMove({ oldHost: host, instanceId: ID.c }, 't0k'), 'pending', 'another instance lives there now');
    assert.equal(await classifyMove({ oldHost: host, instanceId: ID.b }, 'other-team'), 'pending', 'not my team (unsigned reply)');
    assert.equal(await classifyMove({ oldHost: '127.0.0.1:1', instanceId: ID.b }, 't0k'), 'pending', 'nothing answers');
    // with an injected ping: the decision only depends on the signed answer
    assert.equal(await classifyMove({ oldHost: 'x:1', instanceId: ID.b }, 't', async () => ({ ok: true, instanceId: '' })), 'reject');
    assert.equal(await classifyMove({ oldHost: 'x:1', instanceId: ID.b }, 't', async () => ({ ok: false })), 'pending');
  } finally { alive.close(); }
});
