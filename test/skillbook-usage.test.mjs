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
