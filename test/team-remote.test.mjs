// Team sharing phase 3: per-session delegation — grants, the signed remote endpoints, the busy / rate / guard checks,
// masking of the last answer, the owner-side checks (auto revoke, delegate, last-moment screen check) and the log file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const until = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };
import { startTeamServer, fetchPeer, signRequest, remoteInput, remoteInterrupt, remoteLast, remoteScreen, screenLines, lastText, sanitizeDelegations, sanitizeSessions } from '../team/peer.mjs';
import { createDelegationStore, createRemoteLog, createEventThrottle, validateRemoteText, remoteMessage, resolveDelegatedSession, screenAllowsInput, remoteInterruptAllowed, canDelegate, autoRevokeReasons, hostIpv4, permissionOk, REMOTE_TTL_MS, REMOTE_TEXT_MAX, REMOTE_RATE, REMOTE_LAST_MAX, REMOTE_SCREEN_RATE, REMOTE_SCREEN_LINES, REMOTE_SCREEN_LINE_MAX, REMOTE_SCREEN_BYTES, REMOTE_SCREEN_LOG_MS, REMOTE_SCREEN_CACHE_MS } from '../team/remote.mjs';
const P = id => globalThis.AgentDeskTeam.publicSessionId(id);

const ID = { me: '11111111-1111-4111-8111-111111111111', will: '22222222-2222-4222-8222-222222222222', amy: '33333333-3333-4333-8333-333333333333', bob: '44444444-4444-4444-8444-444444444444' };
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };
const raw = (host, token, method, path, body = '') => { const s = signRequest(token, method, host, path, body); return fetch(`http://${host}${path}`, { method, headers: { ...s.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined }); };
const OTHER_GRANT = 'ab'.repeat(24);
// two Orca worktrees of one repo: the same repo id before "::"
const REPO = '3a17eda1-0000-4000-8000-000000000000';
const WT_PAY = `${REPO}::/Users/neo/project/payout`, WT_MAIN = `${REPO}::/Users/neo/project/main`;

// will is registered at 127.0.0.1 (where the tests call from); amy elsewhere
function setup({ sessions, slowInput, slowScreen, peers, inputResult, interruptResult, screenResult } = {}) {
  const cfg = { name: 'neo', token: 't0k', instanceId: ID.me, peers: peers || [{ name: 'will', host: '127.0.0.1:7441', instanceId: ID.will }, { name: 'amy', host: '10.0.0.9:7331', instanceId: ID.amy }] };
  const store = createDelegationStore();
  const calls = { input: [], interrupt: [], last: [], screen: [], events: [] };
  let clock = 1_000_000;
  const snap = { at: 10, sessions: sessions || [
    { id: WT_PAY, name: 'payout', status: 'waiting', handle: 'tmux:%1', lastMsg: 'short last', agent: 'claude', permissionMode: 'default' },
    { id: WT_MAIN, name: 'main', status: 'waiting', handle: 'tmux:%9', agent: 'claude', permissionMode: 'default' },
    { id: 'wt2', name: 'back', status: 'running', handle: 'tmux:%2' },
    { id: 'wt3', name: 'ask', status: 'waiting', needsInput: true, handle: 'tmux:%3' },
  ] };
  const remote = {
    input: async (ctx) => { if (inputResult) return inputResult; calls.input.push(ctx); if (slowInput) await slowInput; return { ok: true, accepted: true }; },
    interrupt: async (ctx) => { calls.interrupt.push(ctx); return interruptResult || { ok: true }; },
    last: async (ctx) => { calls.last.push(ctx); return { text: ctx.session ? ctx.session.lastMsg : '', at: 5 }; },
    screen: async (ctx) => { calls.screen.push(ctx); if (slowScreen) await slowScreen; return screenResult !== undefined ? screenResult : { lines: ctx.session.screen || ['⏺ done', '❯ '] }; },
    event: e => calls.events.push(e),
  };
  const server = startTeamServer(cfg, () => snap, { delegations: store, remote, now: () => clock });
  const grant = (localId, iid = ID.will, peerName = 'will') => { store.add({ localId, instanceId: iid, peerName, name: localId }); return store.forInstances([iid]).find(d => d.sessionId === P(localId)).grant; };
  return { cfg, store, calls, snap, server, grant, tick: ms => { clock += ms; } };
}
const input = (host, localId, grant, text = 'go', token = 't0k') => raw(host, token, 'POST', `/v1/sessions/${P(localId)}/input`, JSON.stringify({ grant, text }));

test('validateRemoteText / remoteMessage: one line, invisible characters out, 1–4000 characters, fixed prefix with the rule', () => {
  assert.deepEqual(validateRemoteText('a\nb\u0000c\u200bd  '), { text: 'a b cd' });
  assert.deepEqual(validateRemoteText('git push origin main \\\\'), { text: 'git push origin main' }, 'trailing backslashes (line continuation) go');
  assert.equal(validateRemoteText('\\ \\').error, 'text is required');
  assert.equal(validateRemoteText('').error, 'text is required');
  assert.equal(validateRemoteText(' \n\t ').error, 'text is required');
  assert.equal(validateRemoteText(42).error, 'text is required');
  assert.equal(validateRemoteText('가'.repeat(REMOTE_TEXT_MAX)).text.length, REMOTE_TEXT_MAX);
  assert.match(validateRemoteText('x'.repeat(REMOTE_TEXT_MAX + 1)).error, /over 4000/);
  assert.equal(remoteMessage('will', '/clear'), '[원격 · will — 주인 확인 없이 파괴적 작업(삭제·force push·운영 DB 변경) 금지] /clear', 'never starts with / or !');
  assert.ok(remoteMessage('w\nill', '!rm').startsWith('[원격 · w ill — '));
});

test('delegation store: keyed by the full local id; per (session, teammate) grant, matched only for that teammate', () => {
  const s = createDelegationStore();
  const d = s.add({ localId: WT_PAY, instanceId: ID.will, peerName: 'will', name: 'payout' });
  assert.ok(!('grant' in d), 'the public view has no grant');
  assert.equal(d.sessionId, P(WT_PAY)); assert.equal(d.localId, WT_PAY);
  const [g] = s.forInstances([ID.will]);
  assert.match(g.grant, /^[0-9a-f]{48}$/);
  assert.ok(!('localId' in g) && !JSON.stringify(g).includes('/Users/'), 'the teammate gets no local id or path');
  assert.deepEqual(s.forInstances([ID.amy]), []);
  assert.ok(s.match(P(WT_PAY), g.grant, [ID.will]));
  assert.equal(s.match(P(WT_MAIN), g.grant, [ID.will]), null, 'the other worktree of the same repo');
  assert.equal(s.match(P(WT_PAY), g.grant, [ID.amy]), null, 'another teammate cannot use it');
  assert.equal(s.match(P(WT_PAY), OTHER_GRANT, [ID.will]), null);
  assert.equal(s.match(P(WT_PAY), 'short', [ID.will]), null);
  assert.equal(s.add({ localId: WT_PAY, instanceId: ID.will, peerName: 'will' }).at, d.at, 'adding twice keeps the first');
  s.add({ localId: WT_PAY, instanceId: ID.amy, peerName: 'amy' });
  assert.notEqual(s.forInstances([ID.amy])[0].grant, g.grant, 'a grant per pair');
  assert.equal(s.isDelegated(P(WT_PAY)), true); assert.equal(s.isDelegated(P(WT_MAIN)), false);
  assert.equal(s.remove(WT_PAY, ID.will).length, 1);
  assert.equal(s.match(P(WT_PAY), g.grant, [ID.will]), null);
  assert.equal(s.clear().length, 1); assert.equal(s.size, 0);
});

test('/v1/sessions: delegations only for the teammate at the caller address; sessions carry delegated; the answer changes', async () => {
  const { store, server } = setup();
  const host = await listen(server);
  try {
    const before = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(before.ok, true); assert.deepEqual(before.delegations, []);
    assert.notEqual(before.sessions[0].id, before.sessions[1].id, 'two worktrees of one repo get different public ids');
    store.add({ localId: 'wt2', instanceId: ID.amy, peerName: 'amy', name: 'back' });
    const forAmy = await fetchPeer({ name: 'p', host }, 't0k', { etag: before.etag, since: before.theirAt });
    assert.ok(!forAmy.notModified, 'a delegation change is a change');
    assert.deepEqual(forAmy.delegations, [], 'amy\'s grant never reaches the caller at 127.0.0.1');
    assert.equal(forAmy.sessions.find(s => s.id === P('wt2')).delegated, true);
    assert.equal(forAmy.sessions.find(s => s.id === P(WT_PAY)).delegated, undefined);
    store.add({ localId: WT_PAY, instanceId: ID.will, peerName: 'will', name: 'payout', repo: 'repo', branch: 'main' });
    const forWill = await fetchPeer({ name: 'p', host }, 't0k', { etag: forAmy.etag, since: forAmy.theirAt });
    assert.equal(forWill.delegations.length, 1);
    assert.deepEqual({ ...forWill.delegations[0], grant: 'x' }, { sessionId: P(WT_PAY), grant: 'x', name: 'payout', repo: 'repo', branch: 'main' });
    assert.ok(!JSON.stringify(forWill).includes('tmux:') && !JSON.stringify(forWill).includes('/Users/'), 'no terminal handle or path leaves');
    const same = await fetchPeer({ name: 'p', host }, 't0k', { etag: forWill.etag, since: forWill.theirAt });
    assert.equal(same.notModified, true);
  } finally { server.close(); }
  assert.deepEqual(sanitizeDelegations([{ sessionId: 'a::/x', grant: OTHER_GRANT, name: '<b>' }, { sessionId: 'b', grant: 'nothex' }, null]).map(d => d.sessionId), [P('a::/x')]);
});

test('id collision: two worktrees of one repo — only the delegated one takes input; ending it revokes', async () => {
  const { store, calls, server, grant, snap } = setup();
  const host = await listen(server);
  try {
    const g = grant(WT_PAY);
    assert.equal((await input(host, WT_MAIN, g)).status, 403, 'the other worktree of the same repo is not delegated');
    assert.equal(calls.input.length, 0);
    assert.equal((await input(host, WT_PAY, g, 'pay only')).status, 200);
    assert.equal(calls.input.length, 1);
    assert.equal(calls.input[0].session.id, WT_PAY, 'typed into the delegated worktree');
    assert.equal(calls.input[0].session.handle, 'tmux:%1');
    // a second snapshot entry with the same local id → cannot be placed → busy, nothing typed
    snap.sessions.push({ ...snap.sessions[0] });
    assert.equal((await input(host, WT_PAY, g, 'twice')).status, 409);
    assert.equal(calls.input.length, 1);
    snap.sessions.pop();
  } finally { server.close(); }
  // the owner's auto revoke works on full local ids: WT_MAIN alive does not keep WT_PAY delegated
  const sessions = [{ id: WT_MAIN, status: 'waiting' }, { id: WT_PAY, status: 'done', ended: true }];
  const ended = autoRevokeReasons(store.list(), { sessions, peers: [{ name: 'will', host: '127.0.0.1:7441', instanceId: ID.will }], stateOf: () => ({ ok: true }) });
  assert.deepEqual(ended.map(d => [d.localId, d.reason]), [[WT_PAY, 'session ended']]);
  assert.equal(resolveDelegatedSession([{ id: WT_MAIN }], WT_PAY), null);
  assert.equal(resolveDelegatedSession([{ id: WT_PAY }, { id: WT_PAY }], WT_PAY), null, 'two hits → none (fail closed)');
  assert.equal(resolveDelegatedSession([{ id: WT_PAY }, { id: WT_MAIN }], WT_PAY).id, WT_PAY);
});

test('input: unsigned 401, wrong / other teammate\'s grant 403, accepted with the cleaned text', async () => {
  const { store, calls, server, grant } = setup();
  const host = await listen(server);
  const will = grant(WT_PAY);
  const amy = grant(WT_PAY, ID.amy, 'amy');
  const pid = P(WT_PAY);
  try {
    assert.equal((await fetch(`http://${host}/v1/sessions/${pid}/input`, { method: 'POST', body: '{}' })).status, 401, 'unsigned');
    assert.equal((await input(host, WT_PAY, will, 'hi', 'bad')).status, 401, 'wrong team token');
    assert.equal((await input(host, WT_PAY, OTHER_GRANT)).status, 403, 'grant mismatch');
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/input`, JSON.stringify({ text: 'hi' }))).status, 403, 'no grant');
    assert.equal((await input(host, WT_PAY, amy)).status, 403, 'amy\'s grant from will\'s address');
    assert.equal((await input(host, 'wt2', will)).status, 403, 'grant of another session');
    assert.equal((await raw(host, 't0k', 'POST', '/v1/sessions/wt1/input', '{}')).status, 404, 'not a public session id');
    assert.equal((await raw(host, 't0k', 'GET', `/v1/sessions/${pid}/input`)).status, 405);
    assert.equal((await input(host, WT_PAY, will, '')).status, 400);
    assert.equal((await input(host, WT_PAY, will, 'x'.repeat(REMOTE_TEXT_MAX + 1))).status, 400);
    assert.equal(calls.input.length, 0, 'nothing typed so far');
    const ok = await input(host, WT_PAY, will, '테스트\n돌려줘\u0007');
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, accepted: true });
    assert.equal(calls.input.length, 1);
    assert.equal(calls.input[0].text, '테스트 돌려줘');
    assert.equal(calls.input[0].delegation.peerName, 'will');
    assert.equal(calls.events.at(-1).result, 'accepted');
    assert.equal((await input(host, WT_PAY, will, '가'.repeat(REMOTE_TEXT_MAX))).status, 200, '4000 characters of Hangul fit');
    assert.deepEqual(await remoteInput({ name: 'neo', host }, 't0k', pid, will, 'via client'), { ok: true, accepted: true });
    const denied = await remoteInput({ name: 'neo', host }, 't0k', pid, OTHER_GRANT, 'x');
    assert.deepEqual([denied.ok, denied.status, denied.error], [false, 403, 'not delegated']);
    // revoked → 403 everywhere
    store.remove(WT_PAY, ID.will);
    assert.equal((await input(host, WT_PAY, will, 'after revoke')).status, 403);
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/last`, JSON.stringify({ grant: will }))).status, 403);
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/interrupt`, JSON.stringify({ grant: will }))).status, 403);
  } finally { server.close(); }
});

test('two registered teammates at one address: no grants served there, every remote request 403 "ambiguous teammate"', async () => {
  const peers = [{ name: 'will', host: '127.0.0.1:7441', instanceId: ID.will }, { name: 'bob', host: '127.0.0.1:7551', instanceId: ID.bob }];
  const { server, grant, calls } = setup({ peers });
  const host = await listen(server);
  const g = grant(WT_PAY);
  try {
    assert.deepEqual((await fetchPeer({ name: 'p', host }, 't0k')).delegations, []);
    const r = await input(host, WT_PAY, g);
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'ambiguous teammate');
    assert.equal(calls.input.length, 0);
  } finally { server.close(); }
});

test('input: busy (running, choice prompt, ended, unknown, in flight, owner-side screen check) → 409; nothing typed', async () => {
  let release; const slow = new Promise(r => { release = r; });
  const { calls, server, snap, grant } = setup({ slowInput: slow });
  const host = await listen(server);
  try {
    assert.equal((await input(host, 'wt2', grant('wt2'))).status, 409, 'running');
    assert.equal((await input(host, 'wt3', grant('wt3'))).status, 409, 'permission / choice prompt: never answered remotely');
    snap.sessions.push({ id: 'wt4', status: 'waiting', ended: true });
    assert.equal((await input(host, 'wt4', grant('wt4'))).status, 409, 'ended');
    assert.equal((await input(host, 'wt9', grant('wt9'))).status, 409, 'not in my list');
    const g1 = grant(WT_PAY);
    const first = input(host, WT_PAY, g1, 'first');
    await until(() => calls.input.length === 1);   // the first input is in flight
    assert.equal((await input(host, WT_PAY, g1, 'second')).status, 409, 'one input at a time');
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual(calls.input.map(c => c.text), ['first']);
    assert.ok(calls.events.filter(e => e.result === 'busy').length >= 5);
  } finally { server.close(); }
  const s2 = setup({ inputResult: { ok: false, busy: true } });
  const h2 = await listen(s2.server);
  try { assert.equal((await input(h2, WT_PAY, s2.grant(WT_PAY))).status, 409, 'owner side saw the screen not ready'); }
  finally { s2.server.close(); }
});

test('screenAllowsInput: only an empty ❯ prompt after a finished turn; unreadable, running, choice or a draft → no', () => {
  const idle = ['⏺ Done. Tests pass.', '', '─────', '❯ ', '─────', '  ? for shortcuts'];
  assert.equal(screenAllowsInput(idle), true);
  assert.equal(screenAllowsInput(['⏺ Done.', '✻ Worked for 12s', '─────', '❯ ', '─────']), false, 'a status the screen reader cannot place → no (fail closed)');
  assert.equal(screenAllowsInput(['⏺ Finished the change.', '─────', '❯', '─────']), true, 'a ⏺ block without a done line');
  assert.equal(screenAllowsInput(['⏺ Done.', '─────', '❯ half-typed owner draft', '─────']), false, 'the owner is typing');
  assert.equal(screenAllowsInput(['⏺ Bash(ls)', '✻ Thinking… (3s · esc to interrupt)', '─────', '❯ ', '─────']), false, 'running');
  assert.equal(screenAllowsInput(['Do you want to proceed?', '❯ 1. Yes', '  2. No']), false, 'permission prompt');
  assert.equal(screenAllowsInput(['⏺ Done.', '─────', '❯ ', '─────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']), false, 'checks off: never');
  assert.equal(screenAllowsInput(['some text without a prompt']), false);
  assert.equal(screenAllowsInput(null), false, 'unreadable');
  assert.equal(screenAllowsInput([]), false);
  assert.equal(screenAllowsInput('❯ '), false);
});

test('canDelegate: connected teammate alone at its address, a live Claude Code session with a terminal, permission checks on', () => {
  const will = { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will }, amy = { name: 'amy', host: '10.0.0.6:7331', instanceId: ID.amy };
  const ok = { id: WT_PAY, agent: 'claude', handle: 'tmux:%1', permissionMode: 'default' };
  const base = { peer: will, peers: [will, amy], state: { ok: true }, session: ok };
  assert.equal(canDelegate(base), '');
  assert.equal(canDelegate({ ...base, peer: null }), 'unknown teammate');
  assert.equal(canDelegate({ ...base, peer: { ...will, instanceId: '' } }), 'unknown teammate');
  assert.equal(canDelegate({ ...base, state: { ok: false } }), 'teammate not connected');
  assert.equal(canDelegate({ ...base, state: { ok: true, mismatch: true } }), 'teammate not connected');
  assert.equal(canDelegate({ ...base, peers: [will, amy, { name: 'bob', host: '10.0.0.5:7441', instanceId: ID.bob }] }), 'another teammate shares this address');
  assert.equal(canDelegate({ ...base, session: null }), 'unknown session');
  assert.equal(canDelegate({ ...base, session: { ...ok, ended: true } }), 'unknown session');
  assert.equal(canDelegate({ ...base, session: { ...ok, agent: 'codex' } }), 'Claude Code sessions only');
  for (const mode of ['bypassPermissions', '', undefined, 'somethingNew']) assert.equal(canDelegate({ ...base, session: { ...ok, permissionMode: mode } }), 'permission checks off/unknown', `mode ${mode}`);
  for (const mode of ['default', 'plan', 'acceptEdits']) assert.equal(canDelegate({ ...base, session: { ...ok, permissionMode: mode } }), '', `mode ${mode}`);
  assert.equal(canDelegate({ ...base, state: { ok: true, offnet: true } }), 'teammate not connected');
  assert.equal(canDelegate({ ...base, peer: { ...will, host: 'will-mac.local:7331' } }), 'teammate address is not an IP');
  assert.equal(canDelegate({ ...base, peers: [will, { name: 'bob', host: '010.000.000.005:7441', instanceId: ID.bob }] }), 'another teammate shares this address', 'zero-padded octets are the same IP');
  assert.equal(canDelegate({ ...base, peers: [will, { name: 'host', host: 'someone.local:7331', instanceId: ID.bob }] }), 'an unidentified teammate is on the same network');
  assert.equal(canDelegate({ ...base, peers: [will, { name: 'noid', host: '10.0.0.77:7331' }] }), 'an unidentified teammate is on the same network', 'no instance id on the same /24');
  assert.equal(canDelegate({ ...base, peers: [will, { name: 'noid', host: '10.0.9.77:7331' }] }), '', 'another /24 is fine');
  assert.equal(canDelegate({ ...base, session: { ...ok, handle: '' } }), 'no terminal');
});

test('autoRevokeReasons: expiry, session ended / bypass, teammate removed / shared address / mismatch / offnet / unreachable', () => {
  let clock = 10_000_000; const s0 = createDelegationStore({ now: () => clock });
  s0.add({ localId: WT_PAY, instanceId: ID.will, peerName: 'will' });
  const s = s0;
  const will = { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will };
  const live = [{ id: WT_PAY, status: 'waiting', permissionMode: 'default' }];
  const now = 10_000_000;
  const run = (o) => autoRevokeReasons(s.list(), { sessions: live, peers: [will], stateOf: () => ({ ok: true, lastOk: now }), now, ...o }).map(d => d.reason);
  assert.deepEqual(run({}), [], 'all fine');
  assert.deepEqual(run({ sessions: [] }), ['session ended']);
  assert.deepEqual(run({ sessions: [{ id: WT_PAY, ended: true }] }), ['session ended']);
  assert.deepEqual(run({ sessions: [{ id: WT_PAY, permissionMode: 'bypassPermissions' }] }), ['permission checks off/unknown'], 'switched to bypass after delegating');
  assert.deepEqual(run({ sessions: [{ id: WT_PAY }] }), ['permission checks off/unknown'], 'mode no longer known');
  assert.deepEqual(run({ stateOf: () => ({ ok: false, offnet: true, fails: 0 }) }), ['teammate on another network']);
  assert.deepEqual(run({ peers: [will, { name: 'bob', host: '10.0.0.005:7441' }] }), ['ambiguous teammate'], 'same IP after normalising, instance id or not');
  assert.deepEqual(run({ now: now + REMOTE_TTL_MS + 1, stateOf: () => ({ ok: true, lastOk: now + REMOTE_TTL_MS }) }), ['expired']);
  assert.deepEqual(run({ sessions: [{ id: WT_MAIN }] }), ['session ended'], 'another worktree of the repo does not keep it');
  assert.deepEqual(run({ peers: [] }), ['teammate removed']);
  assert.deepEqual(run({ peers: [will, { name: 'bob', host: '10.0.0.5:7441', instanceId: ID.bob }] }), ['ambiguous teammate']);
  assert.deepEqual(run({ stateOf: () => ({ ok: false, mismatch: true }) }), ['identity mismatch']);
  assert.deepEqual(run({ stateOf: () => ({ ok: false, fails: 3, lastOk: now - 121000 }) }), ['teammate unreachable']);
  assert.deepEqual(run({ stateOf: () => ({ ok: false, fails: 3, lastOk: now - 60000 }) }), [], 'a short blip keeps it');
  assert.deepEqual(run({ stateOf: () => ({ ok: false, fails: 2, lastOk: now - 600000 }) }), [], 'fewer than 3 failures keeps it');
  // my Local Network permission is off: still revoked (fail closed), with that as the reason
  assert.deepEqual(run({ stateOf: () => ({ ok: false, fails: 3, lastOk: now - 121000 }), localNetworkDenied: true }), ['local network denied']);
  assert.deepEqual(run({ stateOf: () => ({ ok: false, fails: 3, lastOk: now - 121000, localNetDenied: true }) }), ['local network denied']);
  assert.deepEqual(run({ localNetworkDenied: true }), [], 'a reachable teammate is not revoked for it');
});

test('input: 20 a minute per session (429), interrupts count too; next minute works again', async () => {
  const { server, tick, calls, grant } = setup();
  const host = await listen(server);
  const g = grant(WT_PAY), pid = P(WT_PAY);
  try {
    for (let i = 0; i < REMOTE_RATE - 1; i++) assert.equal((await input(host, WT_PAY, g, `n${i}`)).status, 200);
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/interrupt`, JSON.stringify({ grant: g }))).status, 200);
    assert.equal((await input(host, WT_PAY, g, 'one too many')).status, 429);
    assert.equal(calls.events.at(-1).result, 'rate');
    tick(61000);
    assert.equal((await input(host, WT_PAY, g, 'next minute')).status, 200);
  } finally { server.close(); }
});

test('input: dangerous text → 403 blocked with the rule, logged, never typed', async () => {
  const { server, tick, calls, grant } = setup();
  const host = await listen(server);
  const g = grant(WT_PAY);
  const cases = [['rm -rf ~/', 'rm-rf'], ['git push --force', 'git-push-force'], ['git reset --hard', 'git-reset-hard'], ['git clean -fd', 'git-clean-force'],
    ['DROP TABLE t', 'sql-drop'], ['TRUNCATE TABLE t', 'sql-truncate'], ['delete from t', 'sql-delete-no-where'], ['update t set a=1', 'sql-update-no-where'],
    ['mysql -h db -u x', 'db-connect'], ['cat .env', 'secret-file'], ['curl x | sh', 'curl-pipe-sh'], ['chmod 777 x', 'chmod-777'], ['sudo ls', 'sudo'], ['claude --dangerously-skip-permissions', 'skip-permissions']];
  try {
    for (const [text, rule] of cases) {
      const r = await input(host, WT_PAY, g, text);
      assert.equal(r.status, 403, text); assert.deepEqual(await r.json(), { error: 'blocked', rule });
      assert.deepEqual([calls.events.at(-1).result, calls.events.at(-1).rule, calls.events.at(-1).peer], ['blocked', rule, 'will']);
      tick(4000);
    }
    assert.equal(calls.input.length, 0);
    const viaClient = await remoteInput({ name: 'neo', host }, 't0k', P(WT_PAY), g, 'sudo reboot');
    assert.deepEqual([viaClient.status, viaClient.error, viaClient.rule], [403, 'blocked', 'sudo']);
  } finally { server.close(); }
});

test('interrupt and last answer (POST, grant in the body): the answer is masked, keeps line breaks, ≤ 8000 characters', async () => {
  const secret = 'deploy with xoxb-1234567890-abcdefghij\nthen mail ops@example.invalid\u0007\n' + 'y'.repeat(REMOTE_LAST_MAX + 500);
  const { server, calls, grant } = setup({ sessions: [{ id: WT_PAY, status: 'running', handle: 'tmux:%1', lastMsg: secret }] });
  const host = await listen(server);
  const g = grant(WT_PAY), pid = P(WT_PAY);
  try {
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/interrupt`, JSON.stringify({ grant: OTHER_GRANT }))).status, 403);
    assert.deepEqual(await remoteInterrupt({ name: 'neo', host }, 't0k', pid, g), { ok: true }, 'interrupt works while running');
    assert.equal(calls.interrupt.length, 1);
    assert.equal(calls.events.at(-1).kind, 'interrupt');
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${pid}/last`, JSON.stringify({ grant: OTHER_GRANT }))).status, 403);
    assert.equal((await raw(host, 't0k', 'GET', `/v1/sessions/${pid}/last?grant=${g}`)).status, 405, 'the grant never travels in a URL');
    const r = await remoteLast({ name: 'neo', host }, 't0k', pid, g);
    assert.equal(r.ok, true); assert.equal(r.at, 5);
    for (const leak of ['xoxb-', 'example.invalid', '\u0007']) assert.ok(!r.text.includes(leak), leak);
    assert.ok(r.text.includes('\n'), 'line breaks kept');
    assert.ok(r.text.length <= REMOTE_LAST_MAX);
  } finally { server.close(); }
});

test('interrupt: a Terminal.app tab is refused (409 unsupported); tmux / Orca handles are allowed', async () => {
  assert.equal(remoteInterruptAllowed('tmux:%3'), true);
  assert.equal(remoteInterruptAllowed('term-5f2a'), true, 'an Orca terminal handle');
  assert.equal(remoteInterruptAllowed('term:4242'), false, 'Terminal.app / iTerm tab (window activation + Esc)');
  assert.equal(remoteInterruptAllowed(''), false);
  const { server, grant } = setup({ interruptResult: { ok: false, unsupported: true } });
  const host = await listen(server);
  try {
    const r = await remoteInterrupt({ name: 'neo', host }, 't0k', P(WT_PAY), grant(WT_PAY));
    assert.deepEqual([r.ok, r.status, r.error], [false, 409, 'unsupported']);
  } finally { server.close(); }
});

test('no delegation store → the remote paths do not exist', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k', peers: [{ name: 'will', host: '127.0.0.1:1', instanceId: ID.will }] }, () => ({ at: 1, sessions: [{ id: 'wt1', status: 'waiting' }] }));
  const host = await listen(server);
  try { assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${P('wt1')}/input`, JSON.stringify({ grant: OTHER_GRANT, text: 'x' }))).status, 404); }
  finally { server.close(); }
});

test('event throttle: rate / busy / blocked once per session and result a minute (count folded in); others always', () => {
  let t = 0; const th = createEventThrottle({ now: () => t });
  const e = (result, sessionId = 's_a') => ({ kind: 'input', result, sessionId });
  assert.ok(th.pass(e('blocked')));
  assert.equal(th.pass(e('blocked')), null); assert.equal(th.pass(e('blocked')), null);
  assert.ok(th.pass(e('blocked', 's_b')), 'another session');
  assert.ok(th.pass(e('busy')), 'another result');
  assert.ok(th.pass(e('accepted'))); assert.ok(th.pass(e('accepted')), 'accepted inputs are never folded');
  t = 61000;
  assert.equal(th.pass(e('blocked')).folded, 2, 'the next one says how many were folded');
});

test('remote log: 0600 file in a 0700 folder, masked and cut text, newest first, rewritten only past max + a tenth', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'agentdesk-remote-')), 'private');
  const file = join(dir, 'team-remote.jsonl');
  const log = createRemoteLog(file, { max: 10 });
  log.append({ kind: 'delegate', sessionId: 's_x', peer: 'will' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const e = log.append({ kind: 'input', result: 'accepted', sessionId: 's_x', peer: 'will', text: 'token=supersecret123 ' + 'z'.repeat(500) });
  assert.ok(!e.text.includes('supersecret123') && e.text.length <= 200);
  for (let i = 0; i < 9; i++) log.append({ kind: 'input', result: 'accepted', sessionId: 's_x', peer: 'will', text: `n${i}` });
  assert.equal(readFileSync(file, 'utf-8').trim().split('\n').length, 11, 'max + 1 (within the slack): appended, not rewritten');
  log.append({ kind: 'input', result: 'accepted', sessionId: 's_x', peer: 'will', text: 'n9' });
  const lines = readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 10, 'past the slack: rewritten to the last 10 lines');
  assert.equal(JSON.parse(lines.at(-1)).text, 'n9');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'still 0600 after the rewrite');
  assert.deepEqual(log.recent(2).map(x => x.text), ['n9', 'n8']);
  assert.equal(createRemoteLog(file, { max: 10 }).recent(20).length, 10, 'reloaded from the file');
});

test('delegation TTL: 2 hours, then the grant opens nothing and is not served; the owner can extend', () => {
  let t = 1_000_000; const s = createDelegationStore({ now: () => t });
  const d = s.add({ localId: WT_PAY, instanceId: ID.will, peerName: 'will' });
  assert.equal(d.expiresAt, t + REMOTE_TTL_MS);
  const g = s.forInstances([ID.will])[0].grant;
  t += REMOTE_TTL_MS - 1000;
  assert.equal(s.extend(WT_PAY, ID.will).expiresAt, t + REMOTE_TTL_MS, 'extended from now');
  assert.equal(s.extend(WT_MAIN, ID.will), null);
  t += REMOTE_TTL_MS - 1;
  assert.ok(s.match(P(WT_PAY), g, [ID.will]));
  t += 1;
  assert.equal(s.match(P(WT_PAY), g, [ID.will]), null, 'expired');
  assert.deepEqual(s.forInstances([ID.will]), [], 'not served once expired');
});

test('server: bypass / unknown permission mode at input time → 409; same IP counted with or without instance id', async () => {
  const { server, grant, snap, calls } = setup();
  const host = await listen(server);
  const g = grant(WT_PAY);
  try {
    snap.sessions[0].permissionMode = 'bypassPermissions';
    assert.equal((await input(host, WT_PAY, g)).status, 409);
    snap.sessions[0].permissionMode = '';
    assert.equal((await input(host, WT_PAY, g)).status, 409);
    assert.equal(calls.input.length, 0);
    snap.sessions[0].permissionMode = 'plan';
    assert.equal((await input(host, WT_PAY, g)).status, 200);
  } finally { server.close(); }
  const s2 = setup({ peers: [{ name: 'will', host: '127.0.0.1:7441', instanceId: ID.will }, { name: 'noid', host: '127.000.000.001:7551' }] });
  const h2 = await listen(s2.server);
  try {
    const r = await input(h2, WT_PAY, s2.grant(WT_PAY));
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'ambiguous teammate');
    assert.deepEqual((await fetchPeer({ name: 'p', host: h2 }, 't0k')).delegations, []);
  } finally { s2.server.close(); }
  assert.equal(hostIpv4('010.0.0.5:7331'), '10.0.0.5'); assert.equal(hostIpv4('x.local:1'), null); assert.equal(hostIpv4('300.1.1.1:1'), null);
  assert.equal(permissionOk({ permissionMode: 'acceptEdits' }), true); assert.equal(permissionOk({}), false); assert.equal(permissionOk(null), false);
});

test('screen: signed, delegated callers only; masked, no ANSI / control characters, capped; fail closed when unreadable', async () => {
  const screen = ['\u001b[31m⏺ deploying\u001b[0m', 'token xoxb-1234567890-abcdefghij here', 'mail ops@example.invalid\u0007', '\u001b]0;title\u0007❯ '];
  const { server, calls, grant, tick } = setup({ sessions: [
    { id: WT_PAY, name: 'payout', status: 'waiting', handle: 'tmux:%1', agent: 'claude', permissionMode: 'default', screen },
    { id: 'wt3', name: 'ask', status: 'waiting', needsInput: true, handle: 'tmux:%3', screen: ['Do you want to proceed?', '❯ 1. Yes'] },
  ] });
  const host = await listen(server);
  const g = grant(WT_PAY), pid = P(WT_PAY), path = `/v1/sessions/${pid}/screen`;
  const amy = grant(WT_PAY, ID.amy, 'amy');
  try {
    assert.equal((await fetch(`http://${host}${path}`, { method: 'POST', body: JSON.stringify({ grant: g }) })).status, 401, 'unsigned');
    assert.equal((await raw(host, 'bad', 'POST', path, JSON.stringify({ grant: g }))).status, 401, 'wrong team token');
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: OTHER_GRANT }))).status, 403, 'not delegated');
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: amy }))).status, 403, 'another teammate\'s grant');
    assert.equal((await raw(host, 't0k', 'POST', path, '{}')).status, 403, 'no grant');
    assert.equal((await raw(host, 't0k', 'GET', `${path}?grant=${g}`)).status, 405, 'the grant never travels in a URL');
    assert.equal(calls.screen.length, 0, 'nothing read for a refused caller');
    const r = await remoteScreen({ name: 'neo', host }, 't0k', pid, g);
    assert.equal(r.ok, true);
    assert.deepEqual([r.status, r.needsInput, r.ended], ['waiting', false, false]);
    assert.ok(r.at > 0);
    assert.equal(r.lines.length, screen.length);
    const all = r.lines.join('\n');
    for (const leak of ['xoxb-', 'example.invalid', '\u0007', '\u001b', '[31m', 'title']) assert.ok(!all.includes(leak), leak);
    assert.equal(r.lines[0], '⏺ deploying');
    assert.equal(r.lines.at(-1), '❯');
    // one "viewed" entry per session and teammate per 10 minutes — polling does not flood the log
    for (let i = 0; i < 3; i++) assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }))).status, 200);
    assert.deepEqual(calls.events.filter(e => e.kind === 'screen').map(e => [e.result, e.peer]), [['viewed', 'will']]);
    tick(REMOTE_SCREEN_LOG_MS + 1);
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }))).status, 200);
    assert.equal(calls.events.filter(e => e.kind === 'screen').length, 2);
    // a permission prompt: the screen is shown, the status says the owner has to answer
    const ask = await remoteScreen({ name: 'neo', host }, 't0k', P('wt3'), grant('wt3'));
    assert.deepEqual([ask.ok, ask.needsInput], [true, true]);
  } finally { server.close(); }
});

test('screen: unreadable screen or unplaceable session → 409 busy; revoke → 403', async () => {
  const a = setup({ screenResult: null });
  const host = await listen(a.server);
  try {
    const r = await remoteScreen({ name: 'neo', host }, 't0k', P(WT_PAY), a.grant(WT_PAY));
    assert.deepEqual([r.ok, r.status, r.error], [false, 409, 'busy']);
    const gone = a.grant('wt-gone');
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${P('wt-gone')}/screen`, JSON.stringify({ grant: gone }))).status, 409, 'session not in the snapshot');
    const g = a.grant(WT_MAIN);
    a.store.remove(WT_MAIN, ID.will);
    assert.equal((await raw(host, 't0k', 'POST', `/v1/sessions/${P(WT_MAIN)}/screen`, JSON.stringify({ grant: g }))).status, 403, 'revoked');
  } finally { a.server.close(); }
});

test('screen: its own rate budget (90/min) — reads never use up the 20/min input budget', async () => {
  const { server, grant, tick, calls } = setup();
  const host = await listen(server);
  const g = grant(WT_PAY), pid = P(WT_PAY), path = `/v1/sessions/${pid}/screen`;
  try {
    for (let i = 0; i < REMOTE_SCREEN_RATE; i++) assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }))).status, 200, `read ${i}`);
    const before = calls.events.length;
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }))).status, 429);
    assert.equal(calls.events.length, before, 'a refused read is not logged');
    // the input budget is untouched: 20 inputs still go through
    for (let i = 0; i < REMOTE_RATE; i++) assert.equal((await input(host, WT_PAY, g, `n${i}`)).status, 200, `input ${i}`);
    assert.equal((await input(host, WT_PAY, g, 'one too many')).status, 429);
    // and a used-up input budget does not stop reading the screen
    tick(61000);
    for (let i = 0; i < REMOTE_RATE; i++) await input(host, WT_PAY, g, `m${i}`);
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }))).status, 200);
  } finally { server.close(); }
});

test('screenLines: last 200 lines, each ≤ 400 characters, ≤ 24 KB in all (newest kept), masked across the joined text', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const a = screenLines(many);
  assert.equal(a.length, REMOTE_SCREEN_LINES); assert.equal(a.at(-1), 'line 499');
  const wide = screenLines(['x'.repeat(5000)]);
  assert.equal(wide[0].length, REMOTE_SCREEN_LINE_MAX);
  const heavy = screenLines(Array.from({ length: 200 }, (_, i) => `${i} ` + '가'.repeat(300)));
  const bytes = heavy.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.ok(bytes <= REMOTE_SCREEN_BYTES, `${bytes}`);
  assert.ok(heavy.length < 200 && heavy.at(-1).startsWith('199 '), 'the newest lines are kept');
  assert.deepEqual(screenLines('not an array'), []);
  assert.deepEqual(screenLines(['a\r\nb']), ['a  b'], 'a line never splits into two');
  const s = screenLines(['AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36), 'password=hunter2hunter2']);
  for (const leak of ['AKIAIOSFODNN7EXAMPLE', 'ghp_aaaa', 'hunter2']) assert.ok(!s.join('\n').includes(leak), leak);
});

test('screen text never reaches /v1/sessions: sanitizeSessions drops screen / tail fields', () => {
  const out = sanitizeSessions([{ id: WT_PAY, name: 'payout', status: 'waiting', screen: ['secret screen'], tail: ['secret tail'], lines: ['secret lines'] }]);
  const j = JSON.stringify(out);
  for (const k of ['secret', '"screen"', '"tail"', '"lines"']) assert.ok(!j.includes(k), k);
});

test('screen: one read per session at a time — parallel requests share it, its result is reused for 1 s', async () => {
  let release; const slowScreen = new Promise(r => { release = r; });
  const { server, grant, tick, calls } = setup({ slowScreen });
  const host = await listen(server);
  const g = grant(WT_PAY), path = `/v1/sessions/${P(WT_PAY)}/screen`;
  const read = () => raw(host, 't0k', 'POST', path, JSON.stringify({ grant: g }));
  try {
    const pending = Array.from({ length: 8 }, read);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls.screen.length, 1, 'one terminal read in flight for 8 requests');
    release();
    const all = await Promise.all(pending);
    assert.deepEqual(all.map(r => r.status), Array(8).fill(200));
    const bodies = await Promise.all(all.map(r => r.json()));
    assert.ok(bodies.every(b => JSON.stringify(b.lines) === JSON.stringify(bodies[0].lines)));
    assert.equal((await read()).status, 200);
    assert.equal(calls.screen.length, 1, 'reused within 1 s');
    tick(REMOTE_SCREEN_CACHE_MS);
    assert.equal((await read()).status, 200);
    assert.equal(calls.screen.length, 2, 'read again after 1 s');
  } finally { server.close(); }
});

test('screen: the rate budget is per session and caller instance', async () => {
  const { server, grant, cfg } = setup();
  const host = await listen(server);
  const path = `/v1/sessions/${P(WT_PAY)}/screen`;
  const gw = grant(WT_PAY);
  try {
    for (let i = 0; i < REMOTE_SCREEN_RATE; i++) await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: gw }));
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: gw }))).status, 429);
    // another instance now registered at this address, delegated the same session: a budget of its own
    cfg.peers[0] = { name: 'bob', host: '127.0.0.1:7441', instanceId: ID.bob };
    const gb = grant(WT_PAY, ID.bob, 'bob');
    assert.equal((await raw(host, 't0k', 'POST', path, JSON.stringify({ grant: gb }))).status, 200);
  } finally { server.close(); }
});

test('M1 screenLines: a secret wrapped across rows is masked in every row it touches', () => {
  const tok = 'ghp_' + 'Ab1'.repeat(12);   // 40 characters
  const rows = ['$ export GH=' + tok.slice(0, 14), tok.slice(14, 30), tok.slice(30) + ' done', 'next line'];
  for (const r of rows.slice(0, 3)) assert.equal(globalThis.AgentDeskMask.mask(r), r, 'no row alone matches');
  const out = screenLines(rows);
  assert.equal(out.length, 4);
  for (const [i, part] of [[0, tok.slice(4, 14)], [1, tok.slice(14, 30)], [2, tok.slice(30)]]) assert.ok(!out[i].includes(part), `row ${i}: ${out[i]}`);
  assert.ok(out[0].startsWith('$ export GH=') && out[0].includes('[MASKED]'));
  assert.ok(out[2].endsWith(' done') && out[2].includes('[MASKED]'));
  assert.equal(out[3], 'next line', 'rows around it are untouched');
  // the same through lastText (its lines)
  const lt = lastText(rows.join('\n'));
  for (const part of [tok.slice(4, 14), tok.slice(14, 30), tok.slice(30)]) assert.ok(!lt.includes(part), part);
  // a secret within one row keeps the usual label
  assert.deepEqual(screenLines(['mail ops@example.invalid']), ['mail [MASKED EMAIL]']);
});

test('M2: private key body without its BEGIN line, and BEGIN without END, are masked', () => {
  const body = Array.from({ length: 4 }, (_, i) => `MIIEowIBAAKCAQEAu1SU1L${i}nDEFghiJKL0123456789abcdefABCDEF+/ghijklmnopqrstuvwx`.slice(0, 64));
  const tail = 'Zm9vYmFyMTIz==';
  // BEGIN scrolled off: body rows, the short last row, END
  const a = screenLines([...body, tail, '-----END RSA PRIVATE KEY-----', '$ ls']);
  assert.deepEqual(a.slice(0, 6), Array(6).fill('[MASKED PRIVATE KEY]'));
  assert.equal(a[6], '$ ls');
  // no BEGIN and no END: the body rows alone
  const b = screenLines(['cat key.pem', ...body.slice(0, 3), tail, 'prompt']);
  assert.deepEqual(b, ['cat key.pem', ...Array(4).fill('[MASKED PRIVATE KEY]'), 'prompt']);
  // one long base64 row on its own
  assert.deepEqual(screenLines([body[0]]), ['[MASKED PRIVATE KEY]']);
  // BEGIN with END cut off (the text was sliced / the window ends): everything from BEGIN on
  const c = screenLines(['key:', '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXk', 'short']);
  assert.deepEqual(c, ['key:', '[MASKED PRIVATE KEY]', '[MASKED PRIVATE KEY]', '[MASKED PRIVATE KEY]']);
  const lt = lastText('here:\n-----BEGIN PRIVATE KEY-----\nabc\ndef');
  assert.equal(lt, 'here:\n[MASKED PRIVATE KEY]\n[MASKED PRIVATE KEY]\n[MASKED PRIVATE KEY]');
  const cut = lastText('-----BEGIN RSA PRIVATE KEY-----\n' + 'QUJD'.repeat(REMOTE_LAST_MAX) + '\n-----END RSA PRIVATE KEY-----');
  assert.ok(!cut.includes('QUJD'), 'END sliced off still masks the body');
  // a BEGIN line that scrolled above the 200 rows kept: masked over the wider window
  const long = screenLines(['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 250 }, (_, i) => `k${i}`), '-----END RSA PRIVATE KEY-----']);
  assert.ok(long.every(l => l === '[MASKED PRIVATE KEY]'));
  // plain text that only looks long is kept
  assert.deepEqual(screenLines(['x'.repeat(80), '='.repeat(80)]), ['x'.repeat(80), '='.repeat(80)]);
});

test('L1: zero-width / format characters inside a token do not hide it', () => {
  const zw = 'ghp_' + 'a'.repeat(10) + '​' + 'a'.repeat(26);
  assert.ok(!screenLines([`token ${zw}`]).join('').includes('aaaaaaaaaa'));
  assert.ok(!lastText(`token ${zw}`).includes('aaaaaaaaaa'));
  assert.ok(!screenLines(['AKIA⁠IOSFODNN7EXAMPLE']).join('').includes('IOSFODNN7'));
  assert.ok(!lastText('xoxb-﻿1234567890-abcdefghij').includes('abcdefghij'));
});

test('L2: an unterminated OSC sequence removes only itself, not the rest of the line', () => {
  assert.deepEqual(screenLines(['before \u001b]0;window title rest of line']), ['before window title rest of line']);
  assert.deepEqual(screenLines(['a\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\ b']), ['alink b'], 'terminated by ST');
  assert.deepEqual(screenLines(['a\u001b]0;t\u0007b']), ['ab'], 'terminated by BEL');
  assert.deepEqual(screenLines(['x\u001b]2;abc\u001b[31mred']), ['xred'], 'cut short by the next ESC');
});
