// Slack front desk routing: what the dispatcher may see (inboxContext) and where a request goes (inboxTarget), core/outbound.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
await import('../core/mask.js');
await import('../core/outbound.js');
// a made-up bot token for the masking checks, put together at run time so secret scanners do not take it for a real one
const FAKE_BOT_TOKEN = ['xox' + 'b', '0000000000-0000000000-FAKEFAKEFAKEFAKE'].join('-');
const O = globalThis.AgentDeskOutbound;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const WS = [{ value: 'id:repo-1', kind: 'orca', label: 'api-server' }, { value: '/tmp/proj', kind: 'folder', label: '/tmp/proj' }];

test('inboxTarget: the thread\'s session first, then the matched one, then a new session, then the fallback, else hold', () => {
  const live = ['s1', 's2', 's3'];
  assert.deepEqual(O.inboxTarget({ sessionId: 's2', workspace: 'id:repo-1' }, { threadSid: 's1', liveIds: live, workspaces: WS }), { kind: 'session', sid: 's1', why: 'thread' });
  assert.deepEqual(O.inboxTarget({ sessionId: 's2', workspace: 'id:repo-1' }, { threadSid: 'gone', liveIds: live, workspaces: WS }), { kind: 'session', sid: 's2', why: 'match' });
  assert.deepEqual(O.inboxTarget({ sessionId: null, workspace: '/tmp/proj' }, { liveIds: live, workspaces: WS, fallbackSid: 's3' }), { kind: 'new', workspace: WS[1] });
  assert.deepEqual(O.inboxTarget({ sessionId: 'gone', workspace: '/not/offered' }, { liveIds: live, workspaces: WS, fallbackSid: 's3' }), { kind: 'session', sid: 's3', why: 'fallback' });
  assert.deepEqual(O.inboxTarget({ sessionId: null, workspace: null }, { liveIds: live, workspaces: WS, fallbackSid: 'gone' }), { kind: 'hold' });
  assert.deepEqual(O.inboxTarget(null, null), { kind: 'hold' });
});

test('inboxTarget: an ended session that matches is reopened; slackChoice reads a bare option number only', () => {
  assert.deepEqual(O.inboxTarget({ sessionId: 'e1' }, { liveIds: ['s1'], endedIds: ['e1'], workspaces: WS }), { kind: 'resume', sid: 'e1' });
  assert.deepEqual(O.inboxTarget({ sessionId: 'e1' }, { threadSid: 's1', liveIds: ['s1'], endedIds: ['e1'] }), { kind: 'session', sid: 's1', why: 'thread' });
  assert.deepEqual(['2', '2번', ' 3. ', '1!', '10', '0', '2 하고 진행', 'y', ''].map(O.slackChoice), [2, 2, 3, 1, 0, 0, 0, 0, 0]);
});

test('inboxContext: known fields only, masked and cut; bad workspaces dropped', () => {
  const c = O.inboxContext({
    sessions: [
      { id: 's1', name: 'api', repo: 'api-server', branch: 'fix/login', status: 'running', prompt: 'use ' + FAKE_BOT_TOKEN + ' then ' + 'x'.repeat(1000), secret: 'no', handle: 'term:1' },
      { name: 'no id' }, null,
    ],
    workspaces: [WS[0], { value: '-rf', kind: 'folder' }, { value: '/x', kind: 'other' }, { value: '/tmp/proj', kind: 'folder' }],
  });
  assert.equal(c.sessions.length, 1);
  assert.deepEqual(Object.keys(c.sessions[0]).sort(), ['branch', 'id', 'name', 'prompt', 'repo', 'status']);
  assert.doesNotMatch(c.sessions[0].prompt, /FAKEFAKEFAKEFAKE/);
  assert.ok(c.sessions[0].prompt.length <= 300);
  assert.deepEqual(c.workspaces.map(w => w.value), ['id:repo-1', '/tmp/proj']);
  assert.ok(c.at > 0);
});

test('wiring: bridge offers sessions and workspaces, widget routes with inboxTarget and loads core/outbound.js', () => {
  const desk = readFileSync(join(root, 'recall/slack-desk.mjs'), 'utf-8');
  assert.match(desk, /SESSIONS: \$\{JSON\.stringify\(shown\.sessions\)\}/);
  // the thread's place is added after masking (a masked ts made slack_read_thread fail) and only when well-formed
  assert.match(desk, /input: mask\(input\) \+ \(ref \?/);
  assert.match(desk, /\/\^\[A-Z0-9\]\{5,20\}\$\/\.test\(threadRef\.channel\)/);
  // the front desk may only look things up: no tool that creates, edits, moves or comments
  const tools = desk.slice(desk.indexOf('const DESK_TOOLS'), desk.indexOf('].join(" ")'));
  assert.match(tools, /searchJiraIssuesUsingJql/);
  assert.doesNotMatch(tools, /create|edit|update|transition|comment|add|delete|send|execute/i);
  const bridge = readFileSync(join(root, 'recall/slack-bridge.mjs'), 'utf-8');
  assert.match(bridge, /d\.action === "lookup" \|\| d\.action === "clarify"/);
  // nowhere to go is a question back, never a silent hold
  assert.match(desk, /d\.action === "work" && !d\.sessionId && !d\.workspace\) \|\| \(d\.action === "control"/);
  assert.match(bridge, /kind: "control", op: d\.op, input: d\.input/);
  assert.match(desk, /enum: \["lookup", "work", "control", "clarify"\]/);
  assert.match(desk, /enum: \["interrupt", "screen", "send", "close", "resume", "none"\]/);
  const w = readFileSync(join(root, 'widget.html'), 'utf-8');
  assert.match(w, /<script src="core\/outbound\.js"><\/script>/);
  assert.match(w, /AgentDeskOutbound\.inboxTarget\(task,/);
  assert.match(w, /task\.kind === 'control'\) inboxControl\(task\)/);
  // Slack requests pass the guardrail first; a flagged one runs only for the owner
  assert.match(w, /if \(!await inboxGuard\(task, \[task\.text, task\.prompt\]\)\) return;/);
  assert.match(w, /if \(!await inboxGuard\(task, \[input\]\)\) return;/);
  assert.match(w, /if \(task\.fromOwner\)/);
  // an option number is sent only while the same question is still on screen
  assert.match(w, /if \(!now\.parsed \|\| now\.sig !== sig\) throw/);
  assert.match(bridge, /const fromOwner = !!cfg\.owner && ev\.user === cfg\.owner;/);
  const main = readFileSync(join(root, 'main.mjs'), 'utf-8');
  assert.match(main, /AgentDeskOutbound\.inboxContext\(ctx\)/);
});

test('aliasContext: the dispatcher sees s1/w1, never ids the masker would cut; aliases map back to the real ids', async () => {
  const { aliasContext } = await import('../recall/slack-desk.mjs').catch(() => ({}));
  if (!aliasContext) return;   // recall/ dependencies (mongodb) not installed in this checkout
  const ctx = { sessions: [{ id: 'f31ab32a-a6ab-4086-b945-191550633665::/home/x/proj', name: 'main' }], workspaces: [{ value: 'id:f31ab32a-a6ab-4086-b945-191550633665', kind: 'orca', label: 'proj' }] };
  const { shown, real } = aliasContext(ctx);
  assert.equal(shown.sessions[0].id, 's1'); assert.equal(shown.workspaces[0].value, 'w1');
  assert.equal(real.s.s1, ctx.sessions[0].id); assert.equal(real.w.w1, ctx.workspaces[0].value);
  assert.doesNotMatch(JSON.stringify(shown), /191550633665/);
});
