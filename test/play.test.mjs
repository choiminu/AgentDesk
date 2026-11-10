// core/play.js — the dock's play layer: test-failure boss, file clashes, context fatigue, jobs, replay, leave notes.
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../core/play.js');
const P = globalThis.AgentDeskPlay;

let clock = 1000;
const rec = (sid, name, extra = {}) => ({ ts: clock++, ev: { session_id: sid, cwd: `/w/${sid}`, hook_event_name: name, ...extra } });
const tool = (sid, name, tool_name, tool_input = {}, extra = {}) => rec(sid, name, { tool_name, tool_input, ...extra });

test('kindOf: the tool picks the activity kind; a skill and an MCP tool have their own', () => {
  assert.equal(P.kindOf('Edit', 'src/a.ts'), 'code');
  assert.equal(P.kindOf('Write', 'docs/guide.md'), 'docs');
  assert.equal(P.kindOf('Grep'), 'read');
  assert.equal(P.kindOf('WebSearch'), 'web');
  assert.equal(P.kindOf('Bash'), 'shell');
  assert.equal(P.kindOf('Task'), 'agents');
  assert.equal(P.kindOf('Skill'), 'skill');
  assert.equal(P.kindOf('mcp__slack__send'), 'mcp');
  assert.equal(P.kindOf('TodoWrite'), 'think');
  assert.equal(P.kindOf(null), 'think');
});

test('isTestCmd / failCount: test runners and how many tests their output says failed', () => {
  for (const c of ['npm test', 'cd app && npm run test -- --watch=false', 'node --test test/', 'pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo test', './gradlew :app:test', 'npx vitest run', 'make test']) assert.equal(P.isTestCmd(c), true, c);
  for (const c of ['ls test/', 'cat test.txt', 'git commit -m "add tests"', 'npm install', 'echo pytestish', '', 'git commit -m "fix npm test"', "node run.mjs 'npm test'", 'cat > x.sh <<EOF\nnpm test\nEOF']) assert.equal(P.isTestCmd(c), false, c);
  assert.equal(P.failCount('ℹ tests 834\nℹ pass 830\nℹ fail 3\n'), 3);
  assert.equal(P.failCount('# tests 12\n# fail 2'), 2);
  assert.equal(P.failCount('Tests:       2 failed, 40 passed, 42 total'), 2);
  assert.equal(P.failCount('===== 5 failed, 20 passed in 1.2s ====='), 5);
  assert.equal(P.failCount('Tests run: 10, Failures: 4, Errors: 0'), 4);
  assert.equal(P.failCount('--- FAIL: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\n'), 3);
  assert.equal(P.failCount('ℹ pass 10\nℹ fail 0'), 0);
  assert.equal(P.failCount('all good'), 0);
});

test('boss: a failed test run raises it with the failing count as hp, a passing run brings it down', () => {
  const m = new Map();
  P.feed(m, tool('a', 'PreToolUse', 'Bash', { command: 'npm test' }));
  let ps = P.feed(m, tool('a', 'PostToolUseFailure', 'Bash', { command: 'npm test' }, { error: 'Exit code 1\nℹ fail 4' }));
  assert.deepEqual([ps.boss.hp, ps.boss.max, ps.boss.downAt], [4, 4, 0]);
  ps = P.feed(m, tool('a', 'PostToolUseFailure', 'Bash', { command: 'npm test' }, { error: 'Exit code 1\nℹ fail 1' }));
  assert.deepEqual([ps.boss.hp, ps.boss.max], [1, 4], 'hp follows the last run, max stays');
  ps = P.feed(m, tool('a', 'PostToolUseFailure', 'Bash', { command: 'ls nope' }, { error: 'Exit code 1' }));
  assert.equal(ps.boss.hp, 1, 'another failing command is not a test run');
  ps = P.feed(m, tool('a', 'PostToolUse', 'Bash', { command: 'npm test' }, { tool_response: { stdout: 'ℹ pass 9\nℹ fail 0' } }));
  assert.equal(ps.boss.hp, 0);
  assert.ok(ps.boss.downAt > 0);
  assert.deepEqual(ps.tests, { pass: 1, fail: 2 });
  ps = P.feed(m, tool('a', 'PostToolUseFailure', 'Bash', { command: 'pytest' }, { error: 'no summary' }));
  assert.deepEqual([ps.boss.hp, ps.boss.max, ps.boss.downAt], [1, 1, 0], 'a new boss; unknown count = 1');
  ps = P.feed(m, tool('a', 'PostToolUseFailure', 'Bash', { command: 'pytest' }, { error: '9 failed', is_interrupt: true }));
  assert.equal(ps.boss.hp, 1, 'an interrupted run does not count');
  P.feed(m, tool('b', 'PostToolUseFailure', 'Bash', { command: 'npm test' }, { error: 'ℹ fail 2', agent_id: 'sub1' }));
  assert.equal(m.get('b').boss, null, 'a subagent\'s run is not the session\'s boss');
});

test('jobOf: a kind with 40 % of 12+ tool calls names the job; the level doubles with the work', () => {
  assert.equal(P.jobOf({ shell: 11 }), null, 'not enough yet');
  assert.deepEqual(P.jobOf({ shell: 12 }), { id: 'hacker', kind: 'shell', level: 1, total: 12 });
  assert.equal(P.jobOf({ read: 30, code: 10 }).id, 'scholar');
  assert.equal(P.jobOf({ read: 30, code: 10 }).level, 2);
  assert.equal(P.jobOf({ mcp: 50 }).id, 'operator');
  assert.equal(P.jobOf({ skill: 20, read: 5 }).id, 'mage');
  assert.equal(P.jobOf({ code: 5, read: 5, shell: 5, web: 5 }), null, 'no kind stands out');
  assert.equal(P.jobOf({ code: 100000 }).level, 9);
  assert.equal(P.jobOf(null), null);
});

test('feed: counts and trail from the main agent\'s tools; failures mark the trail', () => {
  const m = new Map();
  P.feed(m, tool('a', 'PreToolUse', 'Read', { file_path: 'a.js' }));
  P.feed(m, tool('a', 'PreToolUse', 'Edit', { file_path: 'a.js' }));
  P.feed(m, tool('a', 'PostToolUseFailure', 'Edit', { file_path: 'a.js' }, { error: 'x' }));
  P.feed(m, tool('a', 'PreToolUse', 'Grep', {}, { agent_id: 'sub' }));
  P.feed(m, tool('a', 'PreToolUse', 'TodoWrite'));
  const ps = m.get('a');
  assert.deepEqual(ps.counts, { read: 1, code: 1 });
  assert.equal(ps.total, 2);
  assert.deepEqual(ps.trail, [{ k: 'read', f: 0 }, { k: 'code', f: 1 }, { k: 'think', f: 0 }]);
  assert.equal(P.feed(m, { ts: 1, ev: { hook_event_name: 'PreToolUse' } }), null, 'no session id');
  assert.equal(P.feed(m, null), null);
});

test('clashes: two live sessions changed the same file inside the window', () => {
  const m = new Map(), at = t => ({ ts: t / 1000 });
  const edit = (sid, cwd, file, t) => P.feed(m, { ...at(t), ev: { session_id: sid, cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } } });
  edit('a', '/repo', 'src/x.js', 100000);
  edit('b', '/repo', '/repo/src/x.js', 160000);
  edit('c', '/other', 'src/x.js', 160000);
  assert.deepEqual(P.clashes(m, 200000, 300000).map(c => [c.path, c.sids]), [['/repo/src/x.js', ['a', 'b']]], 'the same relative path in another folder is another file');
  assert.deepEqual(P.clashes(m, 500000, 300000), [], 'outside the window');
  m.get('b').ended = true;
  assert.deepEqual(P.clashes(m, 200000, 300000), [], 'an ended session does not clash');
});

test('fatigue: sweat from 70 % of the context, coffee while compacting', () => {
  assert.equal(P.fatigue(69, false), '');
  assert.equal(P.fatigue(70, false), 'sweat');
  assert.equal(P.fatigue(95, true), 'coffee');
  assert.equal(P.fatigue(null, false), '');
  const m = new Map();
  assert.equal(P.feed(m, rec('a', 'PreCompact')).compacting, true);
  const ps = P.feed(m, rec('a', 'PostCompact'));
  assert.equal(ps.compacting, false);
  assert.ok(ps.revivedAt > 0);
});

test('replaySteps: runs of one kind fold, a long trail thins to the cap and keeps failures', () => {
  assert.deepEqual(P.replaySteps([{ k: 'read', f: 0 }, { k: 'read', f: 0 }, { k: 'code', f: 0 }, { k: 'shell', f: 1 }, { k: 'shell', f: 0 }], 40),
    [{ k: 'read', fail: false, n: 2 }, { k: 'code', fail: false, n: 1 }, { k: 'shell', fail: true, n: 1 }, { k: 'shell', fail: false, n: 1 }]);
  const long = Array.from({ length: 300 }, (_, i) => ({ k: i % 2 ? 'read' : 'code', f: i === 151 ? 1 : 0 }));
  const steps = P.replaySteps(long, 40);
  assert.ok(steps.length <= 42, String(steps.length));
  assert.ok(steps.some(s => s.fail), 'the failed step survives the thinning');
  assert.deepEqual(P.replaySteps(null, 40), []);
});

test('noteOf: what an ended session leaves — its last prompt, files changed, tool calls, test runs', () => {
  const m = new Map();
  P.feed(m, rec('a', 'UserPromptSubmit', { prompt: '  로그인   버그 고쳐줘 ' }));
  P.feed(m, rec('a', 'UserPromptSubmit', { prompt: '<command-name>/model</command-name>' }));
  P.feed(m, tool('a', 'PreToolUse', 'Edit', { file_path: 'a.js' }));
  P.feed(m, tool('a', 'PostToolUse', 'Edit', { file_path: 'a.js' }));
  P.feed(m, tool('a', 'PostToolUse', 'Edit', { file_path: 'a.js' }));
  const ps = P.feed(m, rec('a', 'SessionEnd'));
  assert.equal(ps.ended, true);
  const n = P.noteOf(ps);
  assert.deepEqual([n.sid, n.cwd, n.text, n.edits, n.tools], ['a', '/w/a', '로그인 버그 고쳐줘', 1, 1]);
  assert.equal(P.noteOf(P.feed(m, rec('z', 'SessionEnd'))), null, 'a session that did nothing leaves no note');
});

test('widget: loads core/play.js, feeds it every hook record, and draws the play marks with the tiles', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="core\/dock\.js"><\/script>\n<script src="core\/play\.js"><\/script>/);
  assert.match(html, /dockNoteFrom\(rec, AgentDeskPlay\.feed\(playState, rec\)\)/, 'live records: fed, and an ended session leaves its note');
  assert.equal((html.match(/questSkillNote\(rec\); AgentDeskPlay\.feed\(playState, rec\); \}/g) || []).length, 2, 'both replays of the recent log feed it (no notes from a replay)');
  assert.match(html, /hookSessions\.clear\(\); playState\.clear\(\);/);
  assert.match(html, /function dockFxSync\(changes\) \{\n  dockCastSync\(\);\n  dockPlaySync\(\);/, 'the marks are plain DOM: put back before the animation check');
  assert.match(html, /for \(const \[kind, on\] of \[\['boss', b\.dataset\.boss === '1'\], \['sweat', b\.dataset\.tired === 'sweat'\], \['coffee', b\.dataset\.tired === 'coffee'\]\]\)/);
  assert.match(html, /const DOCK_JOBS = \['hacker', 'scholar', 'smith', 'scribe', 'explorer', 'commander', 'mage', 'operator'\];/, 'the hat sheet\'s frame order');
  for (const id of Object.values(P.JOBS)) assert.match(html, new RegExp(`${id}: '도크: `), `${id} has a label`);
  assert.match(html, /if \(ev\.reason === 'clear'\) return;/, '/clear leaves no note');
  assert.match(html, /localStorage\.setItem\('roca-notes'/);
  assert.match(html, /data-key="note:me"/);
  assert.match(html, /\(x\.peer \? '' : dockPlayTip\(x\)\)/, 'play lines only on my own tiles');
  assert.match(html, /dockCfg\.play = c\.play !== false;/, 'the play marks can be turned off');
  assert.match(html, /const boss = play \? dockBossOf\(ps, now\) : null;/);
  assert.match(html, /if \(k < cl\.otherKey\) dockWarnHint\(/, 'a file clash is a warning (yellow pill), not a skill note, and not a play mark');
  assert.doesNotMatch(html, /\.dock-tile:has\(\.dock-clash\)/, 'yellow borders stay the approval colour');
  assert.match(html, /\(x\.peer \? '' : dockClashTip\(x\)\)\n\s+\+ \(now \?/, 'the clash line comes first in the quick card');
  const hats = readFileSync(new URL('../scripts/office-fx/job-hats.js', import.meta.url), 'utf8');
  assert.equal((hats.match(/\{ pal: /g) || []).length, 8);
});
