// core/discover.js — agent sessions found in the process list without hooks ("detected" cards), and the hand-over
// of a detected card's id-keyed state when a hook card takes the same process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
await import('../core/discover.js');
const D = globalThis.AgentDeskDiscover;

test('isInteractiveAgentCmd: TUI runs yes, headless / helper runs no', () => {
  const rows = [
    ['claude', true],
    ['claude --resume 0f1e2d3c-aaaa-bbbb-cccc-000000000000', true],
    ['/Users/me/.local/bin/claude --model opus', true],
    ['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', false],   // no agent binary name
    ['node /opt/bin/claude', true],
    ['codex resume 0199aaaa-bbbb', true],
    ['gemini', true],
    ['claude -p "summarize"', false],
    ['claude --print hi', false],
    ['claude --print=json', false],
    ['claude mcp serve', false],
    ['/Users/me/.local/bin/claude --chrome-native-host', false],
    ['codex exec "fix the build"', false],
    ['gemini --prompt "x"', false],
    ['vim claude.md', false],
    ['', false],
  ];
  for (const [cmd, want] of rows) assert.equal(D.isInteractiveAgentCmd(cmd), want, cmd);
});

const proc = (pid, cwd, extra = {}) => ({ pid, cwd, agent: 'claude', sessionId: null, cmd: 'claude', handle: `term:${pid}`, drivable: true, ...extra });

test('procSessions: no hooks → one card per process, id from session id or pid', () => {
  const out = D.procSessions({ procs: [proc(11, '/w/a'), proc(12, '/w/b', { sessionId: 'abcd1234ef', cmd: 'claude --resume abcd1234ef' })], hookOnly: [], wts: [] });
  assert.deepEqual(out.map(x => x.id), ['proc:claude:11::/w/a', 'proc:claude:abcd1234ef::/w/b']);
  assert.equal(out[0].handle, 'term:11');
});

test('procSessions: a non-drivable process is listed read-only (handle null)', () => {
  const out = D.procSessions({ procs: [proc(21, '/w/a', { handle: null, drivable: false })] });
  assert.equal(out.length, 1); assert.equal(out[0].handle, null);
});

test('procSessions: a process a hook card already holds (same pid) is left out', () => {
  const hookOnly = [{ id: 'hook:s1::/w/a', st: { sid: 's1' }, pane: proc(11, '/w/a') }];
  assert.deepEqual(D.procSessions({ procs: [proc(11, '/w/a'), proc(12, '/w/a')], hookOnly }).map(x => x.proc.pid), [12]);
});

test('procSessions: a resumed process whose session id has a hook card is left out', () => {
  const hookOnly = [{ id: 'hook:abcd1234ef::/w/a', st: { sid: 'abcd1234ef' }, pane: null }];
  const out = D.procSessions({ procs: [proc(11, '/w/a', { sessionId: 'abcd1234ef' })], hookOnly });
  assert.equal(out.length, 0);
});

test('procSessions: a folder with a live Orca worktree terminal is left out (exact path only)', () => {
  const wts = [{ worktreeId: 'u1::/w/orca/', liveTerminalCount: 1 }, { worktreeId: 'u2::/w', liveTerminalCount: 1 }, { worktreeId: 'u3::/w/idle', liveTerminalCount: 0 }];
  const out = D.procSessions({ procs: [proc(1, '/w/orca'), proc(2, '/w/x'), proc(3, '/w/idle')], wts });
  assert.deepEqual(out.map(x => x.proc.pid), [2, 3]);
  assert.deepEqual([...D.liveWorktreePaths(wts)].sort(), ['/w', '/w/orca']);
});

test('procSessions: headless runs, summarizer runs and processes without a cwd are left out', () => {
  const out = D.procSessions({ procs: [proc(1, '/w/a', { cmd: 'claude -p x' }), proc(2, '/w/a', { recall: true }), proc(3, ''), proc(4, '/w/a')] });
  assert.deepEqual(out.map(x => x.proc.pid), [4]);
});

test('migrateIds: a detected card taken over by a hook card (same pid or same session id) maps to the hook id', () => {
  const prev = [{ id: 'proc:claude:11::/w/a', pid: 11, sessionId: null }, { id: 'proc:claude:abcd1234ef::/w/b', pid: 12, sessionId: 'abcd1234ef' }, { id: 'proc:claude:13::/w/c', pid: 13, sessionId: null }];
  const hookOnly = [
    { id: 'hook:s1::/w/a', st: { sid: 's1' }, pane: { pid: 11 } },
    { id: 'hook:abcd1234ef::/w/b', st: { sid: 'abcd1234ef' }, pane: null },
    { id: 'hook:s9::/w/z', st: { sid: 's9' }, pane: { pid: 99 } },
  ];
  assert.deepEqual(D.migrateIds(prev, hookOnly), [{ from: 'proc:claude:11::/w/a', to: 'hook:s1::/w/a' }, { from: 'proc:claude:abcd1234ef::/w/b', to: 'hook:abcd1234ef::/w/b' }]);
  assert.deepEqual(D.migrateIds([], hookOnly), []);
  assert.deepEqual(D.migrateIds(prev, []), []);
});

// ── source checks: how the widget wires detected cards, alerts, the team snapshot and the hooks consent ──
const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf-8');
const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf-8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); return src.slice(i, j < 0 ? undefined : j); };

test('widget loads core/discover.js and builds detected cards after the hook-only list', () => {
  assert.match(html, /<script src="core\/discover\.js"><\/script>/);
  const f = between(html, 'async function fetchData() {', '\n}\n');
  const a = f.indexOf('hookOnlySessions('), b = f.indexOf('AgentDeskDiscover.procSessions(');
  assert.ok(a >= 0 && b > a, 'procSessions runs after hookOnlySessions');
  assert.ok(f.indexOf('AgentDeskDiscover.migrateIds(procPrev, hookOnly)') > b);
  assert.match(f, /for \(const p of procOnly\) if \(screenReadable\(p\.handle\)\) handles\.set\(p\.id, p\.handle\)/);
  assert.match(f, /for \(const p of procOnly\) sessions\.push\(procSession\(p\)\)/);
});

test('widget: a term: handle is screen-read only after macOS automation was allowed', () => {
  const fn = between(html, 'function screenReadable(handle) {', '\n');
  assert.match(fn, /startsWith\('tmux:'\) \|\| \(h\.startsWith\('term:'\) && automationAllowed\(\)\)/);
  assert.match(between(html, 'function automationAllowed() {', '\n'), /localStorage\.getItem\('roca-automation-ok'\)/);
});

test('widget: detected cards raise no done / waiting alerts and stay out of the team snapshot', () => {
  const tr = between(html, 'function applyStatusTransitions() {', '\n}\n');
  assert.match(tr, /if \(s\.detected \|\| migratedQuiet\.has\(s\.id\)\) continue;/);
  assert.match(between(html, 'function notifyMineTick() {', '\n}\n'), /s\.detected/);
  assert.match(between(html, 'function peerMySessions() {', '\n}\n'), /!s\.detected/);
  assert.match(between(html, 'function procSession(p) {', '\n}\n'), /detected: true/);
});

test('widget: migrateSessionId moves name, pin, hidden, dock order / hidden and status clocks', () => {
  const fn = between(html, 'function migrateSessionId(from, to) {', '\n}\n');
  for (const re of [/nameOverrides\[to\] = nameOverrides\[from\]/, /pinnedSessions\.add\(to\)/, /hiddenSessions\.add\(to\)/, /dockCfg\.order\.map\(v => v === from \? to : v\)/, /dockCfg\.hidden\[to\] = dockCfg\.hidden\[from\]/, /\[prevStatuses, statusSince\]/]) assert.match(fn, re);
});

test('widget: hooksInstall( is called only inside enableHooks; toggle, onboarding and consent banner use enableHooks', () => {
  const calls = [...html.matchAll(/hooksInstall\(/g)].map(m => m.index);
  assert.equal(calls.length, 1);
  const fn = between(html, 'async function enableHooks() {', '\n}\n');
  assert.match(fn, /window\.orca\.hooksInstall\(\)/);
  assert.match(fn, /setHooksConsent\('done'\)/);
  assert.match(between(html, "$('hooks-toggle').addEventListener('click'", '\n});'), /await enableHooks\(\)/);
  assert.match(between(html, "$('onboard-next').addEventListener('click'", '\n});'), /await enableHooks\(\)/);
  assert.match(between(html, "$('onboard-body').addEventListener('click'", '\n});'), /await enableHooks\(\)/);
  assert.match(between(html, 'async function hooksConsentAnswer(', '\n}\n'), /await enableHooks\(\)/);
});

test('widget: the consent banner is decided after onboarding closes (finished or skipped), and only with hooks off', () => {
  assert.match(between(html, 'function onboardClose() {', '\n'), /fetchData\(\)/);
  assert.match(html, /\$\('onboard-skip'\)\.addEventListener\('click', onboardClose\)/);
  const due = between(html, 'function hooksConsentDue() {', '\n}\n');
  assert.match(due, /hooksEnabled/); assert.match(due, /roca-onboarded/); assert.match(due, /\$\('onboard'\)\.hidden/);
  assert.match(due, /'never'/); assert.match(due, /hooksConsentLater/);
  const banner = between(html, 'function showModeBanner(', '\n}\n');
  assert.match(banner, /const consent = hooksConsentDue\(\);/);
  for (const v of ['on', 'later', 'never']) assert.ok(banner.includes(`data-consent="${v}"`), v);
  const ans = between(html, 'async function hooksConsentAnswer(', '\n}\n');
  assert.match(ans, /setHooksConsent\('never'\)/); assert.match(ans, /hooksConsentLater = true/);
});

test('main ttyTargets: every agent process comes back; only drivable ones get a handle; Windows stays empty', () => {
  const fn = between(main, 'async function ttyTargets() {', '\n}\n');
  assert.match(fn, /if \(IS_WIN\) return \[\];/);
  assert.doesNotMatch(fn, /if \(!IS_MAC && !inTmux\) continue;/);
  assert.match(fn, /const drivable = !!handle;/);
  assert.match(fn, /if \(drivable\) termTargets\.set\(pid, target\);/);
});

test('widget: a detected card keeps its first-seen time (moved only while its screen shows it working), so it can go idle', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(html, /if \(!procSeen\.has\(id\) \|\| finalStatus === 'running'\) procSeen\.set\(id, Date\.now\(\)\);/);
  assert.match(html, /agent: pr\.agent \|\| 'claude', time: procSeen\.get\(id\),/);
});
