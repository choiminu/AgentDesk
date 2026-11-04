// Quest board, main process: the state file (quest/state.mjs), the front desk (quest/desk.mjs) with a fake `run`,
// and the main/preload/package wiring (source checks; Electron is never launched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createQuestState } from '../quest/state.mjs';
import { askDesk, createDesk, deskArgs, DESK_TIMEOUT_MS, DESK_CACHE_MS } from '../quest/desk.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'quest-main-')), 'roca', 'quests.json');
const IS_WIN = process.platform === 'win32';

const ISSUE = { key: 'ABC-12', fields: { summary: 'Fix login', description: 'use token sk-live-ABCDEFGHIJKLMNOPQRSTUV1234 and ghp_abcdefghijklmnopqrstuvwxyz0123 to call it' } };
const PARTY = [
  { id: 's-1', name: 'alpha', repo: 'alpha', branch: 'main', status: 'waiting', eligible: true, doing: '', skills: [] },
  { id: 's-2', name: 'busy', repo: 'beta', branch: 'dev', status: 'working', eligible: false, doing: '', skills: [] },
];
const REPOS = ['alpha', 'beta'];
const envelope = obj => JSON.stringify({ type: 'result', is_error: false, structured_output: obj, result: '' });
const okRun = (obj, calls = []) => async (input) => { calls.push(input); return { code: 0, stdout: envelope(obj) }; };

// ── state ──
test('state round trip: set / get / report / drop / all survive a reload', () => {
  const file = tmpFile();
  let t = 1000;
  const st = createQuestState({ file, now: () => t });
  st.load();
  assert.deepEqual(st.all(), { v: 1, quests: {} });
  st.set('ABC-1', { kind: 'session', sessionId: 's-1' });
  st.set('ABC-2', { kind: 'worktree', repo: 'alpha', at: 5 });
  t = 2000;
  assert.equal(st.report('ABC-1'), true);
  assert.equal(st.report('NOPE-1'), false);
  const again = createQuestState({ file, now: () => t });
  again.load();
  assert.deepEqual(again.get('ABC-1'), { kind: 'session', sessionId: 's-1', at: 1000, reportAt: 2000 });
  assert.deepEqual(again.get('ABC-2'), { kind: 'worktree', repo: 'alpha', at: 5 });
  assert.equal(again.get('ABC-3'), undefined);
  again.drop('ABC-2');
  const third = createQuestState({ file }); third.load();
  assert.deepEqual(Object.keys(third.all().quests), ['ABC-1']);
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).v, 1);
});

test('state file is written 0600, also over a looser existing file', { skip: IS_WIN }, () => {
  const file = tmpFile();
  const st = createQuestState({ file }); st.load();
  st.set('ABC-1', { kind: 'worktree', repo: 'alpha' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, JSON.stringify({ v: 1, quests: {} }), { mode: 0o644 });
  st.set('ABC-2', { kind: 'worktree', repo: 'alpha' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('state: junk file loads empty; bad entries are refused; all() is a copy', () => {
  const file = tmpFile();
  const st0 = createQuestState({ file }); st0.load(); st0.set('ABC-9', { kind: 'worktree', repo: 'x' });
  writeFileSync(file, '{not json');
  const st = createQuestState({ file }); st.load();
  assert.deepEqual(st.all(), { v: 1, quests: {} });
  assert.throws(() => st.set('ABC-1', { kind: 'nope' }));
  assert.throws(() => st.set('ABC-1', { kind: 'session' }));
  assert.throws(() => st.set('ABC-1', { kind: 'worktree' }));
  st.set('ABC-1', { kind: 'session', sessionId: 's', extra: 'dropped' });
  assert.deepEqual(Object.keys(st.get('ABC-1')).sort(), ['at', 'kind', 'sessionId']);
  st.all().quests['ABC-1'].kind = 'hacked';
  assert.equal(st.get('ABC-1').kind, 'session');
});

test('state prune: listed keys and tickets done in Jira over 30 days ago go', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const st = createQuestState({ file: tmpFile(), now: () => now }); st.load();
  for (const k of ['A-1', 'A-2', 'A-3', 'A-4']) st.set(k, { kind: 'worktree', repo: 'r' });
  st.prune(['A-1']);
  assert.deepEqual(Object.keys(st.all().quests), ['A-2', 'A-3', 'A-4']);
  st.prune([
    { key: 'A-2', fields: { status: { statusCategory: { key: 'done' } }, resolutiondate: '2026-09-01T00:00:00Z' } },
    { key: 'A-3', fields: { status: { statusCategory: { key: 'done' } }, resolutiondate: '2026-10-30T00:00:00Z' } },
  ]);
  assert.deepEqual(Object.keys(st.all().quests), ['A-3', 'A-4']);
});

// ── front desk ──
test('desk args follow the constraints', () => {
  const a = deskArgs();
  assert.equal(a[0], '-p');
  assert.equal(a[a.indexOf('--model') + 1], process.env.AGENTDESK_QUEST_MODEL || 'haiku');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--json-schema') + 1], globalThis.AgentDeskQuest.DESK_SCHEMA);
  assert.equal(a[a.indexOf('--system-prompt') + 1], globalThis.AgentDeskQuest.DESK_SYSTEM);
  assert.ok(a.includes('--disable-slash-commands'));
  assert.deepEqual(a.slice(a.indexOf('--disallowedTools') + 1), ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
  assert.equal(DESK_TIMEOUT_MS, 90000);
  assert.equal(DESK_CACHE_MS, 600000);
});

test('desk input is masked', async () => {
  const calls = [];
  const party = [{ ...PARTY[0], doing: 'deploy with password=hunter2hunter2' }];
  const r = await askDesk({ issue: ISSUE, party, repos: REPOS, run: okRun({ choice: { kind: 'session', id: 's-1' }, reason: 'idle in alpha' }, calls) });
  assert.deepEqual(r, { ok: true, choice: { kind: 'session', id: 's-1' }, reason: 'idle in alpha' });
  assert.equal(calls.length, 1);
  const input = calls[0];
  assert.ok(input.includes('Fix login'));
  for (const s of ['sk-live-ABCDEFGHIJKLMNOPQRSTUV1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'hunter2hunter2']) assert.ok(!input.includes(s), s);
  assert.ok(input.includes('[MASKED'));
});

test('desk: worktree answer in the repo list is accepted; result envelope string is parsed too', async () => {
  const run = async () => ({ code: 0, stdout: JSON.stringify({ result: JSON.stringify({ choice: { kind: 'worktree', repo: 'beta' }, reason: 'r' }) }) });
  assert.deepEqual(await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run }), { ok: true, choice: { kind: 'worktree', repo: 'beta' }, reason: 'r' });
});

test('desk: invalid / unknown answers → invalid; non-zero exit → failed', async () => {
  const cases = [
    { choice: { kind: 'session', id: 's-404' }, reason: 'x' },      // unknown session
    { choice: { kind: 'session', id: 's-2' }, reason: 'x' },        // not eligible (working)
    { choice: { kind: 'worktree', repo: 'gamma' }, reason: 'x' },   // unknown repo
    { choice: { kind: 'nope' }, reason: 'x' },
    null,
  ];
  for (const c of cases) assert.deepEqual(await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run: okRun(c) }), { ok: false, error: 'invalid' }, JSON.stringify(c));
  assert.deepEqual(await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run: async () => ({ code: 0, stdout: 'not json' }) }), { ok: false, error: 'invalid' });
  assert.deepEqual(await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run: async () => ({ code: 1, stdout: '' }) }), { ok: false, error: 'failed' });
  assert.deepEqual(await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run: async () => { throw new Error('ENOENT'); } }), { ok: false, error: 'failed' });
});

test('desk: timeout → timeout (the run is aborted)', async () => {
  let aborted = false;
  const run = (_input, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
  const r = await askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, error: 'timeout' });
  assert.equal(aborted, true);
});

test('desk: cancel → cancelled', async () => {
  const ac = new AbortController();
  const run = (_input, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('killed'))));
  const p = askDesk({ issue: ISSUE, party: PARTY, repos: REPOS, run, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { ok: false, error: 'cancelled' });
  const desk = createDesk({ run });
  const q = desk.ask({ key: 'ABC-12', issue: ISSUE, party: PARTY, repos: REPOS });
  assert.equal(desk.cancel('ABC-12'), true);
  assert.deepEqual(await q, { ok: false, error: 'cancelled' });
  assert.equal(desk.cancel('ABC-12'), false);
});

test('one desk call per ticket at a time', async () => {
  const calls = [];
  let release;
  const run = (input) => { calls.push(input); return new Promise(res => { release = () => res({ code: 0, stdout: envelope({ choice: { kind: 'session', id: 's-1' }, reason: 'r' }) }); }); };
  const desk = createDesk({ run });
  const a = desk.ask({ key: 'ABC-12', issue: ISSUE, party: PARTY, repos: REPOS });
  const b = desk.ask({ key: 'ABC-12', issue: ISSUE, party: PARTY, repos: REPOS });
  assert.equal(desk.pending('ABC-12'), true);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.deepEqual(ra, rb);
  assert.equal(ra.ok, true);
  assert.equal(desk.pending('ABC-12'), false);
});

test('desk proposals are cached per ticket for 10 minutes; failures are not cached', async () => {
  let t = 0;
  const calls = [];
  const desk = createDesk({ run: okRun({ choice: { kind: 'session', id: 's-1' }, reason: 'r' }, calls), now: () => t });
  const args = { key: 'ABC-12', issue: ISSUE, party: PARTY, repos: REPOS };
  await desk.ask(args);
  t = 9 * 60e3; await desk.ask(args);
  assert.equal(calls.length, 1);
  await desk.ask({ ...args, key: 'ABC-13' });
  assert.equal(calls.length, 2);
  t = 10 * 60e3 + 1; await desk.ask(args);
  assert.equal(calls.length, 3);
  // a cached session that is no longer eligible is asked again
  t += 1000;
  await desk.ask({ ...args, party: [{ ...PARTY[0], eligible: false }] });
  assert.equal(calls.length, 4);
  const bad = []; const d2 = createDesk({ run: okRun({ choice: { kind: 'session', id: 'zzz' }, reason: 'r' }, bad) });
  await d2.ask(args); await d2.ask(args);
  assert.equal(bad.length, 2);
});

// ── wiring ──
test('main / preload / package wiring', () => {
  const main = readFileSync(join(ROOT, 'main.mjs'), 'utf-8');
  const preload = readFileSync(join(ROOT, 'preload.cjs'), 'utf-8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  for (const ch of ['roca:quest-state', 'roca:quest-assign', 'roca:quest-report', 'roca:quest-desk', 'roca:quest-desk-cancel']) {
    assert.ok(main.includes(`ipcMain.handle("${ch}"`), `main ${ch}`);
    assert.ok(preload.includes(`"${ch}"`), `preload ${ch}`);
  }
  for (const n of ['questState', 'questAssign', 'questReport', 'questDesk', 'questDeskCancel']) assert.match(preload, new RegExp(`\\b${n}:`), n);
  assert.ok(pkg.build.files.includes('quest/**/*'));
  assert.match(main, /join\(ROCA_DIR, "quests\.json"\)/);
  assert.match(main, /\^\[A-Z\]\[A-Z0-9_\]\*-\\d\+\$/);
  assert.ok(existsSync(join(ROOT, 'quest/state.mjs')) && existsSync(join(ROOT, 'quest/desk.mjs')));
});
