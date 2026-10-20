// Regression tests for the limit forecast and per-ticket cost roll-up (core/usage.js).
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/usage.js');
const U = globalThis.AgentDeskUsage;

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60000;
// n samples one minute apart ending at NOW, used = f(i)
const series = (n, f) => Array.from({ length: n }, (_, i) => ({ at: NOW - (n - 1 - i) * MIN, used: f(i) }));

test('forecast: steady rise → rate, eta and high confidence', () => {
  const r = U.forecast(series(21, i => 40 + i * 0.5), 100, NOW);   // 0.5 %/min = 30 %/h, at 50 now
  assert.equal(r.ratePerHour, 30);
  assert.equal(r.used, 50);
  assert.equal(r.etaMs, 100 * MIN);   // 50 points left at 30/h
  assert.equal(r.confidence, 'high');
  assert.equal(r.reason, null);
});

test('forecast: flat or falling usage → no eta', () => {
  const flat = U.forecast(series(15, () => 42), 100, NOW);
  assert.equal(flat.etaMs, null); assert.equal(flat.reason, 'flat'); assert.equal(flat.ratePerHour, 0);
  const down = U.forecast(series(15, i => 60 - i * 0.1), 100, NOW);
  assert.equal(down.etaMs, null); assert.equal(down.reason, 'flat'); assert.ok(down.ratePerHour < 0);
});

test('forecast: window resets before the limit → not reached before reset', () => {
  const r = U.forecast(series(21, i => 40 + i * 0.5), 100, NOW, NOW + 30 * MIN);
  assert.equal(r.etaMs, null); assert.equal(r.reason, 'after-reset'); assert.equal(r.resetAt, NOW + 30 * MIN);
  const ok = U.forecast(series(21, i => 40 + i * 0.5), 100, NOW, NOW + 3 * 60 * MIN);
  assert.equal(ok.etaMs, 100 * MIN);
});

test('forecast: fewer than two samples, or only old ones → no eta', () => {
  assert.equal(U.forecast([], 100, NOW).reason, 'few-samples');
  assert.equal(U.forecast([{ at: NOW, used: 30 }], 100, NOW).etaMs, null);
  assert.equal(U.forecast(series(5, i => 10 + i).map(s => ({ ...s, at: s.at - 60 * MIN })), 100, NOW).reason, 'few-samples');
  assert.equal(U.forecast(null, 100, NOW).etaMs, null);
});

test('forecast: noisy integer readings → lower confidence but a sane rate', () => {
  const noise = [0, 2, -1, 1, -2, 0, 2, -1];
  const r = U.forecast(series(8, i => 30 + Math.round(i * 0.2) + noise[i]), 100, NOW);
  assert.notEqual(r.confidence, 'high');
  const few = U.forecast(series(3, i => 30 + i), 100, NOW);
  assert.equal(few.confidence, 'low');
});

test('forecast: samples before a reset drop are ignored; at/over the limit → eta 0', () => {
  const s = [...series(10, i => 80 + i).slice(0, 5), ...series(5, i => 2 + i)];
  const r = U.forecast(s, 100, NOW);
  assert.equal(r.used, 6); assert.equal(r.samples, 5);
  assert.equal(U.forecast(series(5, i => 96 + i), 100, NOW).etaMs, 0);
});

test('thresholdCrossed: only upward crossings fire', () => {
  assert.deepEqual(U.thresholdCrossed(79, 81, [80, 95], []).crossed, [80]);
  assert.deepEqual(U.thresholdCrossed(70, 96, [80, 95], []).crossed, [80, 95]);
  assert.deepEqual(U.thresholdCrossed(96, 90, [80, 95], [80, 95]).crossed, []);
  assert.deepEqual(U.thresholdCrossed(50, 60, [80, 95], []).crossed, []);
  // first reading (no previous value): nothing announced, but the level is armed as fired
  const first = U.thresholdCrossed(null, 85, [80, 95], []);
  assert.deepEqual(first.crossed, []); assert.deepEqual(first.fired, [80]);
});

test('thresholdCrossed: no repeat alert for the same level while it jitters', () => {
  let st = U.thresholdCrossed(79, 80, [80, 95], []);
  assert.deepEqual(st.crossed, [80]);
  st = U.thresholdCrossed(80, 79, [80, 95], st.fired);
  st = U.thresholdCrossed(79, 80, [80, 95], st.fired);
  assert.deepEqual(st.crossed, []); assert.deepEqual(st.fired, [80]);
});

test('thresholdCrossed: re-arms after a reset', () => {
  let st = U.thresholdCrossed(79, 81, [80, 95], []);
  st = U.thresholdCrossed(81, 3, [80, 95], st.fired);   // window reset: usage fell far below
  assert.deepEqual(st.fired, []);
  st = U.thresholdCrossed(79, 82, [80, 95], st.fired);
  assert.deepEqual(st.crossed, [80]);
  const forced = U.thresholdCrossed(79, 81, [80, 95], [80], { reset: true });
  assert.deepEqual(forced.crossed, [80]);
});

test('ticketCosts: sums per ticket, counts sessions without cost as unknown', () => {
  const sessions = [
    { id: 'a', cost: 1.25, projectWorktree: '/w/ep-1', timeUpdated: NOW },
    { id: 'b', cost: 0.5, cwd: '/w/ep-1/', timeUpdated: NOW - MIN },
    { id: 'c', cost: 0, projectWorktree: '/w/ep-1', timeUpdated: NOW },
    { id: 'd', cost: 9, projectWorktree: '/w/ep-1', timeUpdated: NOW - 3 * 60 * MIN },   // before the dispatch
    { id: 'e', cost: 2, projectWorktree: '/w/other', timeUpdated: NOW },
    { id: 'f', cost: 0.3, projectWorktree: '/w/ep-2', timeUpdated: NOW },
  ];
  const r = U.ticketCosts(sessions, { 'EP-1': { path: '/w/ep-1', sentAt: NOW - 60 * MIN }, 'EP-2': { cwd: '/w/ep-2', since: NOW - MIN }, 'EP-3': { path: '', sentAt: NOW } });
  assert.equal(r['EP-1'].cost, 1.75);
  assert.deepEqual(r['EP-1'].sessions, ['a', 'b']);
  assert.equal(r['EP-1'].unknown, 1);
  assert.equal(r['EP-1'].since, NOW - 60 * MIN);
  assert.equal(r['EP-2'].cost, 0.3);
  assert.equal(r['EP-3'], undefined);
});

test('ticketCosts: two tickets on one session directory → the later dispatch takes newer sessions', () => {
  const sessions = [
    { id: 'old', cost: 1, projectWorktree: '/w/s', timeUpdated: NOW - 50 * MIN },
    { id: 'new', cost: 2, projectWorktree: '/w/s', timeUpdated: NOW },
  ];
  const r = U.ticketCosts(sessions, { 'EP-1': { cwd: '/w/s', since: NOW - 60 * MIN }, 'EP-2': { cwd: '/w/s', since: NOW - 10 * MIN } });
  assert.deepEqual(r['EP-1'], { cost: 1, sessions: ['old'], since: NOW - 60 * MIN, unknown: 0 });
  assert.deepEqual(r['EP-2'].sessions, ['new']);
  assert.deepEqual(U.ticketCosts(null, null), {});
});

test('formatEta: boundaries', () => {
  assert.equal(U.formatEta(null), '리셋 전 도달 안 함');
  assert.equal(U.formatEta(Infinity), '리셋 전 도달 안 함');
  assert.equal(U.formatEta(0), '한도 도달');
  assert.equal(U.formatEta(10 * 1000), '1분 뒤');
  assert.equal(U.formatEta(20 * MIN), '20분 뒤');
  assert.equal(U.formatEta(59 * MIN), '59분 뒤');
  assert.equal(U.formatEta(59.6 * MIN), '약 1시간 뒤');
  assert.equal(U.formatEta(60 * MIN), '약 1시간 뒤');
  assert.equal(U.formatEta(100 * MIN), '약 1시간 40분 뒤');
  assert.equal(U.formatEta(26 * 60 * MIN), '약 1일 2시간 뒤');
  assert.equal(U.formatEta(100 * MIN, 'en'), 'in about 1h 40m');
  assert.equal(U.formatEta(null, 'en'), 'not reached before reset');
});
