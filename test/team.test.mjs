// Team sharing: config parsing, snapshot sanitizing, HTTP server auth, peer fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig, writeTeamExample, sanitizeSessions, startTeamServer, fetchPeer, TEAM_EXAMPLE } from '../team/peer.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentdesk-team-'));

test('readTeamConfig: missing → null, example token → error, valid → normalized', () => {
  const f = join(dir, 'team.json');
  assert.equal(readTeamConfig(f), null);
  assert.equal(writeTeamExample(f), true);
  assert.match(readTeamConfig(f).error, /real token/);
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 's3cret', peers: [{ name: 'will', host: '10.0.0.5:7331' }, { bad: 1 }] }));
  assert.deepEqual(readTeamConfig(f), { name: 'neo', token: 's3cret', port: 7331, bind: '0.0.0.0', peers: [{ name: 'will', host: '10.0.0.5:7331' }] });
  assert.equal(writeTeamExample(f), false);
});

test('sanitizeSessions drops prompts, tool inputs and full paths', () => {
  const [o] = sanitizeSessions([{ id: 'wt1::/Users/x/project/agentdesk', name: 'front-desk', status: 'running', prompt: 'SECRET prompt', toolInput: '/Users/x/.env', repo: '/Users/x/project/agentdesk', cwd: '/Users/x/project/agentdesk', now: 'reading README', subagents: [{ state: 'running' }, { state: 'done' }], loop: { reason: 'fail', tool: 'Bash', input: 'rm -rf' }, ctxPct: 42 }]);
  assert.deepEqual(o, { id: 'wt1', name: 'front-desk', status: 'running', ctxPct: 42, repo: 'agentdesk', cwd: 'agentdesk', now: 'reading README', loop: { reason: 'fail', tool: 'Bash' }, subagents: 1 });
  assert.ok(!JSON.stringify(o).includes('SECRET') && !JSON.stringify(o).includes('/Users/'));
});

test('server: ping is open, sessions needs the token, peer fetch round-trips', async () => {
  const cfg = { name: 'neo', token: 't0k', port: 0, bind: '127.0.0.1', peers: [] };
  const server = startTeamServer(cfg, () => ({ at: 123, sessions: [{ id: 'a', name: 'x', status: 'waiting', prompt: 'hidden' }] }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${server.address().port}`;
  try {
    const ping = await (await fetch(`http://${host}/v1/ping`)).json();
    assert.equal(ping.name, 'neo');
    assert.equal((await fetch(`http://${host}/v1/sessions`)).status, 401);
    const bad = await fetchPeer({ name: 'p', host }, 'wrong');
    assert.deepEqual([bad.ok, bad.error], [false, 'token mismatch']);
    const good = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(good.ok, true); assert.equal(good.remoteName, 'neo'); assert.equal(good.theirAt, 123);
    assert.deepEqual(good.sessions, [{ id: 'a', name: 'x', status: 'waiting', repo: '', cwd: '', subagents: 0 }]);
    const down = await fetchPeer({ name: 'q', host: '127.0.0.1:1' }, 't0k');
    assert.equal(down.ok, false); assert.ok(down.error);
  } finally { server.close(); }
});

// ── phase 2 ──
import { ensureInstanceId, addPeerToConfig, postNote, validateNote, NOTE_MAX } from '../team/peer.mjs';
import { encodeBeacon, parseBeacon, broadcastAddresses, startDiscovery } from '../team/discovery.mjs';
import { readFileSync } from 'node:fs';

const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };

test('instance id is created once and kept; adding a peer keeps the token and skips duplicates', () => {
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
});

test('sanitizeSessions phase 2: repo-relative files, report summary, ticket key — never absolute paths', () => {
  const [o] = sanitizeSessions([{ id: 'a', files: ['src/A.java', '/Users/x/secret/B.java', '../up/C.java', 'src/A.java', '~/D.txt'], report: { text: 'x'.repeat(300), at: 5 }, jira: 'EP-12' }]);
  assert.deepEqual(o.files, ['src/A.java', 'B.java', 'C.java', 'D.txt']);
  assert.equal(o.report.text.length, 200); assert.equal(o.report.at, 5);
  assert.equal(o.jira, 'EP-12');
  assert.equal(sanitizeSessions([{ id: 'b', jira: 'not a key; rm -rf' }])[0].jira, undefined);
  assert.ok(!JSON.stringify(o).includes('/Users/'));
});

test('sessions: ETag / since give 304 until the snapshot changes', async () => {
  let snap = { at: 100, sessions: [{ id: 'a', name: 'x', status: 'running' }] };
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: 'id-1' }, () => snap);
  const host = await listen(server);
  try {
    const first = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(first.ok, true); assert.equal(first.instanceId, 'id-1'); assert.ok(first.etag); assert.equal(typeof first.rtt, 'number');
    const again = await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag });
    assert.deepEqual([again.ok, again.notModified], [true, true]);
    const bySince = await fetch(`http://${host}/v1/sessions?since=100`, { headers: { Authorization: 'Bearer t0k' } });
    assert.equal(bySince.status, 304); assert.equal(await bySince.text(), '');
    snap = { at: 200, sessions: [{ id: 'a', name: 'x', status: 'waiting' }] };
    const changed = await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag, since: 100 });
    assert.equal(changed.notModified, undefined); assert.equal(changed.sessions[0].status, 'waiting'); assert.notEqual(changed.etag, first.etag);
    // same content republished (new at, same body) → the ETag still says "unchanged"
    snap = { at: 300, sessions: [{ id: 'a', name: 'x', status: 'waiting' }] };
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k', { etag: changed.etag })).notModified, true);
    assert.equal((await (await fetch(`http://${host}/v1/ping`)).json()).instanceId, 'id-1');
  } finally { server.close(); }
});

test('notes: token required, length checked, 10 a minute per sender, handed to onNote', async () => {
  const got = []; let clock = 1_000_000;
  const server = startTeamServer({ name: 'neo', token: 't0k' }, () => ({}), { onNote: n => got.push(n), now: () => clock });
  const host = await listen(server);
  const post = (body, token = 't0k') => fetch(`http://${host}/v1/notes`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await post({ to: 'wt1', from: 'will', text: 'hi' }, 'bad')).status, 401);
    assert.equal((await fetch(`http://${host}/v1/notes`)).status, 401, 'no token → refused before the method check');
    assert.equal((await fetch(`http://${host}/v1/notes`, { headers: { Authorization: 'Bearer t0k' } })).status, 405);
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post({ to: 'wt1', from: 'will', text: '가'.repeat(NOTE_MAX + 1) })).status, 400);
    assert.equal((await post({ to: 'wt1', from: 'will', text: 'x'.repeat(5000) })).status, 413);
    assert.equal((await post({ from: 'will', text: 'hi' })).status, 400);
    const ok = await post({ to: 'wt1', toName: 'front', from: 'will', text: '가'.repeat(NOTE_MAX) });
    assert.equal(ok.status, 202);
    assert.equal(got.length, 1); assert.deepEqual([got[0].to, got[0].toName, got[0].from, got[0].at], ['wt1', 'front', 'will', clock]); assert.ok(got[0].id);
    for (let i = 0; i < 9; i++) assert.equal((await post({ to: 'wt1', from: 'will', text: `n${i}` })).status, 202);
    assert.equal((await post({ to: 'wt1', from: 'will', text: 'one too many' })).status, 429);
    assert.equal((await post({ to: 'wt1', from: 'amy', text: 'other sender' })).status, 202, 'the limit is per sender');
    clock += 61000;
    assert.equal((await post({ to: 'wt1', from: 'will', text: 'next minute' })).status, 202);
    assert.equal(got.length, 12);
    const viaClient = await postNote({ name: 'p', host }, 't0k', { to: 'wt1', from: 'zed', text: 'hello' });
    assert.deepEqual(viaClient, { ok: true });
    assert.equal((await postNote({ name: 'p', host }, 'bad', { to: 'wt1', from: 'zed', text: 'x' })).error, 'token mismatch');
  } finally { server.close(); }
});

test('validateNote trims and bounds fields', () => {
  assert.deepEqual(validateNote({ to: ' a ', from: ' b ', text: ' hi ' }), { note: { to: 'a', from: 'b', text: 'hi' } });
  assert.match(validateNote({ to: 'a', from: 'b', text: '   ' }).error, /text/);
  assert.match(validateNote(null).error, /to/);
});

test('discovery beacon: serialize / parse, no token, junk rejected', () => {
  const buf = encodeBeacon({ name: 'will', port: 7331, id: 'abc', token: 'SECRET' });
  assert.ok(!buf.toString().includes('SECRET'));
  const p = parseBeacon(buf, { address: '::ffff:10.0.0.5' });
  assert.deepEqual([p.name, p.host, p.id], ['will', '10.0.0.5:7331', 'abc']);
  assert.equal(parseBeacon(Buffer.from('hello'), { address: '10.0.0.5' }), null);
  assert.equal(parseBeacon(Buffer.from(JSON.stringify({ app: 'other', v: 1, name: 'x', port: 1, id: 'y' })), { address: '10.0.0.5' }), null);
  assert.equal(parseBeacon(encodeBeacon({ name: 'will', port: 70000, id: 'a' }), { address: '10.0.0.5' }), null);
  assert.deepEqual(broadcastAddresses({ en0: [{ family: 'IPv4', address: '192.168.10.120', netmask: '255.255.255.0', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }] }), ['255.255.255.255', '192.168.10.255']);
});

test('discovery: two beacons on 127.0.0.1 hear each other and ignore themselves', async () => {
  const heardA = [], heardB = [];
  const a = startDiscovery({ name: 'neo', port: 7331, id: 'A', bindPort: 0, bindAddress: '127.0.0.1', targets: [], intervalMs: 50, onPeer: p => heardA.push(p) });
  const b = startDiscovery({ name: 'will', port: 7441, id: 'B', bindPort: 0, bindAddress: '127.0.0.1', targets: [], intervalMs: 50, onPeer: p => heardB.push(p) });
  await Promise.all([a.ready, b.ready]);
  const pa = a.address().port, pb = b.address().port;
  // targets: [] keeps the test off the real network; a plain socket plays the other PC's broadcast
  const { createSocket } = await import('node:dgram');
  const s = createSocket('udp4');
  try {
    await new Promise(r => s.send(encodeBeacon({ name: 'will', port: 7441, id: 'B' }), pa, '127.0.0.1', r));
    await new Promise(r => s.send(encodeBeacon({ name: 'neo', port: 7331, id: 'A' }), pb, '127.0.0.1', r));
    await new Promise(r => s.send(encodeBeacon({ name: 'neo', port: 7331, id: 'A' }), pa, '127.0.0.1', r));   // its own id
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(heardA.map(p => [p.name, p.host, p.id]), [['will', '127.0.0.1:7441', 'B']]);
    assert.deepEqual(heardB.map(p => [p.name, p.host, p.id]), [['neo', '127.0.0.1:7331', 'A']]);
  } finally { s.close(); a.stop(); b.stop(); }
});
