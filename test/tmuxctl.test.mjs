// core/tmuxctl.js — tmux control mode for AgentDesk's own terminal: output lines → bytes, typed bytes → commands.
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../core/tmuxctl.js');
const C = globalThis.AgentDeskTmuxCtl;
const enc = s => new TextEncoder().encode(s), dec = b => new TextDecoder().decode(b);

test('parser: %output lines become bytes; escapes, split chunks and a split UTF-8 character survive', () => {
  const got = [];
  const p = C.createParser(e => got.push(e));
  p.feed(enc('%begin 1 2 0\n%end 1 2 0\n%output %3 hi\\033[1mB\\134x\\015\\012\n'));
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].type, got[0].pane, dec(got[0].data)], ['output', '%3', 'hi\x1b[1mB\\x\r\n']);
  const han = enc('한');   // 3 bytes, sent as two %output lines the way tmux does
  p.feed(new Uint8Array([...enc('%output %3 '), han[0], 0x0a, ...enc('%output %3 '), han[1], han[2]]));
  assert.equal(got.length, 2, 'the second line has no newline yet');
  p.feed(enc('\n'));
  assert.equal(dec(new Uint8Array([...got[1].data, ...got[2].data])), '한', 'bytes are kept as they came: the view joins them');
  p.feed(enc('%output %x nope\n%output notapane x\n%layout-change @1 x\n'));
  assert.equal(got.length, 3, 'only pane output is an event');
  p.feed(enc('%exit\n'));
  assert.equal(got[3].type, 'exit');
});

test('keysCommands / sizeCommand: typed bytes as hex, the size clamped', () => {
  assert.deepEqual(C.keysCommands('%1', enc('a\x1b[A')), ['send-keys -t %1 -H 61 1b 5b 41']);
  assert.equal(C.keysCommands('%1', new Uint8Array(600)).length, 3, 'long input is cut into commands');
  assert.deepEqual(C.keysCommands('%1; kill-server', enc('a')), [], 'a pane id is a pane id');
  assert.deepEqual(C.keysCommands('%1', new Uint8Array(0)), []);
  assert.equal(C.sizeCommand(120, 32), 'refresh-client -C 120x32');
  assert.equal(C.sizeCommand('x; kill-server', 99999), 'refresh-client -C 120x200');
  assert.equal(C.sizeCommand(1, 1), 'refresh-client -C 20x5');
});

test('names and agents: only AgentDesk\'s own sessions, only the known agent commands', () => {
  assert.equal(C.sessionName('My Repo/x'), 'agentdesk-my-repo-x');
  assert.equal(C.isSessionName('agentdesk-a1'), true);
  for (const s of ['main', 'agentdesk-', 'agentdesk-a b', 'agentdesk-a;rm', 'x-agentdesk-a', '']) assert.equal(C.isSessionName(s), false, s);
  assert.equal(C.agentCommand('claude'), 'claude');
  assert.equal(C.agentCommand('shell'), '');
  assert.equal(C.agentCommand('rm -rf /'), '', 'an unknown agent types nothing');
  assert.equal(C.agentCommand('constructor'), '');
});

test('own terminal wiring: main only touches its own sessions and known agent commands; the widget loads xterm from the package', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const own = read('term/own.mjs'), main = read('main.mjs'), html = read('widget.html'), pre = read('preload.cjs'), pkg = JSON.parse(read('package.json'));
  assert.match(own, /if \(!C\.isSessionName\(name\)\) return \{ ok: false, error: 'not an AgentDesk terminal' \};/, 'attach / kill refuse any other tmux session');
  assert.match(own, /const cmd = resumeId \? C\.resumeCommand\(agent, resumeId\) : C\.agentCommand\(agent\);/, 'a new terminal types a known agent command (or its resume form), never the renderer\'s text');
  assert.match(own, /spawn\(bin, \['-C', 'attach', '-t', name\]/, 'control mode over pipes: no pty module');
  assert.doesNotMatch(read('package.json'), /node-pty/);
  for (const ch of ['roca:own-term-list', 'roca:own-term-new', 'roca:own-term-attach', 'roca:own-term-kill', 'roca:own-term-input', 'roca:own-term-resize', 'roca:own-term-detach']) { assert.ok(main.includes(`"${ch}"`), ch); assert.ok(pre.includes(`"${ch}"`), ch); }
  assert.match(main, /app\.on\("will-quit", \(\) => ownTerms\.closeAll\(\)\);/, 'the views detach on quit; the tmux sessions stay');
  assert.match(html, /<script src="node_modules\/@xterm\/xterm\/lib\/xterm\.js"><\/script>\n<script src="node_modules\/@xterm\/addon-fit\/lib\/addon-fit\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="node_modules\/@xterm\/xterm\/css\/xterm\.css">/);
  assert.ok(pkg.dependencies['@xterm/xterm'] && pkg.dependencies['@xterm/addon-fit']);
  assert.ok(pkg.build.files.includes('term/**/*'), 'term/ ships in the build');
  for (const f of ['node_modules/@xterm/xterm/lib/xterm.js', 'node_modules/@xterm/xterm/css/xterm.css', 'node_modules/@xterm/addon-fit/lib/addon-fit.js']) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  assert.match(html, /switchTo: h => \(ownTermOfHandle\(h\) \? ownTermGo\(ownTermOfHandle\(h\)\) : window\.orca\.terminalSwitch\(h\)\),/, 'a session in an own terminal opens in the terminal page');
});

test('workspace: the nav opens it, main sizes the window, sessions in an own terminal open beside the list', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8'), main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(html, /<button class="page-nav-btn" data-page="work">작업 공간<\/button>/);
  assert.match(html, /if \(name === 'work' && !wideOn\) wideSet\(true\);/, 'the terminal page lives in the wide window');
  assert.match(html, /if \(wideOn\) \{ opts = \{ \.\.\.\(opts \|\| \{\}\), keepSize: true \}; wideNavDraw\(\); workDraw\(\); \}/, 'every page keeps the wide window\'s size');
  assert.match(html, /if \(wideOn\) wideSet\(false, true\);/, 'entering the dock gives the small widget back first (and does not forget the wide window)');
  assert.match(html, /if \(prev\.wide\) dockOff\.then\(\(\) => \{ if \(!dockOn\) wideSet\(true\); \}\);/);
  assert.ok(html.indexOf('let wideOn = false, wideSaved = false;') < html.indexOf('function showPage(name, opts) {'), 'showPage reads wideOn from its first call');
  assert.match(html, /if \(own\) \{ workChatClose\(\); await ownTermOpen\(own\); workDraw\(\); return; \}/, 'an own-terminal session opens in place');
  assert.match(html, /if \(h\) \{ openChat\(h\); return; \}/, 'another app\'s session is read in place, not switched to');
  assert.match(html, /resumeId: c\.sessionId/, 'an ended session is reopened in an AgentDesk terminal');
  for (const p of ['work', 'dashboard', 'office', 'team', 'jira', 'skillbook', 'pomodoro', 'settings']) assert.ok(html.includes(`['${p}', '`), `the wide menu lists ${p}`);
  assert.match(html, /const g = workGroups = AgentDeskProjects\.group\(src, workCfg, now0\);/, 'the list is grouped into projects (folders) by core/projects.js');
  assert.match(html, /<script src="core\/tmuxctl\.js"><\/script>\n<script src="core\/projects\.js"><\/script>/);
  assert.match(html, /keep: !!ownTermOfHandle\(handles\.get\(c\.id\)\)/, 'a session in an AgentDesk terminal never folds as old');
  assert.match(html, /localStorage\.setItem\('roca-projects'/, 'projects, their names and their order are remembered');
  assert.match(html, /AgentDeskProjects\.nowList\(src, now0\)/, 'what needs me is a section on top, the projects do not move');
  assert.ok(html.indexOf('window.orca.workspace(false);   // a page that starts over') > html.indexOf('function workDraw()'));
  assert.match(main, /const WORK_MIN = \{ w: 760, h: 440 \}, WORK_DEFAULT = \{ w: 1280, h: 800 \};/);
});

test('resumeCommand: the agent\'s own resume form, for a plain session id only', () => {
  assert.equal(C.resumeCommand('claude', '3a17eda1-2315-493f-9d3a-9720fbea90d9'), 'claude --resume 3a17eda1-2315-493f-9d3a-9720fbea90d9');
  assert.equal(C.resumeCommand('codex', 'abcdef123456'), 'codex resume abcdef123456');
  for (const id of ['short', 'a b c d e f g h', 'abcdefgh; rm -rf /', '$(whoami)aaaaaaaa', '', null]) assert.equal(C.resumeCommand('claude', id), '', String(id));
  assert.equal(C.resumeCommand('shell', 'abcdef123456'), '');
  assert.equal(C.resumeCommand('constructor', 'abcdef123456'), '');
});
