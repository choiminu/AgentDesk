// Team sharing (E): first-run config, invite codes, hello, empty-token server, Node fallback for helper scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeInvite, decodeInvite, INVITE_PREFIX, upsertPeer, addPeerToConfig, readTeamConfig, startTeamServer, postHello, fetchPeer, newTeamToken, setTeamFields, isShared, signRequest } from '../team/peer.mjs';
import { defaultTeamConfig, lanAddress, nodeRunner, SHARE_ON, SHARE_OFF } from '../team/setup.mjs';
const ID = { neo: '11111111-1111-4111-8111-111111111111', will: '22222222-2222-4222-8222-222222222222', amy: '33333333-3333-4333-8333-333333333333' };

const dir = mkdtempSync(join(tmpdir(), 'agentdesk-setup-'));
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };

test('invite code round-trips; damaged or foreign codes are refused', () => {
  const token = newTeamToken();
  assert.ok(token.length >= 32);
  const code = encodeInvite({ token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: ID.neo } });
  assert.ok(code.startsWith(INVITE_PREFIX)); assert.ok(!code.includes(token), 'the token is encoded, not plain');
  assert.deepEqual(decodeInvite(`  ${code}\n`), { token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: ID.neo } });
  assert.equal(decodeInvite(encodeInvite({ token, inviter: { name: 'neo<b>', host: '1.2.3.4:7331', instanceId: 'not-a-uuid' } })).inviter.instanceId, '');
  // 0.2.2: the inviter's public key (and a join ticket) ride along under the same prefix (test/team-identity.test.mjs)
  const pub = 'A'.repeat(43);
  assert.deepEqual(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331', pubkey: pub }, ticket: 'B'.repeat(22) })), { token, inviter: { name: 'neo', host: '1.2.3.4:7331', instanceId: '', pubkey: pub }, ticket: 'B'.repeat(22) });
  assert.equal(decodeInvite(encodeInvite({ token, inviter: { name: 'neo<b>', host: '1.2.3.4:7331' } })).inviter.name, 'neob');
  assert.match(decodeInvite('hello').error, /not an AgentDesk/);
  assert.match(decodeInvite(INVITE_PREFIX + '%%%').error, /damaged|token/);
  assert.match(decodeInvite(encodeInvite({ token: 'short', inviter: { name: 'neo', host: '1.2.3.4:7331' } })).error, /token/);
  assert.match(decodeInvite(encodeInvite({ token: 'change-me-shared-secret', inviter: { name: 'neo', host: '1.2.3.4:7331' } })).error, /token/);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: 'http://evil.example/' } })).error, /inviter/);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: ' ', host: '1.2.3.4:7331' } })).error, /inviter/);
});

test('upsertPeer: same instanceId follows a new IP ("moved"), same host gains the id, new names are de-duplicated', () => {
  let r = upsertPeer([{ name: 'teammate', host: '192.168.0.10:7331' }], { name: 'will', host: '10.0.0.5:7331', instanceId: 'W' });
  assert.deepEqual([r.change, r.peers], ['added', [{ name: 'will', host: '10.0.0.5:7331', instanceId: 'W' }]], 'example placeholder dropped');
  r = upsertPeer(r.peers, { name: 'will-renamed', host: '10.0.0.9:7331', instanceId: 'W' });
  assert.deepEqual([r.change, r.name, r.from, r.peers[0].host, r.peers[0].name], ['moved', 'will', '10.0.0.5:7331', '10.0.0.9:7331', 'will']);
  assert.equal(upsertPeer(r.peers, { name: 'x', host: '10.0.0.9:7331', instanceId: 'W' }).change, 'none');
  r = upsertPeer([{ name: 'amy', host: '10.0.0.7:7331' }], { name: 'amy', host: '10.0.0.7:7331', instanceId: 'A' });
  assert.deepEqual([r.change, r.peers[0].instanceId], ['updated', 'A']);
  r = upsertPeer([{ name: 'amy', host: '10.0.0.7:7331' }], { name: 'amy', host: '10.0.0.8:7331' });
  assert.deepEqual([r.change, r.name], ['added', 'amy-2']);
});

test('first-run config: no token, 127.0.0.1 only, no beacon; server answers ping but refuses sessions / notes / hello', async () => {
  const f = join(dir, 'team.json');
  const raw = defaultTeamConfig({ name: 'neo', instanceId: ID.neo });
  assert.deepEqual([raw.bind, raw.discovery, raw.token], ['127.0.0.1', false, '']);
  writeFileSync(f, JSON.stringify(raw));
  const cfg = readTeamConfig(f);
  assert.deepEqual([cfg.error, cfg.token, cfg.port, cfg.bind, cfg.discovery, cfg.instanceId, cfg.peers], [undefined, '', 7331, '127.0.0.1', false, ID.neo, []]);
  assert.equal(isShared(cfg), false);
  // create / join → visible on the network; "stop sharing" → back to this PC only (token kept)
  setTeamFields(f, { token: newTeamToken(), ...SHARE_ON });
  let c2 = readTeamConfig(f); assert.deepEqual([c2.bind, c2.discovery, isShared(c2)], ['0.0.0.0', undefined, true]);
  setTeamFields(f, SHARE_OFF);
  c2 = readTeamConfig(f); assert.deepEqual([c2.bind, c2.discovery, isShared(c2), !!c2.token], ['127.0.0.1', false, false, true]);
  const server = startTeamServer(cfg, () => ({ at: 1, sessions: [{ id: 'a' }] }));
  const host = await listen(server);
  try {
    assert.equal((await fetch(`http://${host}/v1/ping`)).status, 200);
    for (const auth of [undefined, 'Bearer ', 'Bearer x', 'signed']) {
      const headers = auth === undefined ? {} : auth === 'signed' ? signRequest('', 'GET', host, '/v1/sessions').headers : { Authorization: auth };
      assert.equal((await fetch(`http://${host}/v1/sessions`, { headers })).status, 401, String(auth));
      assert.equal((await fetch(`http://${host}/v1/hello`, { method: 'POST', headers, body: '{}' })).status, 401);
      assert.equal((await fetch(`http://${host}/v1/notes`, { method: 'POST', headers, body: '{}' })).status, 401);
    }
  } finally { server.close(); }
});

test('hello: a signed greeting reaches onHello with the caller IP (the app queues it for confirmation); junk is refused', async () => {
  const f = join(dir, 'team-hello.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok-123456', instanceId: ID.neo, peers: [{ name: 'will', host: '10.9.9.9:7441', instanceId: ID.will }] }));
  const cfg = readTeamConfig(f);
  const seen = [];
  // what the app does: nothing is written here — a new peer or a moved one is only queued (pending)
  const server = startTeamServer(cfg, () => ({}), { onHello: peer => { const u = upsertPeer(cfg.peers, peer); seen.push([u.change, peer]); return u.change === 'none' ? { ok: true } : { ok: true, pending: true }; } });
  const host = await listen(server);
  try {
    // same instance, new address (127.0.0.1 here) → "moved", waits for the user
    let r = await postHello({ name: 'p', host }, 'tok-123456', { name: 'will-new-name', port: 7441, instanceId: ID.will });
    assert.deepEqual([r.ok, r.pending, r.name, r.instanceId], [true, true, 'neo', ID.neo]);
    assert.deepEqual(seen[0], ['moved', { name: 'will-new-name', host: '127.0.0.1:7441', instanceId: ID.will }]);
    assert.deepEqual(readTeamConfig(f).peers, [{ name: 'will', host: '10.9.9.9:7441', instanceId: ID.will }], 'team.json untouched until confirmed');
    // a new teammate, with a name that needs cleaning and an id that is not a uuid
    r = await postHello({ name: 'p', host }, 'tok-123456', { name: 'amy<script>', port: 7551, instanceId: 'id-amy' });
    assert.equal(r.pending, true);
    assert.deepEqual(seen[1], ['added', { name: 'amyscript', host: '127.0.0.1:7551', instanceId: '' }]);
    // confirming = addPeerToConfig
    assert.deepEqual(addPeerToConfig(f, seen[0][1]), { ok: true, added: false, updated: true, name: 'will' });
    assert.deepEqual(readTeamConfig(f).peers, [{ name: 'will', host: '127.0.0.1:7441', instanceId: ID.will }]);
    assert.equal(JSON.parse(readFileSync(f, 'utf-8')).token, 'tok-123456', 'token untouched');
    assert.equal((await postHello({ name: 'p', host }, 'wrong', { name: 'x', port: 1 })).error, 'token mismatch');
    assert.equal(seen.length, 2, 'an unsigned / wrongly signed hello never reaches onHello');
    const post = (body, method = 'POST') => { const b = method === 'POST' ? JSON.stringify(body) : ''; return fetch(`http://${host}/v1/hello`, { method, headers: signRequest('tok-123456', method, host, '/v1/hello', b).headers, body: b || undefined }); };
    assert.equal((await post({ name: 'x', port: 0 })).status, 400);
    assert.equal((await post({ name: '<>', port: 7331 })).status, 400);
    assert.equal((await post(null, 'GET')).status, 405);
    assert.equal((await fetch(`http://${host}/v1/hello`, { method: 'POST', headers: { Authorization: 'Bearer tok-123456' }, body: JSON.stringify({ name: 'x', port: 7331 }) })).status, 401, 'a bearer token is not enough');
  } finally { server.close(); }
});

test('join flow: invite → token saved + inviter peer → sessions reachable', async () => {
  const inviterCfg = { name: 'neo', token: newTeamToken(), instanceId: ID.neo };
  const server = startTeamServer(inviterCfg, () => ({ at: 5, sessions: [{ id: 's1', name: 'wt' }] }));
  const host = await listen(server);
  try {
    const code = encodeInvite({ token: inviterCfg.token, inviter: { name: 'neo', host, instanceId: ID.neo } });
    const f = join(dir, 'team-join.json');
    writeFileSync(f, JSON.stringify(defaultTeamConfig({ name: 'will', instanceId: ID.will })));
    const inv = decodeInvite(code);
    setTeamFields(f, { token: inv.token, ...SHARE_ON });
    assert.deepEqual(addPeerToConfig(f, inv.inviter), { ok: true, added: true, name: 'neo' });
    const cfg = readTeamConfig(f);
    assert.equal(cfg.token, inviterCfg.token); assert.equal(isShared(cfg), true);
    const r = await fetchPeer(cfg.peers[0], cfg.token);
    assert.deepEqual([r.ok, r.sessions.length, r.instanceId], [true, 1, ID.neo]);
  } finally { server.close(); }
});

test('nodeRunner: system node when present, otherwise the app binary in Node mode', () => {
  assert.deepEqual(nodeRunner('/Applications/AgentDesk.app/Contents/MacOS/AgentDesk', p => p === '/usr/local/bin/node'), { cmd: '/usr/local/bin/node', env: { ELECTRON_RUN_AS_NODE: '1' }, system: true });
  assert.deepEqual(nodeRunner('/Applications/AgentDesk.app/Contents/MacOS/AgentDesk', () => false), { cmd: '/Applications/AgentDesk.app/Contents/MacOS/AgentDesk', env: { ELECTRON_RUN_AS_NODE: '1' }, system: false });
});

test('lanAddress prefers en0 and skips loopback', () => {
  assert.equal(lanAddress({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }], en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.10.120', internal: false }] }), '192.168.10.120');
  assert.equal(lanAddress({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), '');
});
