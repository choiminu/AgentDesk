// Tests for the session-alert decisions (core/notify.js): baseline, one alert per transition, reminders, delegation.
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/notify.js');
const N = globalThis.AgentDeskNotify;

const MIN = 60000;
const sess = (id, status, extra = {}) => ({ id, name: `s-${id}`, status, ...extra });
const peer = (name, sessions, delegated, ok = true) => ({ name, ok, sessions, delegatedToMe: delegated.map(sessionId => ({ sessionId })) });
const opts = { remindMs: 15 * MIN, stuckMs: 30 * MIN, maxPerHour: 2 };

test('stateOf maps status, needsInput, ended and the stuck threshold', () => {
  assert.equal(N.stateOf(sess('a', 'running')), 'running');
  assert.equal(N.stateOf(sess('a', 'waiting')), 'input');
  assert.equal(N.stateOf(sess('a', 'waiting', { ended: true })), 'idle');
  assert.equal(N.stateOf(sess('a', 'waiting', { needsInput: true })), 'ask');
  assert.equal(N.stateOf(sess('a', 'running', { needsInput: true })), 'ask');
  assert.equal(N.stateOf(sess('a', 'done', { needsInput: true })), 'done');
  assert.equal(N.stateOf(sess('a', 'error')), 'error');
  assert.equal(N.stateOf(sess('a', 'running', { stuck: true })), 'stuck');
  // my own threshold wins over the teammate's flag when stuckSince is known
  assert.equal(N.stateOf(sess('a', 'running', { stuck: true, stuckSince: 1000 }), { now: 1000 + 20 * MIN, stuckMs: 30 * MIN }), 'running');
  assert.equal(N.stateOf(sess('a', 'running', { stuckSince: 1000 }), { now: 1000 + 31 * MIN, stuckMs: 30 * MIN }), 'stuck');
});

test('observe: first sight is a silent baseline, a transition alerts once, holding the state alerts no more', () => {
  const tr = N.createTracker();
  assert.equal(N.observe(tr, 'k', 'input', 0, opts), null);         // already waiting when first seen
  assert.equal(N.observe(tr, 'k', 'running', 1000, opts), null);
  assert.deepEqual(N.observe(tr, 'k', 'input', 2000, opts), { kind: 'input', repeat: false });
  for (let t = 3000; t < 2000 + 15 * MIN; t += 3000) assert.equal(N.observe(tr, 'k', 'input', t, opts), null);
});

test('observe: which transitions alert', () => {
  const run = (from, to) => { const tr = N.createTracker(); N.observe(tr, 'k', from, 0, opts); return N.observe(tr, 'k', to, 1, opts); };
  assert.deepEqual(run('running', 'input'), { kind: 'input', repeat: false });
  assert.deepEqual(run('running', 'ask'), { kind: 'ask', repeat: false });
  assert.deepEqual(run('input', 'ask'), { kind: 'ask', repeat: false });
  assert.deepEqual(run('running', 'done'), { kind: 'done', repeat: false });
  assert.deepEqual(run('input', 'error'), { kind: 'error', repeat: false });
  assert.deepEqual(run('running', 'stuck'), { kind: 'stuck', repeat: false });
  assert.equal(run('ask', 'input'), null);      // the question was answered with "no" → no extra ping
  assert.equal(run('idle', 'done'), null);
  assert.equal(run('done', 'done'), null);
  assert.equal(run('input', 'running'), null);
});

test('observe: reminders every remindMs, at most maxPerHour an hour, off at 0', () => {
  const tr = N.createTracker();
  N.observe(tr, 'k', 'running', 0, opts);
  N.observe(tr, 'k', 'ask', 0, opts);                                // transition alert at t=0
  const fired = [];
  for (let t = 3000; t <= 120 * MIN; t += 3000) { const ev = N.observe(tr, 'k', 'ask', t, opts); if (ev) { assert.equal(ev.repeat, true); fired.push(t / MIN); } }
  // +15, +30, then the hourly cap holds until the +15 one is an hour old (+75), then +90
  assert.deepEqual(fired, [15, 30, 75, 90]);
  const off = N.createTracker();
  N.observe(off, 'k', 'stuck', 0, { remindMs: 0 });
  for (let t = 0; t <= 120 * MIN; t += MIN) assert.equal(N.observe(off, 'k', 'stuck', t, { remindMs: 0 }), null);
});

test('observe: running, idle and a plain wait for input never remind; a state change restarts the reminder clock', () => {
  const tr = N.createTracker();
  N.observe(tr, 'k', 'running', 0, opts);
  assert.equal(N.observe(tr, 'k', 'running', 60 * MIN, opts), null);
  assert.deepEqual(N.observe(tr, 'k', 'input', 60 * MIN, opts), { kind: 'input', repeat: false });
  for (let t = 61 * MIN; t <= 240 * MIN; t += MIN) assert.equal(N.observe(tr, 'k', 'input', t, opts), null);
  N.observe(tr, 'k', 'ask', 240 * MIN, opts);
  assert.equal(N.observe(tr, 'k', 'ask', 254 * MIN, opts), null);
  assert.deepEqual(N.observe(tr, 'k', 'ask', 255 * MIN, opts), { kind: 'ask', repeat: true });
});

test('peerAlerts: only sessions delegated to me, first snapshot is a baseline, then one alert per transition', () => {
  const tr = N.createTracker();
  const snap = (aStatus, bStatus) => ({ will: peer('will', [sess('a', aStatus), sess('b', bStatus)], ['a']) });
  assert.deepEqual(N.peerAlerts(tr, snap('waiting', 'running'), 0, opts), []);        // baseline
  assert.deepEqual(N.peerAlerts(tr, snap('running', 'running'), 3000, opts), []);
  assert.deepEqual(N.peerAlerts(tr, snap('waiting', 'waiting'), 6000, opts), [{ owner: 'will', id: 'a', name: 's-a', kind: 'input', repeat: false }]);   // b is not mine
  assert.deepEqual(N.peerAlerts(tr, snap('waiting', 'waiting'), 9000, opts), []);
  assert.deepEqual(N.peerAlerts(tr, snap('done', 'done'), 12000, opts), [{ owner: 'will', id: 'a', name: 's-a', kind: 'done', repeat: false }]);
});

test('peerAlerts: the moment a delegation ends is silent, and a new delegation starts from a baseline', () => {
  const tr = N.createTracker();
  N.peerAlerts(tr, [peer('will', [sess('a', 'running')], ['a'])], 0, opts);
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'waiting')], [])], 3000, opts), []);   // revoked + transition together
  assert.equal(tr.entries.size, 0);
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'waiting', { needsInput: true })], ['a'])], 6000, opts), []);   // delegated again: baseline
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'error')], ['a'])], 9000, opts), [{ owner: 'will', id: 'a', name: 's-a', kind: 'error', repeat: false }]);
});

test('peerAlerts: a disconnected teammate is skipped and the first snapshot after reconnecting is a baseline', () => {
  const tr = N.createTracker();
  N.peerAlerts(tr, [peer('will', [sess('a', 'running')], ['a'])], 0, opts);
  // the stale snapshot a failing teammate keeps for a minute must not alert
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'waiting')], ['a'], false)], 3000, opts), []);
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'done')], ['a'])], 6000, opts), []);    // reconnect: baseline
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'running')], ['a'])], 9000, opts), []);
  assert.deepEqual(N.peerAlerts(tr, [peer('will', [sess('a', 'running', { needsInput: true })], ['a'])], 12000, opts), [{ owner: 'will', id: 'a', name: 's-a', kind: 'ask', repeat: false }]);
});

test('peerAlerts: delegated sessions get stuck alerts by my threshold and reminders with the hourly cap', () => {
  const tr = N.createTracker();
  const s = since => [peer('will', [sess('a', 'running', { stuckSince: since })], ['a'])];
  N.peerAlerts(tr, s(1), 0, opts);
  assert.deepEqual(N.peerAlerts(tr, s(1), 29 * MIN, opts), []);
  assert.deepEqual(N.peerAlerts(tr, s(1), 31 * MIN, opts).map(e => [e.kind, e.repeat]), [['stuck', false]]);
  const kinds = [];
  for (let t = 32 * MIN; t <= 91 * MIN; t += MIN) for (const e of N.peerAlerts(tr, s(1), t, opts)) kinds.push([t / MIN, e.kind, e.repeat]);
  assert.deepEqual(kinds, [[46, 'stuck', true], [61, 'stuck', true]]);
});

test('observe: transition alerts are capped per key per hour (sliding)', () => {
  const tr = N.createTracker();
  N.observe(tr, 'k', 'running', 0, opts);
  const at = [];
  for (let t = 1; t <= 120 * MIN; t += 30000) { const ev = N.observe(tr, 'k', (t / 30000) % 2 < 1 ? 'ask' : 'running', t, opts); if (ev) at.push(ev.kind); }
  assert.equal(at.length, 12);   // 6 in each hour
  assert.ok(at.every(k => k === 'ask'));
});

test('peerAlerts: at most 3 alerts per teammate per tick, the rest folded into one "more" summary', () => {
  const tr = N.createTracker();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  N.peerAlerts(tr, [peer('will', ids.map(id => sess(id, 'running')), ids)], 0, opts);
  const evs = N.peerAlerts(tr, [peer('will', ids.map(id => sess(id, 'running', { needsInput: true })), ids)], 3000, opts);
  assert.deepEqual(evs.map(e => e.kind), ['ask', 'ask', 'more']);
  assert.equal(evs[2].count, 3); assert.equal(evs[2].owner, 'will');
});

test('peerAlerts: 50 delegated sessions flipping needsInput every poll for an hour stay within the caps', () => {
  const tr = N.createTracker();
  const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);
  let items = 0, sessionAlerts = 0, desktop = 0, maxTick = 0;
  for (let t = 0, n = 0; t < 60 * MIN; t += 3000, n++) {
    const evs = N.peerAlerts(tr, [peer('mallory', ids.map(id => sess(id, 'running', { needsInput: n % 2 === 1 })), ids)], t, opts);
    items += evs.length; maxTick = Math.max(maxTick, evs.length);
    sessionAlerts += evs.reduce((k, e) => k + (e.kind === 'more' ? e.count : 1), 0);
    if (evs.length && N.cooldownOk(tr, 'mallory', t, MIN)) desktop++;
  }
  assert.ok(maxTick <= 3, `per tick ${maxTick}`);
  assert.ok(sessionAlerts <= 50 * 6, `alerts ${sessionAlerts}`);   // per-key hourly cap
  assert.ok(items <= 1200 * 3, `items ${items}`);
  assert.ok(desktop <= 60, `desktop ${desktop}`);                  // one per teammate per minute
});

test('cleanText strips bidi controls; peerAlerts cleans owner and session names', () => {
  assert.equal(N.cleanText('ab‮cd⁦e⁩f‪'), 'abcdef');
  assert.equal(N.cleanText(null), '');
  const tr = N.createTracker();
  N.peerAlerts(tr, [peer('wi‮ll', [sess('a', 'running', { name: 'x⁧y' })], ['a'])], 0, opts);
  const [ev] = N.peerAlerts(tr, [peer('wi‮ll', [sess('a', 'error', { name: 'x⁧y' })], ['a'])], 3000, opts);
  assert.equal(ev.owner, 'will'); assert.equal(ev.name, 'xy');
});

test('peerAlerts: a per-teammate hourly cap survives new session ids and re-delegation', () => {
  const tr = N.createTracker();
  const kinds = [];
  // worst case: fresh ids every 2 polls (one baseline poll, then a transition), 50 sessions, for an hour
  for (let t = 0, n = 0; t < 60 * MIN; t += 3000, n++) {
    const gen = Math.floor(n / 2), ids = Array.from({ length: 50 }, (_, i) => `g${gen}-${i}`);
    for (const e of N.peerAlerts(tr, [peer('mallory', ids.map(id => sess(id, 'running', { needsInput: n % 2 === 1 })), ids)], t, opts)) kinds.push(e.kind);
  }
  assert.ok(kinds.length <= 31, `items ${kinds.length}`);
  assert.equal(kinds.filter(k => k === 'capped').length, 1);
  // ids changing on every poll never alert at all (each is a first sight)
  const tr2 = N.createTracker(); let n2 = 0;
  for (let t = 0, n = 0; t < 10 * MIN; t += 3000, n++) n2 += N.peerAlerts(tr2, [peer('m', [sess(`x${n}`, 'running', { needsInput: n % 2 === 1 })], [`x${n}`])], t, opts).length;
  assert.equal(n2, 0);
  // the history goes only when the teammate leaves the list
  N.peerAlerts(tr, [], 60 * MIN);
  assert.equal(tr.peerHist.size, 0);
});
