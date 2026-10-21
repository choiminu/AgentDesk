// Team safety status: core/team.js safetySummary / sanitizeSafety and the `safety` field of GET /v1/sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTeamServer, fetchPeer, signRequest, responseSignature } from '../team/peer.mjs';
import '../core/team.js';
import '../core/guard.js';

const T = globalThis.AgentDeskTeam;
const G = globalThis.AgentDeskGuard;
const ID = { a: '11111111-1111-4111-8111-111111111111' };
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };

const USER_RULE = { id: 'user-1', label: 'prod db host LABEL_SHOULD_NOT_LEAK', pattern: 'prod-db-17\\.internal\\.example', tools: ['Bash'], enabled: true, severity: 'block' };
const RULES = [...G.defaultRules(), USER_RULE];

test('safetySummary: guard mode / none, perm flag, 12-hex hash', () => {
  const s = T.safetySummary({ guardCfg: { mode: 'block', rules: RULES }, guardHookInstalled: true, permHookInstalled: true, guardLogEntries: [], now: Date.now() });
  assert.deepEqual(Object.keys(s).sort(), ['blocksToday', 'guard', 'perm', 'rulesHash']);
  assert.equal(s.guard, 'block'); assert.equal(s.perm, true); assert.match(s.rulesHash, /^[0-9a-f]{12}$/); assert.equal(s.blocksToday, 0);
  assert.equal(T.safetySummary({ guardCfg: { mode: 'warn', rules: RULES }, guardHookInstalled: false }).guard, 'none', 'hook not installed → none');
  assert.equal(T.safetySummary({ guardCfg: { mode: 'off', rules: RULES }, guardHookInstalled: true }).guard, 'off');
  assert.equal(T.safetySummary({}).perm, false);
});

test('safetySummary: hash ignores rule order and disabled rules (built-in or not), changes with an enabled rule', () => {
  const base = T.safetySummary({ guardCfg: { mode: 'warn', rules: RULES } }).rulesHash;
  assert.equal(T.safetySummary({ guardCfg: { mode: 'warn', rules: [...RULES].reverse() } }).rulesHash, base, 'order does not matter');
  assert.equal(T.safetySummary({ guardCfg: { mode: 'block', rules: RULES } }).rulesHash, base, 'mode is not part of the hash');
  const offUser = RULES.map(r => r.id === 'user-1' ? { ...r, enabled: false } : r);
  const withoutUser = RULES.filter(r => r.id !== 'user-1');
  assert.equal(T.safetySummary({ guardCfg: { rules: offUser } }).rulesHash, T.safetySummary({ guardCfg: { rules: withoutUser } }).rulesHash, 'a disabled rule counts as absent');
  assert.notEqual(T.safetySummary({ guardCfg: { rules: withoutUser } }).rulesHash, base);
  const offBuiltin = RULES.map(r => r.id === 'sql-drop' ? { ...r, enabled: false } : r);
  assert.equal(T.safetySummary({ guardCfg: { rules: offBuiltin } }).rulesHash, T.safetySummary({ guardCfg: { rules: RULES.filter(r => r.id !== 'sql-drop') } }).rulesHash, 'a disabled built-in is left out');
  assert.notEqual(T.safetySummary({ guardCfg: { rules: offBuiltin } }).rulesHash, base);
  // severity and pattern are part of the fingerprint
  assert.notEqual(T.safetySummary({ guardCfg: { rules: RULES.map(r => r.id === 'user-1' ? { ...r, severity: 'warn' } : r) } }).rulesHash, base);
  assert.notEqual(T.safetySummary({ guardCfg: { rules: RULES.map(r => r.id === 'user-1' ? { ...r, pattern: 'other' } : r) } }).rulesHash, base);
  // labels are not: renaming a rule is not a policy change
  assert.equal(T.safetySummary({ guardCfg: { rules: RULES.map(r => r.id === 'user-1' ? { ...r, label: 'renamed' } : r) } }).rulesHash, base);
  // a compiled rule (re, no pattern) hashes like its JSON form
  assert.equal(T.rulesHash([{ id: 'x', severity: 'warn', re: /ab+c/i }]), T.rulesHash([{ id: 'x', severity: 'warn', pattern: 'ab+c' }]));
});

test('safetySummary: blocksToday counts deny and rule asks since local midnight only', () => {
  const now = new Date(2026, 9, 21, 9, 30).getTime();
  const midnight = new Date(2026, 9, 21, 0, 0, 0, 0).getTime();
  const log = [
    { at: midnight - 1, decision: 'deny', rule: 'sql-drop' },          // yesterday 23:59:59.999 → not counted
    { at: midnight, decision: 'deny', rule: 'sql-drop' },              // exactly midnight → counted
    { at: midnight + 1000, decision: 'ask', rule: 'git-push-force' },  // rule ask → counted
    { at: midnight + 2000, decision: 'ask', rule: 'timeout' },         // synthetic asks → not counted
    { at: midnight + 3000, decision: 'ask', rule: 'no-path' },
    { at: midnight + 4000, decision: 'ask', rule: 'too-long' },
    { at: midnight + 5000, decision: 'late-pass', rule: 'sql-drop' },  // went through → not counted
    { at: midnight + 6000, type: 'rule-disabled', rule: 'user-1', reason: 'slow' },
    null, 'junk', { decision: 'deny' },
  ];
  assert.equal(T.safetySummary({ guardLogEntries: log, now }).blocksToday, 2);
  assert.equal(T.safetySummary({ guardLogEntries: log, now: midnight - 1 }).blocksToday, 3, 'seen from yesterday: the 23:59:59.999 deny counts too');
});

test('sanitizeSafety forces types and ranges; non-objects → null', () => {
  assert.equal(T.sanitizeSafety(null), null); assert.equal(T.sanitizeSafety('x'), null); assert.equal(T.sanitizeSafety([1]), null);
  assert.deepEqual(T.sanitizeSafety({}), { guard: 'unknown', perm: false, rulesHash: '', blocksToday: 0 }, 'missing guard is unknown, not off');
  assert.deepEqual(T.sanitizeSafety({ guard: 'block', perm: true, rulesHash: 'abcdef012345', blocksToday: 7, rules: [{ pattern: 'leak' }] }), { guard: 'block', perm: true, rulesHash: 'abcdef012345', blocksToday: 7 });
  assert.deepEqual(T.sanitizeSafety({ guard: 'evil', perm: 'true', rulesHash: 'ABCDEF012345', blocksToday: -5 }), { guard: 'unknown', perm: false, rulesHash: '', blocksToday: 0 });
  for (const g of ['none', 'off', 'warn', 'block', 'unknown']) assert.equal(T.sanitizeSafety({ guard: g }).guard, g);
  assert.equal(T.safetySummary({ guardCfg: { mode: 'weird' }, guardHookInstalled: true }).guard, 'unknown', 'a bad mode is unknown');
  assert.equal(T.sanitizeSafety({ rulesHash: 'abcdef0123456' }).rulesHash, '', '13 chars rejected');
  assert.equal(T.sanitizeSafety({ blocksToday: 1e9 }).blocksToday, 100000);
  assert.equal(T.sanitizeSafety({ blocksToday: 3.9 }).blocksToday, 3);
  assert.equal(T.sanitizeSafety({ blocksToday: 'NaN' }).blocksToday, 0);
});

test('server: /v1/sessions carries safety (sanitized) and no rule body; fetchPeer keeps it as peer.safety', async () => {
  const summary = T.safetySummary({ guardCfg: { mode: 'block', rules: RULES }, guardHookInstalled: true, permHookInstalled: true, guardLogEntries: [{ at: Date.now(), decision: 'deny', rule: 'user-1', label: USER_RULE.label, summary: 'psql prod-db-17.internal.example' }] });
  // the callback leaks extra fields on purpose: the server must drop them
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => ({ at: 1, sessions: [] }), { safety: () => ({ ...summary, rules: RULES, label: USER_RULE.label }) });
  const host = await listen(server);
  try {
    const s = signRequest('t0k', 'GET', host, '/v1/sessions');
    const r = await fetch(`http://${host}/v1/sessions`, { headers: s.headers });
    const raw = await r.text();
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(raw).safety, summary);
    for (const rule of RULES) {
      if (rule.pattern) assert.ok(!raw.includes(rule.pattern) && !raw.includes(JSON.stringify(rule.pattern).slice(1, -1)), `pattern of ${rule.id} not in the answer`);
      assert.ok(!raw.includes(rule.label), `label of ${rule.id} not in the answer`);
    }
    assert.ok(!raw.includes('prod-db-17'));
    const f = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(f.ok, true); assert.deepEqual(f.safety, summary);
  } finally { server.close(); }
});

test('server: a safety change gives a new ETag and beats ?since=; a throwing callback just leaves the field out', async () => {
  let sf = { guard: 'warn', perm: true, rulesHash: 'abcdef012345', blocksToday: 0 };
  let clock = 1000;
  const snap = { at: 500, sessions: [{ id: 'a', name: 'x', status: 'running' }] };
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => snap, { safety: () => sf, now: () => clock });
  const host = await listen(server);
  try {
    const first = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(first.safety.blocksToday, 0);
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag, since: first.theirAt })).notModified, true, 'unchanged → 304');
    sf = { ...sf, blocksToday: 1 }; clock = 2000;
    const changed = await fetchPeer({ name: 'p', host }, 't0k', { etag: first.etag, since: first.theirAt });
    assert.equal(changed.notModified, undefined); assert.equal(changed.safety.blocksToday, 1); assert.notEqual(changed.etag, first.etag);
    assert.ok(changed.theirAt >= 2000, '`at` moves with the safety change');
    // ?since= alone (no ETag) also sees the change
    sf = { ...sf, guard: 'off' }; clock = 3000;
    const s = signRequest('t0k', 'GET', host, `/v1/sessions?since=${changed.theirAt}`);
    const bySince = await fetch(`http://${host}/v1/sessions?since=${changed.theirAt}`, { headers: s.headers });
    assert.equal(bySince.status, 200); assert.equal((await bySince.json()).safety.guard, 'off');
    sf = null; clock = 4000;   // not an object → left out (after the 1 s reuse window)
    const s2 = signRequest('t0k', 'GET', host, '/v1/sessions');
    const r2 = await fetch(`http://${host}/v1/sessions`, { headers: s2.headers });
    assert.equal((await r2.json()).safety, undefined);
  } finally { server.close(); }
  const throwing = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => snap, { safety: () => { throw new Error('boom'); } });
  const h2 = await listen(throwing);
  try {
    const f = await fetchPeer({ name: 'p', host: h2 }, 't0k');
    assert.equal(f.ok, true); assert.equal(f.safety, undefined); assert.equal(f.sessions.length, 1);
  } finally { throwing.close(); }
});

test('server: two registered teammates at the caller address (ambiguous) → no safety', async () => {
  const cfg = { name: 'neo', token: 't0k', instanceId: ID.a, peers: [{ name: 'will', host: '127.0.0.1:7441' }, { name: 'bob', host: '127.0.0.1:7442' }] };
  const server = startTeamServer(cfg, () => ({ at: 1, sessions: [] }), { safety: () => ({ guard: 'block', perm: true, rulesHash: 'abcdef012345', blocksToday: 3 }) });
  const host = await listen(server);
  try {
    const f = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(f.ok, true); assert.equal(f.safety, undefined);
    cfg.peers = [{ name: 'will', host: '127.0.0.1:7441' }];   // one teammate there → served again
    const g = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(g.safety.blocksToday, 3);
  } finally { server.close(); }
});

test('fetchPeer: an older peer (no safety field) → peer.safety undefined; garbage → sanitized or undefined', async () => {
  const bodies = [
    JSON.stringify({ name: 'old', at: 1, instanceId: ID.a, sessions: [] }),
    JSON.stringify({ name: 'odd', at: 1, instanceId: ID.a, sessions: [], safety: 'yes' }),
    JSON.stringify({ name: 'bad', at: 1, instanceId: ID.a, sessions: [], safety: { guard: 'x', perm: 1, rulesHash: '<script>', blocksToday: -1, pattern: 'leak' } }),
  ];
  let i = 0;
  const fake = createServer((req, res) => {
    const body = bodies[i++];
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-AD-Sig': responseSignature('t0k', 200, req.headers.host, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], body) });
    res.end(body);
  });
  const host = await listen(fake);
  try {
    const old = await fetchPeer({ name: 'p', host }, 't0k');
    assert.equal(old.ok, true); assert.equal(old.safety, undefined); assert.ok(!('safety' in old) || old.safety === undefined);
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).safety, undefined);
    assert.deepEqual((await fetchPeer({ name: 'p', host }, 't0k')).safety, { guard: 'unknown', perm: false, rulesHash: '', blocksToday: 0 });
  } finally { fake.close(); }
});

test('server: a re-created server (bind change) delivers its first safety even to a client with a newer ?since=', async () => {
  let clock = 5000;
  const snap = { at: 500, sessions: [] };
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => snap, { safety: () => ({ guard: 'warn', perm: true, rulesHash: 'abcdef012345', blocksToday: 0 }), now: () => clock });
  const host = await listen(server);
  try {
    // the client last saw at=4000 from the old server; the new one has the same sessions (at 500)
    const s = signRequest('t0k', 'GET', host, '/v1/sessions?since=4000');
    const r = await fetch(`http://${host}/v1/sessions?since=4000`, { headers: s.headers });
    assert.equal(r.status, 200); const d = await r.json();
    assert.equal(d.safety.guard, 'warn'); assert.equal(d.at, 5000);
  } finally { server.close(); }
});

test('server: the safety callback is reused for 1 s', async () => {
  let clock = 10000, calls = 0;
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.a }, () => ({ at: 1, sessions: [] }), { safety: () => { calls++; return { guard: 'block', perm: true, rulesHash: '', blocksToday: calls }; }, now: () => clock });
  const host = await listen(server);
  try {
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).safety.blocksToday, 1);
    clock += 999;
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).safety.blocksToday, 1);
    assert.equal(calls, 1);
    clock += 1;
    assert.equal((await fetchPeer({ name: 'p', host }, 't0k')).safety.blocksToday, 2);
    assert.equal(calls, 2);
  } finally { server.close(); }
});
