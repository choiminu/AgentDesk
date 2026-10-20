// Session timeline: core/timeline.js (hook records → masked entries → per-session index → timeline model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/mask.js');
await import('../core/timeline.js');
const T = globalThis.AgentDeskTimeline;

const SID = 'sess-1';
// one hook record as hook.sh writes it (ts in seconds)
const rec = (ts, name, ev = {}) => ({ ts, term: 'Orca', agent: 'claude', ev: { session_id: SID, cwd: '/w/app', hook_event_name: name, ...ev } });
const entries = recs => recs.map(T.entryFromRecord).filter(Boolean);
const model = (recs, opts) => T.buildModel(entries(recs), opts);
const tools = m => m.events.filter(e => e.kind === 'tool');

test('Pre/Post pair by tool_use_id, even when two calls of the same tool overlap', () => {
  const m = model([
    rec(100, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' } }),
    rec(101, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'pwd' } }),
    rec(103, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' }),
    rec(108, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'b', error: 'exit 1' }),
  ]);
  const [a, b] = tools(m);
  assert.equal(a.detail, 'ls'); assert.equal(a.dur, 3000); assert.equal(a.ok, true);
  assert.equal(b.detail, 'pwd'); assert.equal(b.dur, 7000); assert.equal(b.ok, false); assert.equal(b.err, 'exit 1');
  assert.equal(m.stats.toolCalls, 2); assert.equal(m.stats.toolFails, 1);
});

test('Pre/Post without tool_use_id: same tool, nearest Pre; an unpaired Pre stays open; out-of-order Post pairs', () => {
  const m = model([
    rec(100, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/w/app/a.js' } }),
    rec(101, 'PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'foo' } }),
    rec(104, 'PostToolUse', { tool_name: 'Read' }),
    rec(106, 'PostToolUse', { tool_name: 'Grep' }),
    rec(110, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 99' } }),   // never finished
    // logged out of order: the Post line comes first (async hooks)
    rec(120, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1' }),
    rec(119, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'x.js', old_string: 'a', new_string: 'b\nc' } }),
    rec(130, 'PostToolUse', { tool_name: 'Write' }),                                      // Pre rotated away
  ]);
  const t = tools(m);
  const by = n => t.find(e => e.label === n);
  assert.equal(by('Read').dur, 4000); assert.equal(by('Grep').dur, 5000);
  assert.equal(by('Bash').open, true); assert.equal(by('Bash').dur, undefined);
  assert.equal(by('Edit').dur, 1000); assert.equal(by('Edit').detail, 'x.js (+2 -1)');
  assert.equal(by('Write').orphan, true); assert.equal(by('Write').at, 130000);
  // same second, Post written before Pre: still one call with zero length
  const m2 = model([rec(200, 'PostToolUse', { tool_name: 'Glob' }), rec(200, 'PreToolUse', { tool_name: 'Glob', tool_input: { pattern: '*.js' } })]);
  assert.equal(tools(m2).length, 1); assert.equal(tools(m2)[0].dur, 0); assert.equal(tools(m2)[0].detail, '*.js');
});

test('subagent intervals: start→stop, open one runs to the span end, rows packed; their tool calls carry sub', () => {
  const m = model([
    rec(100, 'UserPromptSubmit', { prompt: 'go' }),
    rec(101, 'SubagentStart', { agent_id: 's1', agent_type: 'explore' }),
    rec(102, 'SubagentStart', { agent_id: 's2', agent_type: 'executor' }),
    rec(103, 'PreToolUse', { agent_id: 's1', tool_name: 'Read', tool_input: { file_path: 'a' } }),
    rec(104, 'PostToolUse', { agent_id: 's1', tool_name: 'Read' }),
    rec(110, 'SubagentStop', { agent_id: 's1', agent_type: 'explore' }),
    rec(111, 'SubagentStart', { agent_id: 's3', agent_type: 'verifier' }),
    rec(120, 'Stop'),
  ]);
  const s = Object.fromEntries(m.subs.map(x => [x.sub, x]));
  assert.deepEqual([s.s1.start, s.s1.end, s.s1.open], [101000, 110000, false]);
  assert.equal(s.s2.open, true); assert.equal(s.s2.end, 120000);
  assert.equal(s.s1.row, 0); assert.equal(s.s2.row, 1); assert.equal(s.s3.row, 0);   // s3 starts after s1 ended
  assert.equal(m.stats.subagents, 3);
  assert.equal(tools(m)[0].sub, 's1');
  assert.equal(m.events.find(e => e.kind === 'subagent' && e.state === 'stop').dur, 9000);
});

test('user wait (Stop → next prompt) and approval wait (PermissionRequest → next Pre/Post), denied state', () => {
  const m = model([
    rec(100, 'UserPromptSubmit', { prompt: 'a' }),
    rec(101, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x' } }),
    rec(101, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }),
    rec(131, 'PostToolUse', { tool_name: 'Bash' }),
    rec(140, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'y' } }),
    rec(141, 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'y' } }),
    rec(151, 'PermissionDenied', { tool_name: 'Write', reason: 'no' }),
    rec(160, 'Stop'),
    rec(400, 'UserPromptSubmit', { prompt: 'b' }),
    rec(410, 'StopFailure', { error: 'rate_limit' }),
  ]);
  const perms = m.events.filter(e => e.kind === 'permission');
  assert.deepEqual(perms.map(p => [p.state, p.dur]), [['allowed', 30000], ['denied', 10000]]);
  assert.deepEqual(m.waits.map(w => [w.kind, w.end - w.start]), [['perm', 30000], ['perm', 10000], ['user', 240000]]);
  assert.equal(m.waits[0].i, m.events.indexOf(perms[0]));
  assert.equal(m.stats.userWaitMs, 240000); assert.equal(m.stats.permWaitMs, 40000); assert.equal(m.stats.turns, 2);
  assert.equal(m.events.at(-1).kind, 'stop-failure'); assert.equal(m.events.at(-1).detail, 'rate_limit');
});

test('stats: per-tool counts, time and failures; the five slowest calls', () => {
  const recs = [];
  for (let i = 0; i < 7; i++) { recs.push(rec(100 + i * 100, 'PreToolUse', { tool_name: i % 2 ? 'Bash' : 'Read', tool_use_id: `t${i}`, tool_input: { command: 'x', file_path: 'f' } })); recs.push(rec(100 + i * 100 + i + 1, i === 3 ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: i % 2 ? 'Bash' : 'Read', tool_use_id: `t${i}` })); }
  const m = model(recs);
  const by = Object.fromEntries(m.stats.byTool.map(x => [x.tool, x]));
  assert.deepEqual([by.Read.n, by.Read.ms, by.Read.fail], [4, (1 + 3 + 5 + 7) * 1000, 0]);
  assert.deepEqual([by.Bash.n, by.Bash.ms, by.Bash.fail], [3, (2 + 4 + 6) * 1000, 1]);
  assert.deepEqual(m.stats.slowest.map(i => m.events[i].dur), [7000, 6000, 5000, 4000, 3000]);
});

test('2,000 cap: the oldest entries go first and truncated is set (model and index)', () => {
  const recs = [];
  for (let i = 0; i < 2100; i++) recs.push(rec(1000 + i, 'Stop'));
  const m = model(recs);
  assert.equal(m.events.length, 2000); assert.equal(m.truncated, true); assert.equal(m.noEarlier, true);
  assert.equal(m.span.start, (1000 + 100) * 1000);
  const idx = T.createIndex({ max: 2000, sessions: 2 });
  for (const r of recs) idx.add(r);
  const got = idx.get(SID);
  assert.equal(got.entries.length, 2000); assert.equal(got.truncated, true); assert.equal(got.entries[0].at, 1100000);
  // least recently updated session is evicted past the session cap
  idx.add({ ts: 1, ev: { session_id: 'b', hook_event_name: 'Stop' } });
  idx.add({ ts: 1, ev: { session_id: 'c', hook_event_name: 'Stop' } });
  assert.equal(idx.get(SID), null); assert.equal(idx.size(), 2);
  idx.clear(); assert.equal(idx.size(), 0);
  // a log that starts with SessionStart has nothing missing
  assert.equal(model([rec(1, 'SessionStart', { source: 'startup' }), rec(2, 'Stop')]).noEarlier, false);
});

test('details are masked and cut to 120 characters (prompts, tool inputs, failure reasons)', () => {
  const secret = 'sk-ant-' + 'A'.repeat(40);
  const [p, b, f] = entries([
    rec(1, 'UserPromptSubmit', { prompt: `use token=${'x'.repeat(30)} and ${secret}` }),
    rec(2, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${'y'.repeat(40)}" mysql://u:p@db/x ` + 'z'.repeat(300) } }),
    rec(3, 'StopFailure', { error_details: `failed for card 4111 1111 1111 1111 mail a@b.co` }),
  ]);
  for (const e of [p, b, f]) { assert.ok(!/xxxxxx|AAAAAAAA|yyyyyy|4111|a@b\.co|db\/x/.test(e.detail), e.detail); assert.ok(e.detail.length <= 120); }
  assert.match(p.detail, /\[MASKED\]/); assert.match(b.detail, /Bearer \[MASKED\]/); assert.match(f.detail, /\[MASKED NUMBER\]/);
  assert.ok(b.detail.endsWith('…'));
  // control and bidi characters never reach the renderer
  assert.equal(T.toolSummary('Bash', { command: 'echo‮evil\u0007' }), 'echo evil');
  assert.equal(T.toolSummary('Grep', { pattern: 'foo', path: 'src' }), 'foo · src');
  assert.equal(T.toolSummary('mcp__x__y', { q: 1 }), '{"q":1}');
});

test('unknown events, records without a session or a timestamp are ignored', () => {
  assert.equal(T.entryFromRecord(rec(1, 'Notification', { notification_type: 'idle_prompt' })), null);
  assert.equal(T.entryFromRecord(rec(1, 'CwdChanged', { new_cwd: '/x' })), null);
  assert.equal(T.entryFromRecord(rec(1, 'SomethingNew')), null);
  assert.equal(T.entryFromRecord({ ts: 1, ev: { hook_event_name: 'Stop' } }), null);
  assert.equal(T.entryFromRecord({ ev: { session_id: 'a', hook_event_name: 'Stop' } }), null);
  assert.equal(T.entryFromRecord(null), null);
  const m = T.buildModel([{ at: 1000, e: 'Bogus' }, null, { at: NaN, e: 'Stop' }, { at: 2000, e: 'Stop' }]);
  assert.equal(m.events.length, 1);
  // Gemini names map to the Claude Code set
  assert.equal(T.entryFromRecord({ ts: 5, agent: 'gemini', ev: { session_id: 'g', hook_event_name: 'BeforeAgent', prompt: 'hi' } }).e, 'UserPromptSubmit');
  const empty = T.buildModel([]);
  assert.deepEqual([empty.events.length, empty.span.start, empty.stats.toolCalls], [0, 0, 0]);
});
