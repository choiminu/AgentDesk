// Quest core: core/quest.js (difficulty, grouping, party, front-desk prompt and answer validation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/quest.js');
const Q = globalThis.AgentDeskQuest;

const issue = (key, cat, extra = {}) => ({ key, fields: { summary: 'S ' + key, status: { name: 'X', statusCategory: { key: cat } }, ...extra } });

test('difficulty table', () => {
  assert.equal(Q.difficulty('Highest'), 3);
  assert.equal(Q.difficulty('High'), 3);
  assert.equal(Q.difficulty('Medium'), 2);
  assert.equal(Q.difficulty('Low'), 1);
  assert.equal(Q.difficulty('Lowest'), 1);
  assert.equal(Q.difficulty(''), 0);
  assert.equal(Q.difficulty(null), 0);
  assert.equal(Q.difficulty(undefined), 0);
  assert.equal(Q.difficulty('Blocker'), 2);
  assert.equal(Q.difficulty(' high '), 3);
});

test('groupOf: jira category without state', () => {
  const live = new Set();
  assert.equal(Q.groupOf(issue('A-1', 'new'), undefined, live), 'new');
  assert.equal(Q.groupOf(issue('A-1', 'indeterminate'), undefined, live), 'doing');
  assert.equal(Q.groupOf(issue('A-1', 'done'), undefined, live), 'done');
});

test('groupOf: AgentDesk state wins', () => {
  const live = new Set(['s1']);
  const st = { kind: 'session', sessionId: 's1', at: 1 };
  assert.equal(Q.groupOf(issue('A-1', 'new'), st, live), 'doing');
  assert.equal(Q.groupOf(issue('A-1', 'done'), st, live), 'doing');
  assert.equal(Q.groupOf(issue('A-1', 'new'), { ...st, reportAt: 5 }, live), 'report');
  assert.equal(Q.groupOf(issue('A-1', 'indeterminate'), { ...st, sessionId: 'gone', reportAt: 5 }, live), 'report');
});

test('groupOf: normalized issue shape is accepted', () => {
  const n = { key: 'A-2', summary: 'x', status: 'To Do', statusCategory: 'new', priority: 'High' };
  assert.equal(Q.groupOf(n, undefined, new Set()), 'new');
  assert.equal(Q.groupOf({ key: 'A-3' }, undefined, new Set()), 'new');
});

test('ended session frees the quest', () => {
  const live = new Set(['s1']);
  const state = { v: 1, quests: { 'A-1': { kind: 'session', sessionId: 'gone', at: 1 } } };
  assert.equal(Q.groupOf(issue('A-1', 'new'), state.quests['A-1'], live), 'new');
  const v = Q.questView([issue('A-1', 'new')], state, live);
  assert.equal(v[0].group, 'new');
  assert.equal(v[0].quest.ended, true);
  assert.equal(v[0].quest.sessionId, 'gone');
});

test('questView maps fields', () => {
  const iss = issue('A-9', 'indeterminate', { priority: { name: 'High' }, duedate: '2026-12-01', assignee: { displayName: 'Kim' } });
  const state = { v: 1, quests: { 'A-9': { kind: 'worktree', repo: 'acme/api', at: 10 } } };
  const [c] = Q.questView([iss, null, {}], state, new Set());
  assert.deepEqual(c, { key: 'A-9', title: 'S A-9', difficulty: 3, group: 'doing', status: 'X', due: '2026-12-01', assignee: 'Kim', quest: { kind: 'worktree', repo: 'acme/api', at: 10 } });
  const [p] = Q.questView([issue('A-8', 'new')], null, new Set());
  assert.equal(p.difficulty, 0);
  assert.equal('quest' in p, false);
  assert.equal('due' in p, false);
});

const mk = (id, status, more) => ({ id, name: 'n' + id, repo: 'acme/api', branch: 'b' + id, status, connected: true, ...more });
const handles = new Map([['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['t', 1]]);

test('partyOf eligibility and exclusions', () => {
  const sessions = [
    mk('a', 'waiting', { needsInput: true, doing: 'fix tests', skills: ['tdd'] }),
    mk('b', 'done'),
    mk('c', 'running'),
    mk('d', 'waiting', { hasPerm: true }),
    mk('e', 'done', { isSub: true }),
    mk('f', 'done', { connected: false }),
    mk('g', 'done'),                       // no handle
    mk('t', 'done', { peer: 'mate' }),     // teammate
    null,
  ];
  const p = Q.partyOf(sessions, handles);
  assert.deepEqual(p.map(x => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(p.map(x => x.eligible), [true, true, false, false]);
  assert.equal(p[0].doing, 'fix tests');
  assert.deepEqual(p[0].skills, ['tdd']);
  assert.deepEqual(p[1].skills, []);
  assert.equal(p[1].doing, '');
  assert.equal(p[0].repo, 'acme/api');
});

test('partyOf tolerates missing fields and plain-object handles', () => {
  assert.deepEqual(Q.partyOf(null, null), []);
  const p = Q.partyOf([{ id: 'z', connected: true }], { get: id => id === 'z' });
  assert.equal(p.length, 1);
  assert.equal(p[0].eligible, false);
  assert.equal(p[0].name, '');
});

test('deskPrompt lists ticket, party and repos', () => {
  const party = Q.partyOf([mk('a', 'waiting', { doing: 'x' }), mk('c', 'running')], handles);
  const s = Q.deskPrompt({ key: 'A-1', summary: 'Fix login', description: 'long '.repeat(2000), labels: ['be'] }, party, ['acme/api', 'acme/web']);
  assert.match(s, /A-1/);
  assert.match(s, /Fix login/);
  assert.match(s, /acme\/web/);
  assert.match(s, /\ba\b/);
  assert.doesNotMatch(s, /\bid[=:] ?c\b/);   // working session not offered
  assert.ok(s.length < 6000);
  assert.doesNotThrow(() => JSON.parse(Q.DESK_SCHEMA));
  assert.deepEqual(JSON.parse(Q.DESK_SCHEMA).required, ['choice', 'reason']);
});

test('acceptProposal validates against lists', () => {
  const party = Q.partyOf([mk('a', 'waiting'), mk('c', 'running')], handles);
  const repos = ['acme/api'];
  assert.deepEqual(Q.acceptProposal({ choice: { kind: 'session', id: 'a' }, reason: 'r' }, party, repos), { kind: 'session', id: 'a' });
  assert.deepEqual(Q.acceptProposal(JSON.stringify({ choice: { kind: 'worktree', repo: 'acme/api' }, reason: 'r' }), party, repos), { kind: 'worktree', repo: 'acme/api' });
  assert.equal(Q.acceptProposal({ choice: { kind: 'session', id: 'c' } }, party, repos), null);      // not eligible
  assert.equal(Q.acceptProposal({ choice: { kind: 'session', id: 'zz' } }, party, repos), null);
  assert.equal(Q.acceptProposal({ choice: { kind: 'worktree', repo: 'evil/x' } }, party, repos), null);
  assert.equal(Q.acceptProposal({ choice: { kind: 'other', id: 'a' } }, party, repos), null);
  for (const j of [null, undefined, 'junk', '{', 5, [], {}, { choice: null }, { choice: 'a' }]) assert.equal(Q.acceptProposal(j, party, repos), null);
  assert.equal(Q.acceptProposal({ choice: { kind: 'session', id: 'a' } }, null, null), null);
});

test('pruneState drops tickets done over 30 days ago', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const day = 864e5;
  const st = { v: 1, quests: { 'A-1': { kind: 'session', at: 1 }, 'A-2': { kind: 'session', at: 1 }, 'A-3': { kind: 'session', at: 1 } } };
  const iss = [
    issue('A-1', 'done', { resolutiondate: new Date(now - 40 * day).toISOString() }),
    issue('A-2', 'done', { resolutiondate: new Date(now - 5 * day).toISOString() }),
  ];
  const out = Q.pruneState(st, iss, now);
  assert.deepEqual(Object.keys(out.quests).sort(), ['A-2', 'A-3']);
  assert.equal(out.v, 1);
  assert.ok(st.quests['A-1']);  // input untouched
});
