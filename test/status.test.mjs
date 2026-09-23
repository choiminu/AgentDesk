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
