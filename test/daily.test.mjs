// core/daily.js + daily/store.mjs — day-by-day numbers from the hook log: waits, permission families, calendar, rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDailyStore } from '../daily/store.mjs';
const D = globalThis.AgentDeskDaily;

const T0 = new Date('2026-11-10T10:00:00').getTime();
const rec = (ms, sid, name, extra = {}) => ({ ts: ms / 1000, ev: { session_id: sid, hook_event_name: name, ...extra } });

test('family: a permission\'s command family without its arguments', () => {
  assert.equal(D.family('Bash', { command: 'npm test -- --watch' }), 'Bash(npm test:*)');
  assert.equal(D.family('Bash', { command: 'git status' }), 'Bash(git status:*)');
  assert.equal(D.family('Bash', { command: 'ls -la /tmp' }), 'Bash(ls:*)');
  assert.equal(D.family('Bash', { command: 'cat a | grep b' }), '', 'a compound command has no single family');
  assert.equal(D.family('Bash', { command: 'FOO=1 npm test' }), '');
  assert.equal(D.family('Edit', { file_path: '/secret/path' }), 'Edit');
  assert.equal(D.family('mcp__slack__send', {}), 'mcp__slack__send');
  assert.equal(D.family('Bash', {}), '');
});

test('folder: waits, permission waits, test fixes and edits land on their day; numbers only', () => {
  const f = D.createFolder();
  f.fold(rec(T0, 'a', 'UserPromptSubmit', { prompt: 'secret words' }));
  f.fold(rec(T0 + 1000, 'a', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x/y.js' } }));
  f.fold(rec(T0 + 2000, 'a', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/x/y.js' } }));
  f.fold(rec(T0 + 3000, 'a', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  f.fold(rec(T0 + 13000, 'a', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'ℹ fail 2' }));
  f.fold(rec(T0 + 20000, 'a', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ℹ fail 0' } }));
  f.fold(rec(T0 + 30000, 'a', 'Stop'));
  f.fold(rec(T0 + 90000, 'a', 'UserPromptSubmit', { prompt: 'again' }));
  f.fold(rec(T0 + 100000, 'a', 'Stop'));
  f.fold(rec(T0 + 100000 + 3 * 3600e3, 'a', 'UserPromptSubmit', { prompt: 'after lunch' }));
  f.fold(rec(T0 + 5000, 'b', 'PreToolUse', { tool_name: 'Read', agent_id: 'sub' }));
  const d = f.days()['2026-11-10'];
  assert.deepEqual([d.sessions, d.prompts, d.tools, d.edits, d.fails], [2, 3, 1, 1, 1]);
  assert.deepEqual([d.testFail, d.testPass, d.fixes], [1, 1, 1], 'a failing run, then a passing one: a fix');
  assert.deepEqual([d.waitMs, d.waitN], [60000, 1], 'the 3-hour gap is a break, not a wait');
  assert.deepEqual([d.permMs, d.permN], [10000, 1]);
  assert.deepEqual(d.perm['Bash(npm test:*)'], { ask: 1, allow: 1, deny: 0 });
  assert.doesNotMatch(JSON.stringify(f.days()), /secret|\/x\/y|after lunch/, 'no prompt, no path');
});

test('ruleSuggestions: allowed often, never denied, never a risky family', () => {
  const day = (allow, deny) => ({ ...D.emptyDay(), perm: { 'Bash(npm test:*)': { ask: allow, allow, deny: 0 }, 'Bash(rm:*)': { ask: 9, allow: 9, deny: 0 }, 'Bash(git push:*)': { ask: 9, allow: 9, deny: 0 }, 'Bash(ls:*)': { ask: 9, allow: 8, deny }, Edit: { ask: 2, allow: 2, deny: 0 } } });
  const days = { '2026-11-10': day(3, 1), '2026-11-09': day(3, 0), '2026-10-01': day(50, 0) };
  const r = D.ruleSuggestions(days, T0);
  assert.deepEqual(r.map(x => [x.rule, x.allow, x.days]), [['Bash(npm test:*)', 6, 2]], 'rm and git push are never offered; ls was denied once; Edit too few; October is outside the week');
});

test('calendar / streak / totals', () => {
  const days = { '2026-11-10': { ...D.emptyDay(), tools: 40, prompts: 2 }, '2026-11-09': { ...D.emptyDay(), tools: 10 }, '2026-11-07': { ...D.emptyDay(), tools: 1 } };
  const cal = D.calendar(days, T0, 12);
  assert.equal(cal.length, 12); assert.ok(cal.every(c => c.length === 7));
  const flat = cal.flat(), today = flat.find(c => c.day === '2026-11-10');
  assert.equal(today.level, 4); assert.equal(flat.find(c => c.day === '2026-11-09').level, 1); assert.equal(flat.find(c => c.day === '2026-11-08').level, 0);
  assert.equal(cal[11].some(c => c.day === '2026-11-10'), true, 'the last column holds today');
  assert.ok(flat.filter(c => c.future).every(c => c.day > '2026-11-10'));
  assert.equal(D.streak(days, T0), 2);
  assert.equal(D.streak(days, T0 + 86400e3), 2, 'today not started: yesterday still counts');
  assert.equal(D.totals(days, '2026-11-09', '2026-11-10').tools, 50);
});

test('achievements: outcomes, capped at what they need', () => {
  const a = D.achievements({ '2026-11-10': { ...D.emptyDay(), tools: 5, fixes: 12, testPass: 3 }, '2026-11-09': { ...D.emptyDay(), tools: 1 } });
  const by = Object.fromEntries(a.map(x => [x.id, x]));
  assert.deepEqual([by.fix1.done, by.fix10.done, by.fix50.done, by.fix50.have], [true, true, false, 12]);
  assert.deepEqual([by.days5.have, by.streak5.have], [2, 2]);
  assert.ok(a.every(x => !/tool/i.test(x.id)), 'no achievement for the number of tool calls');
});

test('bottleneck: who waits for me now — questions first, parked sessions left out', () => {
  const now = T0, s = (id, o) => ({ id, name: id, status: 'waiting', time: now - 60000, ...o });
  const b = D.bottleneck([s('a'), s('b', { needsInput: true, askSince: now - 5000 }), s('c', { status: 'running' }), s('d', { time: now - 2 * 3600e3 }), s('e', { status: 'done' })], now);
  assert.deepEqual(b.top.map(x => [x.id, x.ask]), [['b', true], ['a', false]]);
  assert.equal(b.count, 2); assert.equal(b.waitingMs, 65000);
});

test('store: a record read twice counts once; the file holds days and nothing else of the record', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ad-daily-')), 'daily.json');
  const st = createDailyStore({ file, now: () => T0 });
  st.load();
  const r = rec(T0, 'a', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hunter2' }, tool_use_id: 't1' });
  assert.equal(st.feed(r), true); assert.equal(st.feed(r), false, 'the same record again (the log re-read)');
  st.save();
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /hunter2|echo/);
  const st2 = createDailyStore({ file, now: () => T0 }); st2.load();
  assert.equal(st2.feed(r), false, 'still known after a restart');
  assert.equal(st2.days()['2026-11-10'].tools, 1);
  assert.equal(st2.feed({ ts: 'x', ev: {} }), false);
});

test('timeline search: masked summaries across sessions, newest first; main and the widget wire the day view', async () => {
  await import('../core/mask.js'); await import('../core/timeline.js');
  const idx = globalThis.AgentDeskTimeline.createIndex({ max: 100, sessions: 10 });
  idx.add({ ts: 100, ev: { session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'run the database migration' } });
  idx.add({ ts: 200, ev: { session_id: 'b', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npx prisma migrate deploy' } } });
  idx.add({ ts: 300, ev: { session_id: 'b', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx prisma migrate deploy' } } });
  const r = idx.search('migrat', 10);
  assert.deepEqual(r.map(x => [x.sid, x.kind]), [['b', 'tool'], ['a', 'prompt']], 'the finished call is not listed twice');
  assert.deepEqual(idx.search('migrate nothing', 10), []);
  assert.deepEqual(idx.search('', 10), []);
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8'), html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8'), pre = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  assert.equal((main.match(/sbFeed\(o\); dailyFeed\(o\);/g) || []).length, 2, 'both log readers feed the daily store (the first read of a launch and the tail)');
  assert.match(main, /ipcMain\.handle\("roca:daily"/); assert.match(main, /ipcMain\.handle\("roca:timeline-search"/); assert.match(main, /ipcMain\.handle\("roca:closing-check"/);
  assert.match(main, /out\.push\(\{ sessionId, files: [^\n]*ahead: await aheadCount\(cwd\) \}\);/, 'the closing check returns counts, never a path');
  for (const k of ['timelineSearch', 'daily', 'closingCheck']) assert.match(pre, new RegExp(`${k}: \\(`));
  assert.match(html, /<script src="core\/play\.js"><\/script>\n<script src="core\/daily\.js"><\/script>/);
  assert.match(html, /AgentDesk 는 규칙을 저장하거나 적용하지 않습니다/, 'allow rules are text to copy');
  assert.match(html, /if \(pomoHold\(\) && ev\.kind !== 'ask'\) \{ pomoHeld\+\+; return; \}/, 'focus time holds alerts, a question still comes through');
  assert.match(html, /if \(c\.status !== 'waiting' \|\| c\.needsInput\) continue;/, 'a schedule never sends into a choice or a permission prompt');
  assert.match(html, /const safe = AgentDeskDock\.dropSafeText\(text\);/, 'a scheduled prompt follows the drop rules (no leading \/ ! #)');
  assert.match(html, /n\.text = AgentDeskMask\.mask\(String\(n\.text \|\| ''\)\);/, 'a leave note is masked before it is stored');
});

test('widget: a top-level statement never reads a let declared further down (the script would stop there)', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  for (const [use, decl] of [["$('pomo-batch').checked = pomoBatch;", 'let pomoBatch = false'], ["$('day-btn').addEventListener('click', dayOpen);", 'const playState = new Map();']]) {
    assert.ok(html.includes(use) && html.includes(decl), use);
  }
  assert.ok(html.indexOf("$('pomo-batch').checked = pomoBatch;") > html.indexOf('let pomoBatch = false'), 'the focus-time checkbox is wired after its state is declared');
});
