// Regression tests for the session-status judgement (core/status.js).
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/status.js');
const S = globalThis.AgentDeskStatus;

const now = Math.floor(Date.now() / 1000);
const claude = (name, extra = {}, ts = now) => ({ ts, ev: { session_id: 'c-1', cwd: '/w/app', transcript_path: '/t/c-1.jsonl', hook_event_name: name, ...extra } });
const gemini = (name, extra = {}, ts = now) => ({ ts, agent: 'gemini', ev: { session_id: 'g-1', cwd: '/w/app', hook_event_name: name, ...extra } });
const codex  = (name, extra = {}, ts = now) => ({ ts, agent: 'codex',  ev: { session_id: 'x-1', cwd: '/w/app', hook_event_name: name, ...extra } });
const fold = (...recs) => { const m = new Map(); for (const r of recs) S.applyHookEvent(r, m); return m; };

test('claude: prompt → tool → stop → waiting, then ages into done', () => {
  const m = fold(claude('SessionStart'), claude('UserPromptSubmit'), claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const st = m.get('c-1');
  assert.equal(st.status, 'running'); assert.equal(st.tool, 'Bash'); assert.equal(st.toolInput, 'npm test'); assert.equal(st.agent, 'claude');
  S.applyHookEvent(claude('Stop'), m);
  assert.equal(st.status, 'waiting'); assert.equal(S.hookStatusFor(st), 'waiting');
  st.since = Date.now() - S.DONE_FRESH_MS - 1000;
  assert.equal(S.hookStatusFor(st), 'done');
});

test('claude: permission prompt and AskUserQuestion mean needs input; PostToolUse clears it', () => {
  const m = fold(claude('UserPromptSubmit'), claude('PermissionRequest'));
  assert.equal(m.get('c-1').needsInput, true); assert.equal(m.get('c-1').status, 'waiting');
  S.applyHookEvent(claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }), m);
  assert.equal(m.get('c-1').needsInput, true);
  S.applyHookEvent(claude('PostToolUse', { tool_name: 'AskUserQuestion' }), m);
  assert.equal(m.get('c-1').needsInput, false); assert.equal(m.get('c-1').status, 'running');
});

test('claude: subagents appear and leave; SessionEnd ends the session', () => {
  const m = fold(claude('UserPromptSubmit'), claude('SubagentStart', { agent_id: 'a1', agent_type: 'explore' }), claude('PreToolUse', { agent_id: 'a1', tool_name: 'Grep', tool_input: { pattern: 'foo' } }));
  const st = m.get('c-1');
  assert.equal(st.subagents.size, 1); assert.equal(st.subagents.get('a1').tool, 'Grep');
  assert.equal(st.status, 'running', 'a subagent tool call must not change the parent tool');
  S.applyHookEvent(claude('SubagentStop', { agent_id: 'a1' }), m); assert.equal(st.subagents.size, 0);
  S.applyHookEvent(claude('SessionEnd'), m); assert.equal(st.ended, true); assert.equal(st.status, 'done');
});

test('gemini: BeforeAgent/BeforeTool/AfterAgent map onto the Claude Code states; ToolPermission needs input', () => {
  const m = fold(gemini('SessionStart', { source: 'startup' }), gemini('BeforeAgent', { prompt: 'hi' }), gemini('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }));
  const st = m.get('g-1');
  assert.equal(st.agent, 'gemini'); assert.equal(st.status, 'running'); assert.equal(st.tool, 'run_shell_command'); assert.equal(st.toolInput, 'ls');
  S.applyHookEvent(gemini('Notification', { notification_type: 'ToolPermission', message: 'allow?' }), m);
  assert.equal(st.needsInput, true);
  S.applyHookEvent(gemini('AfterTool', { tool_name: 'run_shell_command' }), m);
  S.applyHookEvent(gemini('AfterAgent', { prompt_response: 'done' }), m);
  assert.equal(st.status, 'waiting'); assert.equal(st.needsInput, false); assert.equal(st.tool, '');
  S.applyHookEvent(gemini('PreCompress', { trigger: 'auto' }), m);
  assert.equal(st.status, 'waiting', 'PreCompress is informational');
});

test('codex: same event names as Claude Code; Interrupt goes back to waiting', () => {
  const m = fold(codex('SessionStart'), codex('UserPromptSubmit'), codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'pytest' } }));
  const st = m.get('x-1');
  assert.equal(st.agent, 'codex'); assert.equal(st.status, 'running');
  S.applyHookEvent(codex('Interrupt'), m);
  assert.equal(st.status, 'waiting'); assert.equal(st.tool, '');
});

test('records without an agent field default to claude (events written by older hook scripts)', () => {
  const m = fold({ ts: now, ev: { session_id: 'old', cwd: '/w', hook_event_name: 'UserPromptSubmit' } });
  assert.equal(m.get('old').agent, 'claude');
});

test('term (TERM_PROGRAM) is remembered so Orca sessions can be told apart', () => {
  const m = fold({ ts: now, term: 'Orca', ev: { session_id: 'o', cwd: '/w', hook_event_name: 'SessionStart' } });
  assert.equal(m.get('o').term, 'Orca');
});

// ── screen reading ──
const screen = (...l) => l;
test('screen: spinner above the prompt means running', () => {
  assert.equal(S.statusFromScreen(screen('⏺ Reading files', '· Thinking… (4s · ↓ 1.2k tokens)', '', '❯ ')), 'running');
  assert.equal(S.statusFromScreen(screen('✶ Working… esc to interrupt', '❯ ')), 'running');
});
test('screen: a fresh "done" line is waiting, an old or dated one is done', () => {
  const d = new Date(); const hh = d.getHours() % 12 || 12, mm = String(d.getMinutes()).padStart(2, '0'), ap = d.getHours() >= 12 ? 'PM' : 'AM';
  assert.equal(S.statusFromScreen(screen(`✻ Worked for 22s · done ${hh}:${mm} ${ap}`, '', '❯ ')), 'waiting');
  assert.equal(S.statusFromScreen(screen('✻ Worked for 22s · done Thursday 10:28 AM', '❯ ')), 'done');
  assert.equal(S.doneLineStatus('✻ done 오후 3:10'), S.doneLineStatus(`✻ done 15:10`), 'Korean and 24h forms agree');
});
test('screen: numbered choice and permission questions need input; a ⏺ block with no spinner is waiting-untimed', () => {
  assert.equal(S.statusFromScreen(screen('Do you want to proceed?', '❯ 1. Yes', '  2. No')), 'waiting');
  assert.equal(S.screenHasChoice(screen('  ❯ 1. Yes', '    2. No')), true);
  assert.equal(S.screenHasChoice(screen('1. first', '2. second')), false);
  assert.equal(S.statusFromScreen(screen('⏺ Finished the refactor.', '', '❯ ')), 'waiting-untimed');
  assert.equal(S.statusFromScreen(screen('$ ls', 'file.txt')), null, 'no prompt → not a Claude screen');
});
test('screen: subagent panel and context percentage', () => {
  const agents = S.parseAgentPanel(screen('  ⏺ main', '  ◯ explorer  searching the repo…      17s · ↓ 30.5k tokens', '  ◯ writer  docs      idle'));
  assert.equal(agents.length, 2); assert.equal(agents[0].name, 'explorer'); assert.equal(agents[0].state, 'running'); assert.equal(agents[0].tokens, '30.5k'); assert.equal(agents[1].state, 'idle');
  assert.equal(S.parseCtxPct(screen('foo', 'wk:[##------]12% | ctx:[####      --]46% | 🔧3')), 46);
});

// ── priority ──
test('resolveStatus: hooks win, then the screen, then the platform state; error always wins', () => {
  const hk = { status: 'running', since: Date.now() };
  assert.equal(S.resolveStatus('done', 'waiting', hk), 'running');
  assert.equal(S.resolveStatus('done', 'running', null), 'running');
  assert.equal(S.resolveStatus('waiting', 'waiting-untimed', null), 'waiting', 'untimed is decided by the caller, so the base state stays');
  assert.equal(S.resolveStatus('error', 'running', hk), 'error');
});

test('bookkeeping: recent tools, time spent running, needs-input wait time', () => {
  const t0 = now;
  const m = fold(claude('UserPromptSubmit', {}, t0), claude('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t0 + 1), claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, t0 + 2));
  const st = m.get('c-1');
  assert.deepEqual(st.recentTools.map(x => x.tool), ['Read', 'Edit']);
  S.applyHookEvent(claude('PermissionRequest', {}, t0 + 10), m);          // ran 10s, now waiting for the user
  assert.equal(st.runMs, 10000); assert.equal(st.askAt, (t0 + 10) * 1000);
  S.applyHookEvent(claude('PostToolUse', { tool_name: 'Bash' }, t0 + 25), m);   // user answered after 15s
  assert.equal(st.askN, 1); assert.equal(st.askMs, 15000); assert.equal(st.askAt, 0);
  S.applyHookEvent(claude('Stop', {}, t0 + 30), m);
  assert.equal(st.runMs, 15000, 'running again from 25s to 30s');
  for (let i = 0; i < 7; i++) S.applyHookEvent(claude('PreToolUse', { tool_name: 'T' + i, tool_input: {} }, t0 + 40 + i), m);
  assert.equal(st.recentTools.length, 5, 'capped at five');
});

test('loop detection: three failures in a row, or the same tool call three times in ten minutes', () => {
  const t0 = now;
  const m = fold(claude('UserPromptSubmit', {}, t0));
  const st = m.get('c-1');
  assert.equal(S.loopStateFor(st), null);
  for (let i = 0; i < 3; i++) S.applyHookEvent(claude('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, t0 + i), m);
  assert.deepEqual([S.loopStateFor(st).reason, S.loopStateFor(st).count], ['fail', 3]);
  S.applyHookEvent(claude('PostToolUse', { tool_name: 'Bash' }, t0 + 5), m);
  assert.equal(S.loopStateFor(st), null, 'a success resets the failure streak');
  for (let i = 0; i < 3; i++) S.applyHookEvent(claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'x.js' } }, t0 + 10 + i * 60), m);
  const l = S.loopStateFor(st); assert.equal(l.reason, 'repeat'); assert.equal(l.count, 3); assert.equal(l.tool, 'Edit');
  S.applyHookEvent(claude('UserPromptSubmit', {}, t0 + 300), m);
  st.recentTools = []; assert.equal(S.loopStateFor(st), null, 'a new user prompt starts the watch afresh');
});

test('touched files: Edit/Write/NotebookEdit targets relative to cwd, outside cwd → basename, 10-minute window', () => {
  const m = fold(
    claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/w/app/src/Pay.java', old_string: 'SECRET' } }, now - 700),
    claude('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/w/app/README.md' } }, now - 60),
    claude('PostToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/w/app/nb/a.ipynb' } }, now - 30),
    claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/Users/x/.ssh/config' } }, now - 20),
    claude('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/w/app/ignored.txt' } }, now - 10),
    claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/w/app/README.md' } }, now - 5),
  );
  const st = m.get('c-1');
  assert.deepEqual(st.touched.map(x => x.path), ['src/Pay.java', 'nb/a.ipynb', 'config', 'README.md']);
  assert.ok(!JSON.stringify(st.touched).includes('SECRET'));
  assert.deepEqual(S.touchedFiles(st, now * 1000), ['README.md', 'config', 'nb/a.ipynb'], 'newest first, Pay.java is older than 10 minutes');
  assert.deepEqual(S.touchedFiles(st, now * 1000, 60 * 60 * 1000, 2), ['README.md', 'config']);
});

test('relPath: inside cwd, outside cwd, climbing out, already relative', () => {
  assert.equal(S.relPath('/w/app/src/A.java', '/w/app'), 'src/A.java');
  assert.equal(S.relPath('/w/app/src/A.java', '/w/app/'), 'src/A.java');
  assert.equal(S.relPath('/w/apple/A.java', '/w/app'), 'A.java');
  assert.equal(S.relPath('/w/app/../etc/passwd', '/w/app'), 'passwd');
  assert.equal(S.relPath('src/./B.ts', '/w/app'), 'src/B.ts');
  assert.equal(S.relPath('../B.ts', '/w/app'), 'B.ts');
  assert.equal(S.relPath('', '/w/app'), '');
});

test('StopFailure → error status with lastError, distinct from Stop; next prompt recovers', () => {
  const m = fold(claude('UserPromptSubmit'), claude('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' }));
  const st = m.get('c-1');
  assert.equal(st.status, 'error'); assert.equal(S.hookStatusFor(st), 'error'); assert.equal(st.needsInput, false);
  assert.equal(st.lastError.reason, 'API Error: Rate limit reached'); assert.equal(st.lastError.error, 'rate_limit');
  S.applyHookEvent(claude('StopFailure', { error: 'x'.repeat(5), error_details: 'y'.repeat(500) }), m);
  assert.equal(st.lastError.reason.length, 300);
  S.applyHookEvent(claude('UserPromptSubmit'), m);
  assert.equal(st.status, 'running');
});

test('PermissionDenied accumulates (max 20) without changing status', () => {
  const m = fold(claude('UserPromptSubmit'));
  for (let i = 0; i < 25; i++) S.applyHookEvent(claude('PermissionDenied', { tool_name: i === 24 ? 'Bash' : 'Edit' }), m);
  const st = m.get('c-1');
  assert.equal(st.denied.length, 20); assert.equal(st.denied[19].tool, 'Bash'); assert.equal(st.status, 'running');
});

test('TaskCreated / TaskCompleted track progress per task id, separate from subagents', () => {
  const m = fold(claude('TaskCreated', { task_id: 't1', task_subject: 'A' }), claude('TaskCreated', { task_id: 't2', task_subject: 'B' }), claude('TaskCompleted', { task_id: 't1' }), claude('TaskCompleted', { task_id: 't1' }));
  const st = m.get('c-1');
  assert.equal(st.tasks.length, 2); assert.deepEqual(st.tasks.map(t => t.state), ['done', 'open']); assert.equal(st.tasks[0].desc, 'A');
  assert.equal(st.subagents.size, 0);
});

test('PreCompact sets compacting (trigger kept); PostCompact / next tool use / prompt clear it', () => {
  const m = fold(claude('PreCompact', { trigger: 'auto' }));
  const st = m.get('c-1');
  assert.equal(st.compacting, true); assert.equal(st.compactTrigger, 'auto');
  S.applyHookEvent(claude('PostCompact', { trigger: 'auto' }), m); assert.equal(st.compacting, false);
  S.applyHookEvent(claude('PreCompact', { trigger: 'manual' }), m); S.applyHookEvent(claude('PreToolUse', { tool_name: 'Bash' }), m); assert.equal(st.compacting, false);
  S.applyHookEvent(claude('PreCompact'), m); S.applyHookEvent(claude('UserPromptSubmit'), m); assert.equal(st.compacting, false);
});

test('CwdChanged updates cwd; unknown events are ignored', () => {
  const m = fold(claude('UserPromptSubmit'), claude('CwdChanged', { cwd: '/w/app/src', new_cwd: '/w/app/src', old_cwd: '/w/app' }));
  const st = m.get('c-1'); assert.equal(st.cwd, '/w/app/src');
  const before = JSON.stringify([st.status, st.tool, st.needsInput]);
  S.applyHookEvent(claude('SomethingNew'), m);
  assert.equal(JSON.stringify([st.status, st.tool, st.needsInput]), before);
});

test('screenPlan: working screens every tick, waiting every 8 s, finished every 60 / 120 s, never twice at once, a few per tick', () => {
  const S = globalThis.AgentDeskStatus, now = 10_000_000, at = new Map();
  const e = (id, status, quietMs, o = {}) => ({ id, status, lastOut: quietMs == null ? 0 : now - quietMs, ...o });
  assert.deepEqual(S.screenPlan([e('a', 'done', 1000), e('b', 'done', 5 * 60000)], at, now).sort(), ['a', 'b'], 'never read yet: every one');
  for (const id of ['r', 'w', 'q', 'c', 'n']) at.set(id, now - 3000);
  at.set('w9', now - 9000).set('d31', now - 31000).set('d61', now - 61000).set('d90', now - 90000).set('d121', now - 121000).set('x', now - 3000);
  const list = [e('r', 'running', 600000), e('w', 'waiting', 1000), e('w9', 'waiting', 600000), e('q', 'done', 1000), e('c', 'done', 9e6, { choice: true }),
    e('d31', 'done', 1000), e('d61', 'done', 1000), e('d90', 'done', 9e6), e('d121', 'done', 9e6), e('x', undefined, 1000)];
  assert.deepEqual(S.screenPlan(list, at, now, { MAX: 20 }).sort(), ['c', 'd121', 'd61', 'r', 'w9', 'x'],
    'working / a question / no status but printing: every tick; waiting: after 8 s; finished and printing (a redraw): after 60 s; finished and quiet: after 120 s');
  assert.deepEqual(S.screenPlan([e('a', 'running', 1000, { busy: true })], new Map(), now), [], 'a read still running is not started again');
  const many = Array.from({ length: 30 }, (_, i) => e(`s${i}`, 'running', 1000));
  assert.equal(S.screenPlan(many, new Map(), now).length, S.SCREEN_PLAN.MAX, 'thirty working terminals: a few per tick');
  const old = new Map(many.map((x, i) => [x.id, now - 3000 - i]));
  assert.deepEqual(S.screenPlan(many, old, now, { MAX: 2 }), ['s29', 's28'], 'the longest unread first');
  assert.deepEqual(S.screenPlan([e('d', 'done', 9e6), e('r', 'running', 9e6)], new Map([['d', now - 99000], ['r', now - 3000]]), now, { MAX: 1 }), ['r'], 'a working one before a long-unread finished one');
  assert.deepEqual(S.screenPlan(null, null, now), []);
});

test('main: plan limits are asked of Orca at most every 30 s (one process per call)', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(main, /const RATE_TTL_MS = 30000;/);
  assert.match(main, /if \(rateCache\.res && Date\.now\(\) - rateCache\.at < RATE_TTL_MS\) return rateCache\.res;/);
  assert.match(main, /else rateCache\.run = null; return res;/, 'a failed call is not cached');
});

test('main: slow-changing answers are cached (terminal list 10 s, process scan 10 s, tmux 3 s, repos 60 s) and dropped when this app opens or closes a terminal', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(main, /const terminalsCached = cached\(10000, \(\) => orca\("terminal", "list"\)\);/);
  assert.match(main, /const reposCached = cached\(60000, \(\) => orca\("repo", "list"\)\);/);
  assert.match(main, /const ttyCached = cached\(10000, \(\) => ttyTargets\(\)\);/);
  assert.match(main, /const panesCached = cached\(3000, \(\) => tmuxPanes\(\)\);/);
  assert.match(main, /if \(v && v\.ok !== false\) \{ val = v; at = Date\.now\(\); \}/, 'a failed answer is not kept');
  assert.match(main, /cacheDrop\(\);\n  return orca\("terminal", "close", "--terminal", handle\);/);
  assert.ok((main.match(/cacheDrop\(\)/g) || []).length >= 5, 'every open / close path forgets the lists');
  assert.match(main, /ipcMain\.handle\("orca:ps", \(\) => orca\("worktree", "ps"\)\);/, 'the worktree list (the status source) is still read every poll');
});
