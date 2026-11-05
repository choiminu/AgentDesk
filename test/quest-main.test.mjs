// Quest board, main process: the state file (quest/state.mjs), the front desk (quest/desk.mjs) with a fake `run`,
// and the main/preload/package wiring (source checks; Electron is never launched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createQuestState } from '../quest/state.mjs';
import { askDesk, createDesk, deskArgs, spawnRun, killAllDesk, DESK_TIMEOUT_MS, DESK_CACHE_MS, DESK_MAX_INFLIGHT, DESK_KILL_GRACE_MS } from '../quest/desk.mjs';

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

test('state prune: projects of a complete load drop their quiet entries the load did not return', () => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const file = tmpFile();
  const st = createQuestState({ file, now: () => now }); st.load();
  for (const k of ['PROJ-1', 'PROJ-2', 'OPS-1']) st.set(k, { kind: 'worktree', repo: 'r' });
  now += 40 * 864e5;
  st.set('PROJ-3', { kind: 'worktree', repo: 'r' });
  st.prune([{ key: 'PROJ-2', fields: { status: { statusCategory: { key: 'indeterminate' } } } }]);   // no projects: nothing by absence
  assert.deepEqual(Object.keys(st.all().quests), ['PROJ-1', 'PROJ-2', 'OPS-1', 'PROJ-3']);
  st.prune([{ key: 'PROJ-2', fields: { status: { statusCategory: { key: 'indeterminate' } } } }], ['PROJ']);
  assert.deepEqual(Object.keys(st.all().quests), ['PROJ-2', 'OPS-1', 'PROJ-3']);
  const again = createQuestState({ file }); again.load();
  assert.deepEqual(Object.keys(again.all().quests), ['PROJ-2', 'OPS-1', 'PROJ-3'], 'saved');
  assert.equal(st.prune([], ['OPS']), 2, 'an empty complete load of OPS drops its quiet entry');
});

test('main: quest-prune passes validated project keys to the state', () => {
  const main = readFileSync(join(ROOT, 'main.mjs'), 'utf-8');
  assert.match(main, /questPruneProjectsIn = p => \(Array\.isArray\(p\) \? p\.slice\(0, 50\) : \[\]\)\.filter\(k => typeof k === "string" && \/\^\[A-Z\]\[A-Z0-9_\]\{0,49\}\$\/\.test\(k\)\)/);
  assert.match(main, /questState\(\)\.prune\(issues, projects\)/);
  assert.match(main, /description: questClip\(f\.description != null \? f\.description : i\.description, 20000\)/);
});

test('state is 0600 from the first byte: no looser window, even over a leftover temp file', { skip: IS_WIN }, () => {
  const src = readFileSync(join(ROOT, 'quest/state.mjs'), 'utf-8');
  assert.ok(!/writeJsonAtomic/.test(src), 'no mode-keeping helper');
  assert.match(src, /writeFileSync\(tmp, [^\n]*\{ mode: 0o600 \}\)/);
  const file = tmpFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.agentdesk-${process.pid}.tmp`;
  writeFileSync(tmp, 'old', { mode: 0o644 }); chmodSync(tmp, 0o644);
  const st = createQuestState({ file }); st.load();
  st.set('ABC-1', { kind: 'worktree', repo: 'alpha' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(tmp));
});

test('state: loaded keys are filtered by the ticket-key pattern; set refuses a non-ticket key', () => {
  const file = tmpFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"v":1,"quests":{"__proto__":{"kind":"worktree","repo":"x","at":1},"constructor":{"kind":"worktree","repo":"x","at":1},"abc-1":{"kind":"worktree","repo":"x","at":1},"ABC-1":{"kind":"worktree","repo":"x","at":1},"AB_C2-7":{"kind":"session","sessionId":"s","at":2}}}');
  const st = createQuestState({ file }); st.load();
  assert.deepEqual(Object.keys(st.all().quests).sort(), ['ABC-1', 'AB_C2-7']);
  assert.equal(st.get('__proto__'), undefined);
  assert.equal(st.get('constructor'), undefined);
  assert.equal(({}).polluted, undefined);
  for (const k of ['__proto__', 'abc-1', 'ABC', '']) assert.throws(() => st.set(k, { kind: 'worktree', repo: 'x' }), k);
});

// ── front desk ──
test('desk args follow the constraints', () => {
  const a = deskArgs();
  assert.ok(a.includes('--no-session-persistence'), 'no transcript on disk');
  assert.ok(a.indexOf('--no-session-persistence') < a.indexOf('--disallowedTools'), 'the variadic --disallowedTools stays last');
  assert.ok(readFileSync(new URL('../quest/desk.mjs', import.meta.url), 'utf8').includes('spawn(cmd, deskArgs(), { cwd: deskCwd(),'), 'runs in its own empty folder');
  assert.equal(a[0], '-p');
  assert.equal(a[a.indexOf('--model') + 1], process.env.AGENTDESK_QUEST_MODEL || 'haiku');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--json-schema') + 1], globalThis.AgentDeskQuest.DESK_SCHEMA);
  assert.equal(a[a.indexOf('--system-prompt') + 1], globalThis.AgentDeskQuest.DESK_SYSTEM);
  assert.ok(a.includes('--disable-slash-commands'));
  // isolation: no tools, no MCP servers, no user / project / local settings
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(!a.includes('--mcp-config'));
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  assert.ok(a.indexOf('--disallowedTools') > a.indexOf('--setting-sources'), 'the variadic --disallowedTools stays last');
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

test('desk input: the full description is masked before the prompt cuts it', async () => {
  const calls = [];
  for (const issue of [
    { key: 'ABC-12', fields: { summary: 'Fix login', description: 'y'.repeat(1490) + ' ghp_abcdefghijklmnopqrstuvwxyz0123 tail' } },
    { key: 'ABC-12', summary: 'Fix login', description: 'y'.repeat(1490) + ' ghp_abcdefghijklmnopqrstuvwxyz0123 tail' },
  ]) await askDesk({ issue, party: PARTY, repos: REPOS, run: okRun({ choice: { kind: 'session', id: 's-1' }, reason: 'r' }, calls) });
  assert.equal(calls.length, 2);
  for (const input of calls) {
    assert.ok(!/ghp_/.test(input), 'no token fragment survives the cut');
    assert.ok(input.includes('[MASKED'));
  }
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

test('desk: at most 2 calls in flight across tickets; a third ticket gets busy', async () => {
  assert.equal(DESK_MAX_INFLIGHT, 2);
  const calls = [], releases = [];
  const run = (input) => { calls.push(input); return new Promise(res => releases.push(() => res({ code: 0, stdout: envelope({ choice: { kind: 'session', id: 's-1' }, reason: 'r' }) }))); };
  const desk = createDesk({ run });
  const args = k => ({ key: k, issue: { ...ISSUE, key: k }, party: PARTY, repos: REPOS });
  const a = desk.ask(args('ABC-1')), b = desk.ask(args('ABC-2'));
  assert.deepEqual(await desk.ask(args('ABC-3')), { ok: false, error: 'busy' });
  const a2 = desk.ask(args('ABC-1'));   // the same ticket still joins its call
  assert.equal(calls.length, 2);
  releases.forEach(f => f());
  assert.equal((await a).ok, true); assert.equal((await b).ok, true); assert.deepEqual(await a2, await a);
  const c = desk.ask(args('ABC-3'));   // a slot is free again
  assert.equal(calls.length, 3);
  releases[2]();
  assert.equal((await c).ok, true);
});

// a stand-in for `claude` (POSIX shell script): ignores its arguments
const fakeCli = body => { const d = mkdtempSync(join(tmpdir(), 'quest-cli-')); const f = join(d, 'claude'); writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return f; };

test('spawnRun: Korean output split across chunks stays whole; stdin reaches the child', { skip: IS_WIN }, async () => {
  const cli = fakeCli(`read line\nprintf '{"result":"\\355\\225'\nsleep 0.2\nprintf '\\234 %s"}' "$line"`);
  const r = await spawnRun({ cmd: cli, env: { PATH: process.env.PATH } })('hello\n');
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).result, '한 hello');
});

test('spawnRun: abort sends SIGTERM, then SIGKILL after the grace period; killAllDesk stops running children', { skip: IS_WIN }, async () => {
  assert.equal(DESK_KILL_GRACE_MS, 3000);
  // the stand-in writes a ready file once its SIGTERM handler is installed; abort only after that
  const ready = join(mkdtempSync(join(tmpdir(), 'quest-ready-')), 'ready');
  const stubborn = fakeCli(`exec "${process.execPath}" -e 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], "1"); setInterval(() => {}, 1000)' "${ready}"`);
  const ac = new AbortController();
  const p = spawnRun({ cmd: stubborn, env: { PATH: process.env.PATH }, killGraceMs: 150 })('x', { signal: ac.signal });
  for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(existsSync(ready), 'stand-in started');
  const t0 = Date.now();
  ac.abort();
  const r = await p;
  assert.equal(r.code, null);
  assert.ok(Date.now() - t0 >= 140, 'survived SIGTERM until the SIGKILL');
  const sleeper = fakeCli(`exec sleep 30`);
  const q = spawnRun({ cmd: sleeper, env: { PATH: process.env.PATH } })('x');
  setTimeout(() => killAllDesk(), 100);
  assert.equal((await q).code, null);
});

// ── wiring ──
test('main / preload / package wiring', () => {
  const main = readFileSync(join(ROOT, 'main.mjs'), 'utf-8');
  const preload = readFileSync(join(ROOT, 'preload.cjs'), 'utf-8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  for (const ch of ['roca:quest-state', 'roca:quest-assign', 'roca:quest-report', 'roca:quest-desk', 'roca:quest-desk-cancel', 'roca:quest-prune']) {
    assert.ok(main.includes(`ipcMain.handle("${ch}"`), `main ${ch}`);
    assert.ok(preload.includes(`"${ch}"`), `preload ${ch}`);
  }
  for (const n of ['questState', 'questAssign', 'questReport', 'questDesk', 'questDeskCancel', 'questPrune']) assert.match(preload, new RegExp(`\\b${n}:`), n);
  assert.ok(pkg.build.files.includes('quest/**/*'));
  assert.match(main, /join\(ROCA_DIR, "quests\.json"\)/);
  assert.match(main, /\^\[A-Z\]\[A-Z0-9_\]\*-\\d\+\$/);
  // the packaged app has no login-shell PATH: the desk's claude gets EXEC_PATH plus the hook-quiet variables
  const deskLine = main.split('\n').find(l => l.includes('createDesk({ run: spawnRun('));
  assert.ok(deskLine, 'desk created in main');
  for (const v of ['...process.env', 'PATH: EXEC_PATH', 'AGENTDESK_RECALL: "1"', 'DISABLE_OMC: "1"', 'OMC_SKIP_HOOKS: "all"']) assert.ok(deskLine.includes(v), v);
  assert.match(main, /app\.on\("will-quit", \(\) => killAllDesk\(\)\)/);
  // prune input is rebuilt from validated issues like the desk input
  assert.match(main, /roca:quest-prune[\s\S]{0,200}questPruneIssuesIn\(o && o\.issues\)/);
  assert.ok(existsSync(join(ROOT, 'quest/state.mjs')) && existsSync(join(ROOT, 'quest/desk.mjs')));
});
