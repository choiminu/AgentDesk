// Team sharing (E): first-run config, invite codes, hello, empty-token server, Node fallback for helper scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeInvite, decodeInvite, INVITE_PREFIX, upsertPeer, addPeerToConfig, readTeamConfig, startTeamServer, postHello, fetchPeer, newTeamToken, setTeamFields } from '../team/peer.mjs';
import { defaultTeamConfig, lanAddress, nodeRunner } from '../team/setup.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentdesk-setup-'));
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };

test('invite code round-trips; damaged or foreign codes are refused', () => {
  const token = newTeamToken();
  assert.ok(token.length >= 32);
  const code = encodeInvite({ token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: 'id-neo' } });
  assert.ok(code.startsWith(INVITE_PREFIX)); assert.ok(!code.includes(token), 'the token is encoded, not plain');
  assert.deepEqual(decodeInvite(`  ${code}\n`), { token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: 'id-neo' } });
  assert.match(decodeInvite('hello').error, /not an AgentDesk/);
  assert.match(decodeInvite(INVITE_PREFIX + '%%%').error, /damaged|token/);
  assert.match(decodeInvite(encodeInvite({ token: 'short', inviter: { name: 'neo', host: '1.2.3.4:7331' } })).error, /token/);
  assert.match(decodeInvite(encodeInvite({ token: 'change-me-shared-secret', inviter: { name: 'neo', host: '1.2.3.4:7331' } })).error, /token/);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: 'http://evil.example/' } })).error, /inviter/);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: ' ', host: '1.2.3.4:7331' } })).error, /inviter/);
});

test('upsertPeer: same instanceId follows a new IP, same host gains the id, new names are de-duplicated', () => {
  let r = upsertPeer([{ name: 'teammate', host: '192.168.0.10:7331' }], { name: 'will', host: '10.0.0.5:7331', instanceId: 'W' });
  assert.deepEqual([r.change, r.peers], ['added', [{ name: 'will', host: '10.0.0.5:7331', instanceId: 'W' }]], 'example placeholder dropped');
  r = upsertPeer(r.peers, { name: 'will-renamed', host: '10.0.0.9:7331', instanceId: 'W' });
  assert.deepEqual([r.change, r.name, r.peers[0].host, r.peers[0].name], ['updated', 'will', '10.0.0.9:7331', 'will']);
  assert.equal(upsertPeer(r.peers, { name: 'x', host: '10.0.0.9:7331', instanceId: 'W' }).change, 'none');
  r = upsertPeer([{ name: 'amy', host: '10.0.0.7:7331' }], { name: 'amy', host: '10.0.0.7:7331', instanceId: 'A' });
  assert.deepEqual([r.change, r.peers[0].instanceId], ['updated', 'A']);
  r = upsertPeer([{ name: 'amy', host: '10.0.0.7:7331' }], { name: 'amy', host: '10.0.0.8:7331' });
  assert.deepEqual([r.change, r.name], ['added', 'amy-2']);
});

test('first-run config has no token: valid config, server answers ping but refuses sessions / notes / hello', async () => {
  const f = join(dir, 'team.json');
  writeFileSync(f, JSON.stringify(defaultTeamConfig({ name: 'neo', instanceId: 'id-neo' })));
  const cfg = readTeamConfig(f);
  assert.deepEqual([cfg.error, cfg.token, cfg.port, cfg.bind, cfg.instanceId, cfg.peers], [undefined, '', 7331, '0.0.0.0', 'id-neo', []]);
  const server = startTeamServer(cfg, () => ({ at: 1, sessions: [{ id: 'a' }] }));
  const host = await listen(server);
  try {
    assert.equal((await fetch(`http://${host}/v1/ping`)).status, 200);
    for (const auth of [undefined, 'Bearer ', 'Bearer x']) {
      const headers = auth === undefined ? {} : { Authorization: auth };
      assert.equal((await fetch(`http://${host}/v1/sessions`, { headers })).status, 401, String(auth));
      assert.equal((await fetch(`http://${host}/v1/hello`, { method: 'POST', headers, body: '{}' })).status, 401);
      assert.equal((await fetch(`http://${host}/v1/notes`, { method: 'POST', headers, body: '{}' })).status, 401);
    }
  } finally { server.close(); }
});

test('hello: the caller lands in my team.json with its IP; the same instanceId only moves the host', async () => {
  const f = join(dir, 'team-hello.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok-123456', instanceId: 'id-neo', peers: [{ name: 'will', host: '10.9.9.9:7441', instanceId: 'id-will' }] }));
  const cfg = readTeamConfig(f);
  const server = startTeamServer(cfg, () => ({}), { onHello: peer => addPeerToConfig(f, peer) });
  const host = await listen(server);
  try {
    // same instance, new address (127.0.0.1 here) → host updated, name kept
    let r = await postHello({ name: 'p', host }, 'tok-123456', { name: 'will-new-name', port: 7441, instanceId: 'id-will' });
    assert.deepEqual([r.ok, r.name, r.instanceId], [true, 'neo', 'id-neo']);
    assert.deepEqual(readTeamConfig(f).peers, [{ name: 'will', host: '127.0.0.1:7441', instanceId: 'id-will' }]);
    // a new teammate
    r = await postHello({ name: 'p', host }, 'tok-123456', { name: 'amy', port: 7551, instanceId: 'id-amy' });
    assert.equal(r.ok, true);
    assert.deepEqual(readTeamConfig(f).peers.map(p => [p.name, p.host]), [['will', '127.0.0.1:7441'], ['amy', '127.0.0.1:7551']]);
    assert.equal(JSON.parse(readFileSync(f, 'utf-8')).token, 'tok-123456', 'token untouched');
    assert.equal((await postHello({ name: 'p', host }, 'wrong', { name: 'x', port: 1 })).error, 'token mismatch');
    assert.equal((await fetch(`http://${host}/v1/hello`, { method: 'POST', headers: { Authorization: 'Bearer tok-123456' }, body: JSON.stringify({ name: 'x', port: 0 }) })).status, 400);
    assert.equal((await fetch(`http://${host}/v1/hello`, { headers: { Authorization: 'Bearer tok-123456' } })).status, 405);
  } finally { server.close(); }
});

test('join flow: invite → token saved + inviter peer → sessions reachable', async () => {
  const inviterCfg = { name: 'neo', token: newTeamToken(), instanceId: 'id-neo' };
  const server = startTeamServer(inviterCfg, () => ({ at: 5, sessions: [{ id: 's1', name: 'wt' }] }));
  const host = await listen(server);
  try {
    const code = encodeInvite({ token: inviterCfg.token, inviter: { name: 'neo', host, instanceId: 'id-neo' } });
    const f = join(dir, 'team-join.json');
    writeFileSync(f, JSON.stringify(defaultTeamConfig({ name: 'will', instanceId: 'id-will' })));
    const inv = decodeInvite(code);
    setTeamFields(f, { token: inv.token });
    assert.deepEqual(addPeerToConfig(f, inv.inviter), { ok: true, added: true, name: 'neo' });
    const cfg = readTeamConfig(f);
    assert.equal(cfg.token, inviterCfg.token);
    const r = await fetchPeer(cfg.peers[0], cfg.token);
    assert.deepEqual([r.ok, r.sessions.length, r.instanceId], [true, 1, 'id-neo']);
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
