// Skillbook usage store + transcript backfill (temp dirs, made-up data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageStore, backfill } from '../skillbook/usage.mjs';
import '../core/skillbook.js';

const S = globalThis.AgentDeskSkillbook;
const HOUR = 3600e3;
const tmp = () => mkdtempSync(join(tmpdir(), 'sbk-usage-'));
const tline = (at, skill) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), cwd: '/w/demo-app', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Skill', input: { skill } }] } });
const hook = (atMs, skill) => ({ ts: atMs / 1000, agent: 'claude', ev: { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, cwd: '/w/demo-app' } });
function projects(dir, files) {
  const root = join(dir, 'projects');
  for (const [name, lines] of Object.entries(files)) { mkdirSync(join(root, 'p1'), { recursive: true }); writeFileSync(join(root, 'p1', name), lines.join('\n') + '\n'); }
  return root;
}

test('backfill counts up to the cutoff only', async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill'), tline(cutoff + HOUR, 'demo-skill'), 'garbage {'], 'b.jsonl': [tline(cutoff - 2 * HOUR, 'other')] });
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => cutoff + 2 * HOUR });
  store.load();
  assert.equal(store.backfillDone(), false);
  const r = await backfill(store, { roots: [root], cutoff });
  assert.deepEqual(r, { files: 2, uses: 2, skipped: 0 });
  assert.equal(store.get('demo-skill').total, 1);
  assert.equal(store.get('other').total, 1);
  assert.equal(store.cutoff(), cutoff); assert.equal(store.backfillDone(), true);
  store.addRecord(hook(cutoff + HOUR, 'demo-skill'));
  store.addRecord(hook(cutoff - HOUR, 'demo-skill')); // already in transcripts
  assert.equal(store.get('demo-skill').total, 2);
  store.save();
  assert.equal(statSync(join(dir, 'u.json')).mode & 0o777, 0o600);
  const re = createUsageStore({ file: join(dir, 'u.json') }); re.load();
  assert.equal(re.get('demo-skill').total, 2); assert.equal(re.get('demo-skill').lastRepo, 'demo-app'); assert.equal(re.get('demo-skill').byAgent.claude, 2);
});

test('an unfinished backfill is redone from scratch', async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill'), tline(cutoff - 2 * HOUR, 'demo-skill')] });
  const clean = createUsageStore({ file: join(dir, 'clean.json'), now: () => cutoff });
  clean.load(); await backfill(clean, { roots: [root], cutoff });
  const file = join(dir, 'u.json');
  writeFileSync(file, JSON.stringify({ v: 1, cutoff: cutoff - HOUR, backfilled: false, keys: { 'demo-skill': { total: 5, byDay: {}, lastAt: 1, lastRepo: 'x', byAgent: { claude: 5 } } } }));
  const store = createUsageStore({ file, now: () => cutoff });
  store.load();
  assert.equal(store.backfillDone(), false);
  await backfill(store, { roots: [root], cutoff });
  assert.equal(store.get('demo-skill').total, clean.get('demo-skill').total);
  assert.equal(store.get('demo-skill').total, 2);
  await backfill(store, { roots: [root], cutoff });
  assert.equal(store.get('demo-skill').total, 2);
});

test('byDay keeps 60 days and week counts', () => {
  const dir = tmp(); const now = new Date(2026, 10, 4, 15, 0).getTime();
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => now });
  store.add({ key: 'k', kind: 'skill', agent: 'claude', at: now, repo: 'r' });
  store.add({ key: 'k', kind: 'skill', agent: 'claude', at: now - 61 * 86400e3, repo: 'r' });
  const g = store.get('k');
  assert.equal(g.total, 2); assert.equal(Object.keys(g.byDay).length, 1);
  assert.equal(S.weekCount(g.byDay, now), 1);
});

test('get unknown key', () => {
  const store = createUsageStore({ file: join(tmp(), 'u.json') });
  store.load();
  assert.equal(store.get('nope'), null); assert.equal(store.cutoff(), null);
});

test('odd key and agent names stay plain data', () => {
  const file = join(tmp(), 'u.json');
  const store = createUsageStore({ file });
  store.add({ key: '__proto__', kind: 'skill', agent: 'constructor', at: Date.now(), repo: 'r' });
  store.add({ key: 'constructor', kind: 'skill', agent: '__proto__', at: Date.now(), repo: 'r' });
  store.add({ key: 'ok', kind: 'skill', agent: 'claude', at: Date.now(), repo: 'r' });
  assert.equal(({}).total, undefined); assert.equal(Object.prototype.total, undefined); assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(store.get('__proto__').total, 1); assert.equal(store.get('__proto__').byAgent.constructor, 1);
  assert.equal(store.get('constructor').total, 1); assert.equal(store.get('ok').total, 1);
  assert.equal(store.get('toString'), null);
  store.save();
  const re = createUsageStore({ file }); re.load();
  assert.equal(re.get('__proto__').total, 1); assert.equal(re.get('ok').total, 1); assert.equal(({}).total, undefined);
});

test('malformed entries and damaged files load safely', () => {
  const dir = tmp(); const file = join(dir, 'u.json');
  writeFileSync(file, JSON.stringify({ v: 1, keys: { a: {}, b: { total: 'x', byDay: 5 }, c: { total: 3, byDay: { '2026-11-04': 'x', junk: 2 }, byAgent: [1] }, __proto__x: null } }));
  const store = createUsageStore({ file, now: () => Date.UTC(2026, 10, 4, 12) });
  store.load();
  assert.equal(store.get('a'), null); assert.equal(store.get('b'), null);
  assert.equal(store.get('c').total, 3);
  store.addRecord(hook(Date.UTC(2026, 10, 4, 12), 'c'));
  store.addRecord(hook(Date.UTC(2026, 10, 4, 12), 'a'));
  assert.equal(store.get('c').total, 4); assert.equal(store.get('a').total, 1);
  store.save();
  writeFileSync(file, 'not json {{');
  const bad = createUsageStore({ file }); bad.load();
  assert.equal(bad.get('c'), null); assert.equal(bad.backfillDone(), false); assert.equal(bad.cutoff(), null);
  bad.addRecord(hook(Date.now(), 'c')); assert.equal(bad.get('c').total, 1);
});

test('addRecord during a backfill counts after-cutoff records once', async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill')] });
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => cutoff + 2 * HOUR });
  store.load();
  const p = backfill(store, { roots: [root], cutoff });
  store.addRecord(hook(cutoff + HOUR, 'demo-skill')); // live while the backfill runs
  store.addRecord(hook(cutoff - HOUR, 'demo-skill')); // before the cutoff: transcripts own it
  await p;
  assert.equal(store.get('demo-skill').total, 2);
});

test('a transcript that cannot be read leaves the backfill unfinished', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill')], 'b.jsonl': [tline(cutoff - HOUR, 'other')] });
  chmodSync(join(root, 'p1', 'b.jsonl'), 0o000);
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => cutoff });
  store.load();
  try {
    const r = await backfill(store, { roots: [root], cutoff });
    assert.equal(r.skipped, 1); assert.equal(store.backfillDone(), false);
    assert.equal(store.get('demo-skill').total, 1);
  } finally { chmodSync(join(root, 'p1', 'b.jsonl'), 0o600); }
});

test('overlapping backfill calls share one run', async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill')] });
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => cutoff });
  store.load();
  const p1 = backfill(store, { roots: [root], cutoff });
  const p2 = backfill(store, { roots: [root], cutoff });
  assert.equal(p1, p2);
  await p1;
  assert.equal(store.get('demo-skill').total, 1);
  await backfill(store, { roots: [root], cutoff }); // after finishing, a new run is allowed
  assert.equal(store.get('demo-skill').total, 1);
});

// live hook feed: every use counted exactly once (re-reads after the log is trimmed, restarts, same-second records)
const hookUse = (atMs, skill, extra = {}) => ({ ts: atMs / 1000, agent: 'claude', ev: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Skill', tool_input: { skill }, cwd: '/w/demo-app', ...extra } });
const promptUse = (atMs, text) => ({ ts: atMs / 1000, agent: 'claude', ev: { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: text, cwd: '/w/demo-app' } });
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

test('feedRecord: replaying the same records counts them once', () => {
  const store = createUsageStore({ file: join(tmp(), 'u.json'), now: () => T0 + HOUR });
  const recs = [hookUse(T0, 'demo-skill', { tool_use_id: 'tu1' }), hookUse(T0 + 1000, 'demo-skill', { tool_use_id: 'tu2' }), promptUse(T0 + 2000, '/demo-skill go')];
  assert.deepEqual(recs.map(r => store.feedRecord(r)), [true, true, true]);
  assert.deepEqual(recs.map(r => store.feedRecord(r)), [false, false, false]);
  assert.equal(store.get('demo-skill').total, 3);
  assert.equal(store.feedRecord({ ts: T0 / 1000, ev: { hook_event_name: 'Stop', session_id: 's1' } }), false); // no use in it
});

test('feedRecord: a trimmed log re-read from the start counts once', () => {
  const store = createUsageStore({ file: join(tmp(), 'u.json'), now: () => T0 + HOUR });
  const log = [];
  for (let i = 0; i < 10; i++) log.push(hookUse(T0 + i * 60e3, 'demo-skill', { tool_use_id: `tu${i}` }));
  for (const r of log) store.feedRecord(r);
  const kept = log.slice(6); // tail -n 4 && mv
  kept.push(hookUse(T0 + 10 * 60e3, 'demo-skill', { tool_use_id: 'tu10' }));
  for (const r of kept) store.feedRecord(r);
  assert.equal(store.get('demo-skill').total, 11);
});

test('feedRecord: a restart from the saved file does not count again', () => {
  const file = join(tmp(), 'u.json');
  const recs = [hookUse(T0, 'demo-skill', { tool_use_id: 'tu1' }), promptUse(T0 + 500, '/other-skill'), hookUse(T0 + 500, 'demo-skill', { tool_use_id: 'tu2' })];
  const a = createUsageStore({ file, now: () => T0 + HOUR });
  for (const r of recs) a.feedRecord(r);
  a.save();
  const b = createUsageStore({ file, now: () => T0 + HOUR });
  b.load();
  assert.deepEqual(recs.map(r => b.feedRecord(r)), [false, false, false]);
  assert.equal(b.get('demo-skill').total, 2);
  assert.equal(b.get('other-skill').total, 1);
  assert.equal(b.feedRecord(hookUse(T0 + 600, 'demo-skill', { tool_use_id: 'tu3' })), true);
  assert.equal(b.get('demo-skill').total, 3);
});

test('feedRecord: two different records in the same second both count', () => {
  const store = createUsageStore({ file: join(tmp(), 'u.json'), now: () => T0 + HOUR });
  assert.equal(store.feedRecord(hookUse(T0, 'demo-skill', { tool_use_id: 'a' })), true);
  assert.equal(store.feedRecord(hookUse(T0, 'demo-skill', { tool_use_id: 'b' })), true);
  assert.equal(store.feedRecord(promptUse(T0, '/demo-skill one')), true);
  assert.equal(store.feedRecord(promptUse(T0, '/demo-skill two')), true);
  assert.equal(store.feedRecord(hookUse(T0 - 30e3, 'demo-skill', { tool_use_id: 'late' })), true); // appended a little out of order
  assert.equal(store.feedRecord(hookUse(T0 - 10 * 60e3, 'demo-skill', { tool_use_id: 'old' })), false); // long before the mark: already fed once
  assert.equal(store.get('demo-skill').total, 5);
});

test('repos are kept 30 days and survive a restart', () => {
  const file = join(tmp(), 'u.json');
  const DAY = 24 * HOUR;
  const a = createUsageStore({ file, now: () => T0 });
  a.noteRepo('/w/recent', T0 - DAY);
  a.noteRepo('/w/edge', T0 - 29 * DAY);
  a.noteRepo('/w/stale', T0 - 31 * DAY);
  a.noteRepo('/w/recent', T0 - 5 * DAY); // older note never moves it back
  a.noteRepo('', T0);
  assert.deepEqual(a.repos(), ['/w/edge', '/w/recent']);
  a.save();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).repos).sort(), ['/w/edge', '/w/recent']);
  const b = createUsageStore({ file, now: () => T0 + 2 * DAY });
  b.load();
  assert.deepEqual(b.repos(), ['/w/recent']);
});

test('backfill notes each transcript folder as a repo', async () => {
  const dir = tmp(); const cutoff = Date.now();
  const root = projects(dir, { 'a.jsonl': [tline(cutoff - HOUR, 'demo-skill')] });
  const store = createUsageStore({ file: join(dir, 'u.json') });
  store.load();
  await backfill(store, { roots: [root], cutoff });
  assert.deepEqual(store.repos(), ['/w/demo-app']);
});

// ---- final fix wave ----
test('mcp tool names are kept per server (names only, at most 30, survive save/load)', () => {
  const dir = tmp(); const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => now });
  store.load();
  store.addRecord({ ts: now / 1000, agent: 'claude', ev: { hook_event_name: 'PreToolUse', tool_name: 'mcp__db__query', tool_input: { sql: 'select sk-SECRET' } } });
  store.addRecord({ ts: now / 1000, agent: 'claude', ev: { hook_event_name: 'PreToolUse', tool_name: 'mcp__db__query', tool_input: {} } });
  store.addRecord({ ts: now / 1000, agent: 'claude', ev: { hook_event_name: 'PreToolUse', tool_name: 'mcp__db__list_tables', tool_input: {} } });
  store.add({ key: 'db', kind: 'mcp', agent: 'claude', at: now, tool: 'bad name with spaces' });
  for (let i = 0; i < 40; i++) store.add({ key: 'big', kind: 'mcp', agent: 'claude', at: now, tool: `t${i}` });
  store.add({ key: 'demo-skill', kind: 'skill', agent: 'claude', at: now });
  assert.deepEqual(store.get('db').tools, ['query', 'list_tables']);
  assert.equal(store.get('big').tools.length, 30);
  assert.equal(store.get('demo-skill').tools, undefined);
  store.save();
  assert.ok(!readFileSync(join(dir, 'u.json'), 'utf8').includes('sk-SECRET'));
  const raw = JSON.parse(readFileSync(join(dir, 'u.json'), 'utf8'));
  raw.keys.db.tools.push('x y', 7, 'ok_tool');
  for (let i = 0; i < 40; i++) raw.keys.db.tools.push(`z${i}`);
  writeFileSync(join(dir, 'u.json'), JSON.stringify(raw));
  const re = createUsageStore({ file: join(dir, 'u.json'), now: () => now }); re.load();
  assert.deepEqual(re.get('db').tools.slice(0, 3), ['query', 'list_tables', 'ok_tool']);
  assert.equal(re.get('db').tools.length, 30);
  assert.deepEqual(re.keys().sort(), ['big', 'db', 'demo-skill']);
});

test('backfill keeps mcp tool names too', async () => {
  const dir = tmp(); const cutoff = Date.UTC(2026, 10, 3, 12, 0, 0);
  const mline = JSON.stringify({ type: 'assistant', timestamp: new Date(cutoff - HOUR).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'mcp__db__query', input: {} }] } });
  const root = projects(dir, { 'a.jsonl': [mline] });
  const store = createUsageStore({ file: join(dir, 'u.json'), now: () => cutoff + HOUR });
  store.load();
  await backfill(store, { roots: [root], cutoff });
  assert.deepEqual(store.get('db').tools, ['query']);
});
