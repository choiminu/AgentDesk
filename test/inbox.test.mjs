// Regression tests for the review queue (core/inbox.js): which pending items each kind includes, the order, the
// length limits on outside text, empty input and the per-kind settings toggle.
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/inbox.js');
const I = globalThis.AgentDeskInbox;

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MIN = 60000;
const build = (input, opts) => I.buildInbox({ now: NOW, lang: 'en', ...input }, opts);
const kinds = items => items.map(x => x.kind);
const team = extra => ({ configured: true, error: '', peers: {}, pending: [], ...extra });

test('empty / missing input → empty list, never throws', () => {
  assert.deepEqual(I.buildInbox(), []);
  assert.deepEqual(I.buildInbox(null), []);
  assert.deepEqual(build({}), []);
  assert.deepEqual(build({ jiraDispatch: null, sessions: 'x', peerNotes: {}, permRequests: 3, teamStatus: null, usage: 'no' }), []);
});

test('jira-report: only dispatches in state report', () => {
  const items = build({ jiraDispatch: {
    'EP-1': { key: 'EP-1', summary: 'fix it', state: 'report', sentAt: NOW - 50 * MIN, reportAt: NOW - 5 * MIN },
    'EP-2': { key: 'EP-2', state: 'sent', sentAt: NOW },
    'EP-3': { key: 'EP-3', state: 'posted', sentAt: NOW },
    'EP-4': { key: 'EP-4', state: 'discarded', sentAt: NOW },
  } });
  assert.deepEqual(kinds(items), ['jira-report']);
  assert.equal(items[0].id, 'EP-1');
  assert.equal(items[0].at, NOW - 5 * MIN);
  assert.equal(items[0].severity, 'normal');
  assert.deepEqual(items[0].target, { page: 'jira', ticket: 'EP-1' });
  assert.match(items[0].title, /^EP-1 fix it$/);
});

test('diff and stuck: from session flags', () => {
  const items = build({ sessions: [
    { id: 'a', name: 'alpha', status: 'waiting', diffUnseen: true, reportAt: NOW - MIN },
    { id: 'b', name: 'beta', status: 'running', stuck: true, stuckSince: NOW - 40 * MIN },
    { id: 'c', name: 'gamma', status: 'waiting', stuck: true },            // stuck only counts while running
    { id: 'd', name: 'delta', status: 'running', diffUnseen: false },
  ] });
  assert.deepEqual(kinds(items), ['stuck', 'diff']);
  assert.equal(items[0].id, 'b'); assert.equal(items[0].severity, 'normal'); assert.deepEqual(items[0].target, { page: 'dashboard', sessionId: 'b' });
  assert.equal(items[1].id, 'a'); assert.equal(items[1].severity, 'low');
});

test('note: only state new', () => {
  const items = build({ peerNotes: [
    { id: 'n1', from: 'kim', to: 'p1', toName: 'api', text: 'look at this', at: NOW - MIN, state: 'new' },
    { id: 'n2', from: 'lee', to: 'p2', text: 'x', at: NOW, state: 'sent' },
    { id: 'n3', from: 'lee', to: 'p2', text: 'y', at: NOW, state: 'ignored' },
  ] });
  assert.deepEqual(kinds(items), ['note']);
  assert.equal(items[0].title, '@kim → api');
  assert.equal(items[0].detail, 'look at this');
  assert.deepEqual(items[0].target, { page: 'team', peer: 'kim' });
});

test('perm vs perm-orphan; expired requests left out; both high', () => {
  const items = build({ permRequests: [
    { id: 'r1', sessionId: 's1', localId: 'wt1', name: 'api', createdAt: NOW - 2 * MIN, expiresAt: NOW + MIN, summary: { tool: 'Bash', kind: 'bash', command: 'rm -rf build' } },
    { id: 'r2', sessionId: 's9', name: 'gone', orphan: true, createdAt: NOW - MIN, expiresAt: NOW + MIN, summary: { tool: 'Edit', kind: 'edit', filePath: 'a.js' } },
    { id: 'r3', sessionId: 's1', createdAt: NOW - 5 * MIN, expiresAt: NOW - 1, summary: { tool: 'Bash' } },
    { sessionId: 'no-id' },
  ] });
  assert.deepEqual(kinds(items), ['perm', 'perm-orphan']);
  assert.equal(items[0].severity, 'high'); assert.equal(items[1].severity, 'high');
  assert.equal(items[0].detail, 'rm -rf build');
  assert.deepEqual(items[0].target, { page: 'dashboard', sessionId: 'wt1', permId: 'r1' });
  assert.equal(items[1].target.sessionId, '');
  assert.match(items[1].detail, /no longer on the dashboard · a\.js$/);
});

test('hello: pending requests only while team sharing works', () => {
  const pending = [
    { key: '10.0.0.5:7777|i1', kind: 'new', name: 'park', host: '10.0.0.5:7777', at: NOW - 3 * MIN },
    { key: '10.0.0.6:7777|i2', kind: 'move', existing: 'choi', from: '10.0.0.2:7777', host: '10.0.0.6:7777', at: NOW - MIN },
  ];
  const items = build({ teamStatus: team({ pending }) });
  assert.deepEqual(kinds(items), ['hello', 'hello']);
  assert.equal(items[0].title, 'park (10.0.0.5)');
  assert.equal(items[1].title, '@choi');
  assert.match(items[1].detail, /10\.0\.0\.2:7777 → 10\.0\.0\.6:7777/);
  assert.deepEqual(build({ teamStatus: team({ pending, configured: false }) }), []);
  assert.deepEqual(build({ teamStatus: team({ pending, error: 'bad json' }) }), []);
});

test('peer-ask: delegated-to-me sessions only, connected teammates only; ask high, input normal', () => {
  const peers = {
    kim: { name: 'kim', ok: true, delegatedToMe: [{ sessionId: 'k1' }, { sessionId: 'k2' }, { sessionId: 'k3' }, { sessionId: 'k4' }], sessions: [
      { id: 'k1', name: 'api', status: 'waiting', needsInput: true, askSince: NOW - 2 * MIN },
      { id: 'k2', name: 'web', status: 'waiting', time: NOW - MIN },
      { id: 'k3', name: 'done', status: 'done', needsInput: true },
      { id: 'k4', name: 'ended', status: 'waiting', ended: true },
      { id: 'k5', name: 'not mine', status: 'waiting', needsInput: true },
    ] },
    lee: { name: 'lee', ok: false, delegatedToMe: [{ sessionId: 'l1' }], sessions: [{ id: 'l1', status: 'waiting', needsInput: true }] },
  };
  const items = build({ teamStatus: team({ peers }) });
  assert.deepEqual(items.map(x => [x.kind, x.id, x.severity]), [['peer-ask', 'kim/k1', 'high'], ['peer-ask', 'kim/k2', 'normal']]);
  assert.deepEqual(items[0].target, { page: 'team', peer: 'kim', sessionId: 'k1' });
});

test('usage: first level normal, second level high, a near forecast counts too', () => {
  const at = NOW - MIN;
  assert.deepEqual(build({ usage: { levels: [80, 95], at, s: { pct: 79 }, w: { pct: 10, etaMs: 2 * 3600000 } } }), []);
  const items = build({ usage: { levels: [80, 95], at, s: { pct: 96 }, w: { pct: 81 } } });
  assert.deepEqual(items.map(x => [x.id, x.severity]), [['s', 'high'], ['w', 'normal']]);
  assert.equal(items[0].title, '5-hour limit 96%');
  const soon = build({ usage: { at, s: { pct: 50, etaMs: 20 * MIN } } });
  assert.deepEqual(soon.map(x => [x.id, x.severity]), [['s', 'normal']]);
  assert.match(soon[0].detail, /20 min/);
});

test('order: severity first, then oldest first', () => {
  const items = build({
    sessions: [{ id: 'a', name: 'a', status: 'waiting', diffUnseen: true, reportAt: NOW - 90 * MIN }],
    peerNotes: [{ id: 'n1', from: 'k', to: 'x', text: 't', at: NOW - MIN, state: 'new' }, { id: 'n0', from: 'k', to: 'x', text: 't', at: NOW - 10 * MIN, state: 'new' }],
    permRequests: [{ id: 'r1', createdAt: NOW, expiresAt: NOW + MIN, summary: {} }],
    jiraDispatch: { 'EP-9': { key: 'EP-9', state: 'report', reportAt: NOW - 5 * MIN } },
  });
  assert.deepEqual(items.map(x => x.kind + ':' + x.id), ['perm:r1', 'note:n0', 'jira-report:EP-9', 'note:n1', 'diff:a']);
});

test('outside text is length-limited and stripped of bidi / control characters', () => {
  const long = 'x'.repeat(500);
  const items = build({
    peerNotes: [{ id: 'n1', from: 'evil\u202Eeman' + long, to: 'p', toName: long, text: long + '\u0007', at: NOW, state: 'new' }],
    sessions: [{ id: 's1', name: long, status: 'running', stuck: true }],
  });
  for (const it of items) {
    assert.ok([...it.title].length <= I.LIMIT.title, `title ${it.title.length}`);
    assert.ok([...it.detail].length <= I.LIMIT.detail, `detail ${it.detail.length}`);
    assert.doesNotMatch(it.title + it.detail, /[\u202A-\u202E\u2066-\u2069\u0000-\u001F]/);
  }
  const note = items.find(x => x.kind === 'note');
  assert.ok(note.title.startsWith('@evileman'));   // shown name cleaned; target.peer stays exact (lookup key)
  assert.ok(note.title.includes('…'));
});

test('at most MAX_ITEMS items', () => {
  const notes = Array.from({ length: 150 }, (_, i) => ({ id: 'n' + i, from: 'k', to: 'x', text: 't', at: NOW - i, state: 'new' }));
  assert.equal(build({ peerNotes: notes }).length, I.MAX_ITEMS);
});

test('settings toggle: a kind set to false is left out', () => {
  const input = {
    peerNotes: [{ id: 'n1', from: 'k', to: 'x', text: 't', at: NOW, state: 'new' }],
    jiraDispatch: { 'EP-1': { key: 'EP-1', state: 'report', reportAt: NOW } },
  };
  assert.deepEqual(kinds(build(input, { kinds: { note: false } })), ['jira-report']);
  assert.deepEqual(kinds(build(input, { kinds: { note: true, 'jira-report': false } })), ['note']);
  assert.equal(build(input, { kinds: {} }).length, 2);
});

test('normalizePrefs keeps only known kinds set to false', () => {
  assert.deepEqual(I.normalizePrefs(null), { kinds: {} });
  assert.deepEqual(I.normalizePrefs({ kinds: { note: false, diff: true, bogus: false, stuck: 0 } }), { kinds: { note: false } });
});

test('Korean labels when lang is ko', () => {
  const items = I.buildInbox({ now: NOW, lang: 'ko', usage: { s: { pct: 85 } } });
  assert.equal(items[0].title, '5시간 한도 85%');
});

test('ids and targets stay exact (lookup keys); only title / detail are cut', () => {
  const longId = 'r'.repeat(300), peer = 'p'.repeat(60);
  const items = build({
    permRequests: [{ id: longId, localId: 'wt-' + 'x'.repeat(250), createdAt: NOW, expiresAt: NOW + MIN, summary: {} }],
    peerNotes: [{ id: 'n-' + 'y'.repeat(250), from: peer, to: 'p', text: 't', at: NOW, state: 'new' }],
  });
  const perm = items.find(x => x.kind === 'perm'), note = items.find(x => x.kind === 'note');
  assert.equal(perm.id, longId); assert.equal(perm.target.permId, longId); assert.equal(perm.target.sessionId.length, 253);
  assert.equal(note.id.length, 252); assert.equal(note.target.peer, peer);
  assert.ok([...note.title].length <= I.LIMIT.title);
});

test('removed characters: C1 controls, LRM / RLM, ALM, isolates, BOM', () => {
  const dirty = 'a\u0085b\u009Fc‎d‏e؜f⁦g⁩h﻿i‪j';
  const [it] = build({ peerNotes: [{ id: 'n', from: 'k', to: 'x', text: dirty, at: NOW, state: 'new' }] });
  assert.equal(it.detail, 'abcdefghij');
});

test('usage: a low-confidence forecast alone does not count as running out soon', () => {
  assert.deepEqual(build({ usage: { s: { pct: 50, etaMs: 10 * MIN, confidence: 'low' } } }), []);
  assert.equal(build({ usage: { s: { pct: 50, etaMs: 10 * MIN, confidence: 'medium' } } }).length, 1);
  assert.equal(build({ usage: { s: { pct: 85, etaMs: 10 * MIN, confidence: 'low' } } }).length, 1);   // the level still counts
});

test('an item with no time sorts as "now", not ahead of real old items', () => {
  const items = build({
    sessions: [{ id: 'nt', name: 'no time', status: 'running', stuck: true }],
    peerNotes: [{ id: 'old', from: 'k', to: 'x', text: 't', at: NOW - 60 * MIN, state: 'new' }, { id: 'new', from: 'k', to: 'x', text: 't', at: NOW + MIN, state: 'new' }],
  });
  assert.deepEqual(items.map(x => x.id), ['old', 'nt', 'new']);
  assert.equal(items[1].at, NOW);
});
