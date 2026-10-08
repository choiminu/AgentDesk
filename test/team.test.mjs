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
