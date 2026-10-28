// "Usage without Orca" (status line relay: statusline/relay.cjs, statusline/install.mjs, core/usage.js fromStatusline)
// and the dock "+" new session from a folder without Orca (main.mjs roca:open-session, widget dockAddFolderOpen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { relayState, installRelayAt, uninstallRelayAt, isOurStatusLine } from '../statusline/install.mjs';
await import('../core/usage.js');
const U = globalThis.AgentDeskUsage;
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = join(root, 'statusline', 'relay.cjs');
const relay = require(RELAY);
const html = readFileSync(join(root, 'widget.html'), 'utf-8');
const main = readFileSync(join(root, 'main.mjs'), 'utf-8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); return src.slice(i, j < 0 ? undefined : j); };
const tmp = () => mkdtempSync(join(tmpdir(), 'agentdesk-sl-'));
const NOW = 1_800_000_000_000;   // ms
const sec = ms => Math.floor(ms / 1000);

// ── relay: what goes to usage.json ──
test('usageRecord: only rate_limits (five_hour / seven_day) and session_id are kept', () => {
  const input = JSON.stringify({ session_id: 'abc', cwd: '/secret/path', transcript_path: '/x.jsonl', model: { id: 'm' },
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 }, spend_limit: { used_percentage: 5, resets_at: 1 } } });
  const r = relay.usageRecord(input, NOW);
  assert.deepEqual(r, { writtenAt: NOW, session_id: 'abc', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } });
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('usageRecord: bad JSON, no rate_limits, junk windows → null; one window alone is kept', () => {
  for (const x of ['', 'not json', '[]', 'null', '{"session_id":"a"}', '{"rate_limits":null}', '{"rate_limits":{"five_hour":{"used_percentage":"x","resets_at":1}}}', '{"rate_limits":{"seven_day":{"resets_at":5}}}'])
    assert.equal(relay.usageRecord(x, NOW), null, x);
  assert.deepEqual(relay.usageRecord('{"rate_limits":{"seven_day":{"used_percentage":0,"resets_at":99}}}', NOW).rate_limits, { seven_day: { used_percentage: 0, resets_at: 99 } });
});

// ── renderer conversion ──
test('fromStatusline: shape of Orca rateLimits, seconds → ms, windowMinutes, rounded percent', () => {
  const rec = { writtenAt: NOW - 60000, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: sec(NOW) + 3600 }, seven_day: { used_percentage: 41.2, resets_at: sec(NOW) + 86400 } } };
  const r = U.fromStatusline(rec, NOW);
  assert.deepEqual(r, { claude: {
    session: { usedPercent: 24, windowMinutes: 300, resetsAt: (sec(NOW) + 3600) * 1000, resetDescription: '' },
    weekly: { usedPercent: 41, windowMinutes: 10080, resetsAt: (sec(NOW) + 86400) * 1000, resetDescription: '' },
    updatedAt: NOW - 60000 } });
});
test('fromStatusline: stale or broken readings show nothing', () => {
  const fresh = { five_hour: { used_percentage: 10, resets_at: sec(NOW) + 600 }, seven_day: { used_percentage: 20, resets_at: sec(NOW) + 86400 } };
  assert.equal(U.fromStatusline(null, NOW), null);
  assert.equal(U.fromStatusline({}, NOW), null);
  assert.equal(U.fromStatusline({ rate_limits: fresh }, NOW), null, 'no writtenAt');
  assert.equal(U.fromStatusline({ writtenAt: NOW + 3600000, rate_limits: fresh }, NOW), null, 'written in the future');
  // the earliest window reset since the file was written: the whole reading is stale
  assert.equal(U.fromStatusline({ writtenAt: NOW - 1000, rate_limits: { ...fresh, five_hour: { used_percentage: 90, resets_at: sec(NOW) - 1 } } }, NOW), null);
  // written longer ago than the 5-hour window lasts: only the weekly bar stays
  const old = U.fromStatusline({ writtenAt: NOW - 6 * 3600000, rate_limits: { five_hour: { used_percentage: 10, resets_at: sec(NOW) + 60 }, seven_day: fresh.seven_day } }, NOW);
  assert.equal(old.claude.session, undefined); assert.equal(old.claude.weekly.usedPercent, 20);
  assert.equal(U.fromStatusline({ writtenAt: NOW - 8 * 86400000, rate_limits: { seven_day: { used_percentage: 5, resets_at: sec(NOW) + 60 } } }, NOW), null);
  assert.equal(U.fromStatusline({ writtenAt: NOW, rate_limits: { five_hour: { used_percentage: null, resets_at: sec(NOW) + 60 } } }, NOW), null);
});
test('fromStatusline output is what the dock usage card and the limit bars read', async () => {
  await import('../core/dock.js');
  const r = U.fromStatusline({ writtenAt: NOW, rate_limits: { five_hour: { used_percentage: 50, resets_at: sec(NOW) + 60 } } }, NOW);
  assert.deepEqual(globalThis.AgentDeskDock.usageRows(r.claude), [{ k: 's', pct: 50, resetsAt: (sec(NOW) + 60) * 1000 }]);
});

// ── settings.json install / uninstall ──
const ORIG = { type: 'command', command: '$HOME/.claude/statusline.sh', padding: 0, refreshInterval: 5 };
const CMD = '/home/u/.roca/statusline-relay.sh';
function fixture(settings) {
  const d = tmp(), settingsFile = join(d, 'claude', 'settings.json'), origFile = join(d, 'roca', 'statusline-orig.json'), backupDir = join(d, 'roca');
  mkdirSync(dirname(settingsFile), { recursive: true });
  if (settings !== undefined) writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return { d, settingsFile, origFile, backupDir, read: () => JSON.parse(readFileSync(settingsFile, 'utf-8')) };
}
test('install → uninstall restores the original statusLine exactly; other keys untouched', () => {
  const f = fixture({ model: 'opus', hooks: { Stop: [] }, statusLine: ORIG });
  const before = readFileSync(f.settingsFile, 'utf-8');
  assert.equal(relayState(f), 'off');
  installRelayAt({ ...f, command: CMD });
  const s = f.read();
  assert.deepEqual(s.statusLine, { type: 'command', command: CMD, padding: 0, refreshInterval: 5 }, 'padding / refreshInterval kept');
  assert.equal(s.model, 'opus'); assert.deepEqual(s.hooks, { Stop: [] });
  assert.deepEqual(JSON.parse(readFileSync(f.origFile, 'utf-8')), { had: true, statusLine: ORIG });
  assert.equal(statSync(f.origFile).mode & 0o777, 0o600);
  assert.equal(relayState(f), 'on');
  assert.ok(isOurStatusLine(s.statusLine));
  const backups = require('node:fs').readdirSync(f.backupDir).filter(n => n.startsWith('claude-settings.backup-'));
  assert.equal(backups.length, 1); assert.equal(readFileSync(join(f.backupDir, backups[0]), 'utf-8'), before);
  // installing again (already on) keeps the kept original
  installRelayAt({ ...f, command: CMD });
  assert.deepEqual(JSON.parse(readFileSync(f.origFile, 'utf-8')).statusLine, ORIG);
  assert.deepEqual(uninstallRelayAt(f), { restored: true });
  const back = f.read();
  assert.deepEqual(back.statusLine, ORIG); assert.equal(back.model, 'opus');
  assert.ok(!existsSync(f.origFile));
  assert.equal(relayState(f), 'off');
  rmSync(f.d, { recursive: true, force: true });
});
test('no statusLine before: uninstall removes the key; no settings file at all works too', () => {
  const f = fixture({ model: 'x' });
  installRelayAt({ ...f, command: CMD });
  assert.deepEqual(f.read().statusLine, { type: 'command', command: CMD });
  uninstallRelayAt(f);
  assert.deepEqual(f.read(), { model: 'x' });
  const g = fixture(undefined);
  installRelayAt({ ...g, command: CMD });
  uninstallRelayAt(g);
  assert.deepEqual(g.read(), {});
});
test('a statusLine the user set after install: "replaced", never overwritten on uninstall', () => {
  const f = fixture({ statusLine: ORIG });
  installRelayAt({ ...f, command: CMD });
  const mine = { type: 'command', command: 'echo mine' };
  writeFileSync(f.settingsFile, JSON.stringify({ statusLine: mine }));
  assert.equal(relayState(f), 'replaced');
  assert.deepEqual(uninstallRelayAt(f), { restored: false });
  assert.deepEqual(f.read().statusLine, mine);
  assert.equal(relayState(f), 'off');
});
test('a broken settings.json is never written; bad relay command refused', () => {
  const f = fixture('{ not json');
  assert.equal(relayState(f), 'error');
  assert.throws(() => installRelayAt({ ...f, command: CMD }));
  assert.equal(readFileSync(f.settingsFile, 'utf-8'), '{ not json');
  assert.ok(!existsSync(f.origFile));
  const g = fixture({});
  assert.throws(() => installRelayAt({ ...g, command: 'rm -rf ~' }), /invalid relay command/);
  assert.deepEqual(g.read(), {});
});

// ── the relay run as Claude Code would (temporary HOME) ──
const POSIX = process.platform !== 'win32';
function runRelay(home, input) {
  return spawnSync(process.execPath, [RELAY], { input, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8', timeout: 10000 });
}
function home(orig) {
  const h = tmp();
  if (orig !== undefined) { mkdirSync(join(h, '.roca'), { recursive: true }); writeFileSync(join(h, '.roca', 'statusline-orig.json'), JSON.stringify(orig)); }
  return h;
}
const INPUT = JSON.stringify({ session_id: 's1', cwd: '/w', rate_limits: { five_hour: { used_percentage: 12, resets_at: 2000000000 } } });
test('relay: writes usage.json (0600 in a 0700 dir) and passes the original output and exit code through', { skip: !POSIX && 'POSIX shell' }, () => {
  const h = home({ had: true, statusLine: { type: 'command', command: 'cat >/dev/null; echo hello', padding: 0 } });
  const r = runRelay(h, INPUT);
  assert.equal(r.status, 0); assert.equal(r.stdout, 'hello\n');
  const u = JSON.parse(readFileSync(join(h, '.roca', 'usage.json'), 'utf-8'));
  assert.equal(u.session_id, 's1'); assert.deepEqual(u.rate_limits, { five_hour: { used_percentage: 12, resets_at: 2000000000 } });
  assert.ok(!('cwd' in u));
  assert.equal(statSync(join(h, '.roca', 'usage.json')).mode & 0o777, 0o600);
  // the original command reads the same stdin
  const h2 = home({ had: true, statusLine: { type: 'command', command: 'wc -c | tr -d " "' } });
  assert.equal(runRelay(h2, INPUT).stdout.trim(), String(Buffer.byteLength(INPUT)));
  // its exit code is passed on
  const h3 = home({ had: true, statusLine: { type: 'command', command: 'echo partial; exit 3' } });
  const r3 = runRelay(h3, INPUT);
  assert.equal(r3.status, 3); assert.equal(r3.stdout, 'partial\n');
});
test('relay: bad JSON still shows the original output, writes nothing', { skip: !POSIX && 'POSIX shell' }, () => {
  const h = home({ had: true, statusLine: { type: 'command', command: 'echo hello' } });
  const r = runRelay(h, '{ broken');
  assert.equal(r.status, 0); assert.equal(r.stdout, 'hello\n');
  assert.ok(!existsSync(join(h, '.roca', 'usage.json')));
});
test('relay: no original command → empty output (exit 0), usage still written; dir created 0700', () => {
  for (const orig of [undefined, { had: false }]) {
    const h = home(orig);
    const r = runRelay(h, INPUT);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    assert.ok(existsSync(join(h, '.roca', 'usage.json')));
    if (POSIX && orig === undefined) assert.equal(statSync(join(h, '.roca')).mode & 0o777, 0o700);
  }
});
test('relay: an original command that cannot run does not break the relay', { skip: !POSIX && 'POSIX shell' }, () => {
  const h = home({ had: true, statusLine: { type: 'command', command: '/nonexistent/statusline-xyz' } });
  const r = runRelay(h, INPUT);
  assert.equal(r.stdout, ''); assert.equal(r.status, 127);   // sh's "not found", as Claude Code would have seen
  assert.ok(existsSync(join(h, '.roca', 'usage.json')));
});

// ── main.mjs wiring ──
test('main: resume and the new folder session share openTerminalAt; agents only from the allow-list; folder checked', () => {
  const resume = between(main, 'ipcMain.handle("roca:resume-session"', '\n});\n');
  assert.match(resume, /return openTerminalAt\(cwd \|\| homedir\(\), mk\(sessionId\)\);/);
  const open = between(main, 'ipcMain.handle("roca:open-session"', '\n});\n');
  assert.match(main, /const NEW_SESSION_CMD = \{ claude: "claude", codex: "codex", gemini: "gemini" \};/);
  assert.match(open, /hasOwnProperty\.call\(NEW_SESSION_CMD, agent\)/);
  assert.match(open, /statSync\(dir\)\.isDirectory\(\)/);
  assert.match(open, /isAbsolute\(dir\)/);
  assert.match(open, /return openTerminalAt\(dir, cmd\);/);
  const fn = between(main, 'async function openTerminalAt(dir, command) {', '\n}\n');
  assert.match(fn, /wt\.exe/); assert.match(fn, /x-terminal-emulator/); assert.match(fn, /appRunning\("iTerm2"\)/); assert.match(fn, /tell application "Terminal"/);
  assert.match(fn, /cd \$\{shq\(dir\)\} && \$\{command\}/);
  assert.match(between(main, 'ipcMain.handle("roca:pick-folder"', '\n});\n'), /properties: \["openDirectory"\]/);
});
test('main: settings.json changes only from the install / uninstall IPCs (consent in the renderer)', () => {
  const calls = main.match(/installRelayAt\(|uninstallRelayAt\(/g) || [];
  assert.equal(calls.length, 2);
  assert.match(between(main, 'async function installStatusline()', '\n}\n'), /backupDir: ROCA_DIR/);
  const i = main.indexOf('// the status line relay after an update'); assert.ok(i > 0);
  const startup = main.slice(i, main.indexOf('\n', main.indexOf('\n', i) + 1));
  assert.match(startup, /slWriteFiles\(r\.files, true\)/);
  assert.ok(!/installRelayAt|installStatusline\(/.test(startup), 'start-up rewrites files only');
});

// ── renderer wiring ──
test('renderer: "+" without Orca opens the folder form; with Orca the worktree form as before', () => {
  const open = between(html, 'async function dockAddOpen()', '\n}\n');
  assert.match(open, /if \(!orcaAvailable\) \{ dockAddFolderOpen\(\); return; \}/);
  assert.ok(open.indexOf('dockAddFolderOpen()') < open.indexOf('window.orca.repos()'));
  const go = between(html, 'async function dockAddFolderGo()', '\n}\n');
  assert.match(go, /p\.dirs\.includes\(dir\)/);
  assert.match(go, /window\.orca\.openSession\(dir, agent\)/);
  assert.match(go, /dockAddWant = \{ cwd: dir, before, at: Date\.now\(\) \}/);
  assert.match(between(html, 'function newSessionDirSave(dir)', '\n}\n'), /\.slice\(0, 8\)/);
  assert.match(between(html, 'function newSessionAgents()', '\n}\n'), /\['claude', \.\.\./);
  assert.match(between(html, 'function dockDraw()', '\n}\n'), /w\.cwd \? !w\.before\.has\(x\.id\) && cwdOf\(x\.id\) === w\.cwd/);
});
test('renderer: usage bars fall back to the relay reading only when Orca has none; shown when there is data', () => {
  const f = between(html, 'async function fetchData()', '\n}\n');
  assert.match(f, /if \(!rateLimits\.claude && slState === 'on'\) \{/);
  assert.match(f, /AgentDeskUsage\.fromStatusline\(await window\.orca\.statuslineUsage\(\)/);
  assert.match(f, /\$\('tokenBars'\)\.style\.display = orcaAvailable \|\| rateLimits\.claude \? '' : 'none';/);
  assert.ok(f.indexOf("slState === 'on'") < f.indexOf("$('tokenBars').style.display"));
});
test('renderer: one banner at a time — hooks consent first, the usage offer only without Orca and with hooks on', () => {
  const banner = between(html, 'function showModeBanner(', '\n}\n');
  assert.match(banner, /const slAsk = !consent && statuslineConsentDue\(orcaOk\);/);
  assert.ok(banner.indexOf('if (consent) html') < banner.indexOf('else if (slAsk) html'));
  const due = between(html, 'function statuslineConsentDue(orcaOk) {', '\n}\n');
  assert.match(due, /orcaOk \|\| !hooksEnabled/); assert.match(due, /slState !== 'off'/); assert.match(due, /'never'/);
  const ans = between(html, 'async function statuslineConsentAnswer(', '\n}\n');
  assert.match(ans, /await enableStatusline\(\)/); assert.match(ans, /setSlConsent\('never'\)/); assert.match(ans, /slConsentLater = true/);
  // the only install calls: enableStatusline (banner + settings switch, after confirm)
  assert.equal((html.match(/window\.orca\.statuslineInstall\(/g) || []).length, 1);
  assert.match(between(html, "else if (name === 'statusline') {", '\n  }\n'), /if \(!confirm\(/);
});
