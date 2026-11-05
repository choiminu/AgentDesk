// widget.html quest view (source checks, like skillbook-ui.test.mjs): the 퀘스트 mode, questRender(root) into any container,
// the picker's disabled sessions, 자동 never dispatching on its own, assignment recorded only after a modal send succeeds,
// the report hook, and the I18N check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// short failure messages: never dump the whole page
const match = (str, re) => assert.ok(re.test(str), `no match: ${re}`);
const nomatch = (str, re) => assert.ok(!re.test(str), `unexpected match: ${re}`);
const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const a = html.indexOf('// ── QUEST BOARD'), b = html.indexOf('// ── end of QUEST BOARD', a);
const q = a < 0 || b < 0 ? '' : html.slice(a, b);
const fn = name => { const i = q.indexOf(`function ${name}(`); const m = /\n(async )?function /.exec(q.slice(i + 1)); return i < 0 ? '' : q.slice(i, m ? i + 1 + m.index : undefined); };
const modal = name => { const i = html.indexOf(`async function ${name}(`); return html.slice(i, html.indexOf('\nasync function ', i + 1) > 0 ? html.indexOf('\nasync function ', i + 1) : undefined); };

test('quest ui: 퀘스트 mode switch on the board and core/quest.js loaded', () => {
  assert.ok(q.length > 1500, 'quest section exists');
  match(html, /<script src="core\/quest\.js"><\/script>/);
  match(html, /data-jb="quest"/);
  match(html, /act === 'quest'/);
  match(html, /id="jb-quest"/);
  match(html, /if \(questOn\) \{ questRender\(qe\); return; \}/);
  match(html, /id="jira-quest-btn"/);
  match(html, /if \(questOn\) \{ questRender\(qe\); return; \}\n  const el = \$\('jira-list'\)|qe\.hidden = !questOn; el\.hidden = questOn;/);
});

test('quest ui: cards render through questRender(root) into any container, state kept outside the DOM', () => {
  match(q, /function questRender\(root\)/);
  match(fn('questRender'), /AgentDeskQuest\.questView\(questIssues\(\), quest\.file, live(, questWorktrees\(\))?\)/);
  match(q, /const quest = \{ file: [^\n]*proposals: new Map\(\), pending: new Map\(\)/);
  match(q, /QUEST_GROUPS = \[\['new', '새 퀘스트'\], \['doing', ''\], \['report', '보고 대기'\], \['done', '완료'\]\]/);
  match(q, /'In progress'/);
  match(q, /function questOpenPicker\(key\)/);
  match(q, /async function questAuto\(key\)/);
});

test('quest ui: picker disables non-eligible sessions and ends with the new-worktree row', () => {
  const p = fn('questPickerHtml');
  match(p, /p\.eligible \?/);
  match(p, /<button disabled>\$\{esc\(t\('작업 중'\)\)\}/);
  match(p, /b\.eligible \? 1 : 0\) - \(a\.eligible \? 1 : 0\)/);
  match(p, /data-q="wt"[^\n]*새 워크트리에서 시작/);
  match(p, /p\.skills/);
});

test('quest ui: 자동 only proposes; dispatch needs the 맡기기 click and the normal modal', () => {
  const auto = fn('questAuto') + fn('questCancel');
  nomatch(auto, /jiraSessionModal|jiraWorktreeModal|terminalSend|worktreeCreate|questAssign/);
  const wire = fn('questWire');
  match(wire, /act === 'accept'\) questAccept\(key\)/);
  match(fn('questAccept'), /AgentDeskQuest\.acceptProposal\([\s\S]*jiraSessionModal\(key, ok\.id\)[\s\S]*jiraWorktreeModal\(key, ok\.repo\)/);
    match(q, /직접 고르세요/);
  match(q, /'cancelled'/);
  match(q, /window\.orca\.questDeskCancel/);
});

test('quest ui: assignment recorded only after the modal send succeeds; report hooked into jiraCapture', () => {
  const ss = modal('jiraSessionModal'), wt = modal('jiraWorktreeModal');
  match(ss, /terminalSend[\s\S]*if \(!r\?\.result\?\.send\?\.accepted\) throw[\s\S]*questNoteAssign\(key, \{ kind: 'session', sessionId: sess\.id \}\)/);
  match(wt, /if \(!r \|\| r\.ok === false\) \{[^\n]*return; \}[\s\S]*questNoteAssign\(key, \{ kind: 'worktree', repo: repoLabel \}\)/);
  assert.equal((html.match(/questNoteAssign\(key, \{/g) || []).length, 2);
  match(modal('jiraCapture'), /d\.state = 'report'[^\n]*\n\s*questNoteReport\(d\.key\)/);
  match(q, /window\.orca\.questAssign\(/);
  match(q, /window\.orca\.questReport\(/);
  match(html, /async function jiraSessionModal\(key, preselect\)/);
  match(html, /async function jiraWorktreeModal\(key, preselect\)/);
});

test('quest ui: prune after board load; party inputs carry hasPerm, doing and skills', () => {
  match(html, /window\.orca\.questPrune\(\{ issues: jb\.issues[,}]/);
  match(html, /window\.orca\.questPrune\(\{ issues: jiraIssues[,}]/);
  const party = fn('questParty');
  match(party, /hasPerm:/); match(party, /doing: nowSummaries\.get\(s\.id\)/); match(party, /skills: questSkills\.get\(sid\)/);
  match(party, /AgentDeskQuest\.partyOf\(src, handles\)/);
  match(html, /hooksRecent\(\)\) \{ applyHookEvent\(rec\); questSkillNote\(rec\); \}/);
  match(q, /onHookEvents\(evts => \{ for \(const rec of evts\) questSkillNote\(rec\)/);
  match(fn('questRepoList'), /window\.orca\.repos\(\)/);
});

test('quest ui: Jira and session text goes through esc()', () => {
  const card = fn('questCardHtml');
  match(card, /esc\(c\.title\)/); match(card, /esc\(prop\.label\)/); match(card, /esc\(prop\.reason\)/);
  nomatch(card, /\$\{c\.title\}|\$\{prop\./);
});

test('quest ui: inline script hash and I18N are current', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const s of ['csp-hash.mjs', 'i18n-check.mjs']) {
    const r = spawnSync(process.execPath, [`scripts/${s}`], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

// ── behavioral: the quest section run in node:vm with stubs ──
import vm from 'node:vm';
await import('../core/quest.js'); await import('../core/jira.js');
function boot(over = {}) {
  const calls = [];
  const rec = n => (...a) => { calls.push([n, ...a]); return over[n] ? over[n](...a) : undefined; };
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = v => (v == null ? '' : String(v)).replace(/[&<>"']/g, c => MAP[c]);
  const sb = {
    console, Date, Promise, Set, Map, WeakSet, Array, Object, String, JSON,
    AgentDeskQuest: globalThis.AgentDeskQuest, AgentDeskJira: globalThis.AgentDeskJira,
    esc, escA: esc, t: x => x, LANG: 'ko', $: () => null,
    sessions: [], handles: new Map(), nowSummaries: new Map(), jb: { issues: [], q: '', who: new Set(), err: '', projects: [], me: null }, jiraIssues: [], jiraDetail: new Map(),
    jiraBoardMode: true, jiraBusy: false, jiraErr: '', jiraConn: null, jiraDispatch: {},
    jiraSessFor: d => (d.sid ? sb.sessions.find(x => x.id === d.sid) || null : null),
    dockPermMap: () => new Map(), hookStateFor: () => null, skillCastOf: () => null,
    jiraSessionModal: rec('jiraSessionModal'), jiraWorktreeModal: rec('jiraWorktreeModal'), jbBarRender() {}, jiraRender() {},
    window: { orca: { onHookEvents() {}, questState: async () => ({ quests: {} }), questAssign: rec('questAssign'), questReport: rec('questReport'), questDeskCancel: rec('questDeskCancel'),
      repos: async () => ({ result: { repos: [{ id: 'r1', displayName: 'api', path: '/w/api' }] } }),
      questDesk: rec('questDesk'), terminalSend: rec('terminalSend'), worktreeCreate: rec('worktreeCreate') } },
  };
  vm.createContext(sb);
  vm.runInContext(q + '\n;globalThis.__q = { quest, questAuto, questAccept, questPick, questCardHtml, questPickerHtml, questParty, questRepoList, questRender, questWire, questCancel, QUEST_PROPOSAL_MS, questWorktrees, questCanAssign, questPruneProjects };', sb);
  return { sb, calls, q: sb.__q };
}
const sess = (id, status, extra = {}) => ({ id, name: id, status, connected: true, repo: 'api', cwd: '/w/api/x', branch: 'b', ...extra });
const tick = () => new Promise(r => setTimeout(r, 5));

test('quest behavior: 자동 never calls a modal, send, worktree create or questAssign', async () => {
  const { sb, calls, q: Q } = boot({ questDesk: async () => ({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'idle in api' }) });
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1'); sb.jb.issues = [{ key: 'PROJ-1', summary: 'x', priority: 'High', labels: [] }];
  await Q.questAuto('PROJ-1');
  assert.equal(Q.quest.proposals.get('PROJ-1').id, 's1');
  assert.deepEqual(calls.map(c => c[0]).filter(n => n !== 'questDesk'), []);
});

test('quest behavior: accepting a stale proposal is blocked (busy, permission-waiting, ended, expired)', async () => {
  for (const mutate of [s => { s.status = 'running'; }, s => { s.needsInput = true; }, s => { s.connected = false; }, null]) {
    const { sb, calls, q: Q } = boot();
    const s = sess('s1', 'waiting'); sb.sessions = [s]; sb.handles.set('s1', 'h1');
    Q.quest.proposals.set('PROJ-1', { kind: 'session', id: 's1', label: 's1', reason: 'r', at: mutate ? Date.now() : Date.now() - Q.QUEST_PROPOSAL_MS - 1000 });
    if (mutate) mutate(s);
    await Q.questAccept('PROJ-1');
    assert.equal(calls.filter(c => /Modal/.test(c[0])).length, 0);
    assert.equal(Q.quest.proposals.has('PROJ-1'), false);
    assert.ok(Q.quest.errors.has('PROJ-1'));
  }
  const { sb, calls, q: Q } = boot();
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1');
  Q.quest.proposals.set('PROJ-1', { kind: 'session', id: 's1', label: 's1', reason: 'r', at: Date.now() });
  await Q.questAccept('PROJ-1');
  assert.deepEqual(calls.filter(c => /Modal/.test(c[0])), [['jiraSessionModal', 'PROJ-1', 's1']]);
  Q.quest.proposals.set('PROJ-1', { kind: 'worktree', repo: 'gone', label: 'gone', reason: 'r', at: Date.now() });
  await Q.questAccept('PROJ-1');
  assert.equal(calls.filter(c => /Modal/.test(c[0])).length, 1);
});

test('quest behavior: picking a busy session does not open the modal', () => {
  const { sb, calls, q: Q } = boot();
  sb.sessions = [sess('s1', 'running')]; sb.handles.set('s1', 'h1');
  Q.questPick('PROJ-1', 's1');
  assert.equal(calls.length, 0);
});

test('quest behavior: a cancelled ask cannot overwrite a newer one', async () => {
  let n = 0; const resolvers = [];
  const { sb, q: Q } = boot({ questDesk: () => new Promise(r => resolvers.push(r)) });
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1');
  const first = Q.questAuto('PROJ-1'); await tick();
  Q.questCancel('PROJ-1');
  const second = Q.questAuto('PROJ-1'); await tick();
  resolvers[0]({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'old' }); await first;
  assert.equal(Q.quest.proposals.has('PROJ-1'), false);
  assert.ok(Q.quest.pending.has('PROJ-1'));
  resolvers[1]({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'new' }); await second;
  assert.equal(Q.quest.proposals.get('PROJ-1').reason, 'new');
  void n;
});

test('quest behavior: desk repos are the Orca repos only; session repo maps to the Orca label', async () => {
  const { sb, q: Q } = boot();
  sb.sessions = [sess('s1', 'waiting', { repo: '/elsewhere/z', cwd: '/w/api/sub' }), sess('s2', 'waiting', { repo: '/elsewhere/z', cwd: '/elsewhere/z' }), sess('s3', 'waiting', { repo: 'zz', cwd: '/w/apix' })];
  for (const id of ['s1', 's2', 's3']) sb.handles.set(id, 'h' + id);
  assert.deepEqual([...(await Q.questRepoList())], ['api']);
  const byId = Object.fromEntries(Q.questParty().map(p => [p.id, p.repo]));
  assert.equal(byId.s1, 'api'); assert.equal(byId.s2, '/elsewhere/z'); assert.notEqual(byId.s3, 'api');
});

test('quest behavior: card and picker escape Jira and session text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { sb, q: Q } = boot();
  sb.sessions = [sess('s1', 'waiting', { name: evil, repo: evil, cwd: '/none', branch: evil })]; sb.handles.set('s1', 'h1'); sb.nowSummaries.set('s1', evil);
  const card = Q.questCardHtml({ key: 'PROJ-1', title: evil, difficulty: 2, group: 'new', status: '', assignee: evil });
  Q.quest.picker = 'PROJ-1';
  const html2 = Q.questCardHtml({ key: 'PROJ-1', title: evil, difficulty: 2, group: 'new', status: '' }) + Q.questPickerHtml('PROJ-1');
  for (const h of [card, html2]) assert.ok(!/<img/.test(h), 'raw tag leaked');
  assert.ok(html2.includes('&lt;img'));
});

test('quest behavior: render shows load / error / not-connected states', () => {
  const { sb, q: Q } = boot();
  const root = { isConnected: true, innerHTML: '', addEventListener() {}, classList: { add() {} } };
  sb.jiraBusy = true; Q.questRender(root); assert.match(root.innerHTML, /불러오는 중/);
  sb.jiraBusy = false; sb.jb.err = 'boom'; Q.questRender(root); assert.match(root.innerHTML, /boom/);
  sb.jb.err = ''; sb.jiraConn = { connected: false, error: 'sign in' }; Q.questRender(root); assert.match(root.innerHTML, /sign in/);
  sb.jiraConn = null; Q.questRender(root); assert.match(root.innerHTML, /붙어 있는 의뢰가 없습니다/); assert.match(root.innerHTML, /qb-head/, 'the header stays with no cards');
  sb.jiraBoardMode = false; sb.jiraIssues = [{ key: 'PROJ-2', summary: 'list mode', status: 'To Do', priority: 'Low', labels: [] }]; Q.questRender(root); assert.match(root.innerHTML, /list mode/);
});

test('quest ui: a missed preselect adds a disabled "선택하세요" placeholder and re-enables submit on change', () => {
  const src = html.slice(html.indexOf('function jiraPreselectMiss('), html.indexOf('async function jiraWorktreeModal('));
  const opts = [];
  let onChange = null;
  const sel = { value: 'x', firstChild: null, insertBefore(o) { opts.unshift(o); }, addEventListener(ev, fn) { if (ev === 'change') onChange = fn; } };
  const go = { disabled: false }, msg = { textContent: '' };
  const m = { querySelector: s => ({ '#s': sel, '#g': go, '#m': msg })[s] };
  const sb = { t: x => x, document: { createElement: () => ({}) } };
  vm.createContext(sb); vm.runInContext(src + ';globalThis.f = jiraPreselectMiss;', sb);
  sb.f(m, '#s', '#g', '#m');
  assert.equal(opts.length, 1); assert.equal(opts[0].disabled, true); assert.equal(opts[0].selected, true); assert.equal(opts[0].textContent, '선택하세요'); assert.equal(sel.value, '');
  assert.equal(go.disabled, true);
  onChange(); assert.equal(go.disabled, false); assert.equal(msg.textContent, '');
});

// ── Task 4: dock panel (🗡) and office marker ──
test('quest dock: 🗡 button with an I18N title, shared dockSheetOpen mutual exclusion with 📖', () => {
  match(html, /<button class="dock-btn" id="dock-q"/);
  match(html, /\['dock-q', '도크: 퀘스트'\]/);
  match(html, /'도크: 퀘스트': 'Quests'/);
  match(html, /const dockSheetOpen = \(\) => sbDockOpen \|\| questDockOpen;/);
  match(html, /dockFullPop = k => [^\n]*'quest'/);
  match(html, /if \(questDockOpen\) return 'quest';/);
  const tog = html.slice(html.indexOf('function questDockToggle('), html.indexOf("$('q-dock').addEventListener('keydown'"));
  match(tog, /if \(sbDockOpen\) sbDockToggle\(false\);/);
  const sbT = html.slice(html.indexOf('function sbDockToggle('), html.indexOf("$('sb-dock').addEventListener('keydown'"));
  match(sbT, /if \(questDockOpen\) questDockToggle\(false\);/);
  match(html, /\$\('dock-q'\)\.addEventListener\('click', e => \{ e\.stopPropagation\(\); questDockToggle\(\); \}\)/);
  match(html, /if \(questDockOpen\) \{ questDockToggle\(false\); \$\('dock-q'\)\.focus\(\); return; \}/);
  match(html, /\.q-dock \.qb-col \{ flex: 0 0 auto; min-width: 0; \}/);   // groups stacked, scoped to the dock panel
});

test('quest dock: panel loads Jira once when the page never did; re-renders on Jira reload', () => {
  match(html, /jiraBusy = true; jiraErr = ''; jiraLoadedOnce = true;/);
  match(html, /function jiraRender\(\) \{\n  if \(questDockOpen\) questDockRender\(\);/);
  const a2 = html.indexOf('function questDockRender('), b2 = html.indexOf('function questDockToggle(');
  const sb = { jiraLoadedOnce: false, jiraBusy: false, loads: 0, jiraLoad() { sb.loads++; sb.jiraBusy = true; return Promise.resolve(); }, Promise, questDockOpen: true, rendered: [], $: id => id, questRender(r) { sb.rendered.push(r); } };
  vm.createContext(sb); vm.runInContext(html.slice(a2, b2) + ';globalThis.ens = questDockEnsure; globalThis.rend = questDockRender;', sb);
  sb.ens(); assert.equal(sb.loads, 1);
  sb.jiraLoadedOnce = true; sb.jiraBusy = false; sb.ens(); assert.equal(sb.loads, 1, 'already loaded: no second load');
  sb.rend(); assert.deepEqual(sb.rendered, ['q-dock-body']);
  sb.questDockOpen = false; sb.rend(); assert.equal(sb.rendered.length, 1);
});

test('quest dock: disconnected shows the sign-in text, never throws', () => {
  const { sb, q: Q } = boot();
  const root = { isConnected: true, innerHTML: '', addEventListener() {}, classList: { add() {} } };
  sb.jiraConn = { connected: false, error: '' }; assert.doesNotThrow(() => Q.questRender(root));
  assert.match(root.innerHTML, /Jira가 연결되지 않았습니다/);
});

test('quest marker: AgentDeskQuest.markerFor conditions', () => {
  const M = globalThis.AgentDeskQuest.markerFor;
  const st = { quests: { 'PROJ-1': { kind: 'session', sessionId: 's1', at: 1 }, 'PROJ-2': { kind: 'session', sessionId: 's2', at: 1, reportAt: 5 }, 'PROJ-3': { kind: 'worktree', repo: 'api', at: 1 } } };
  assert.equal(M(st, 's1', true), true);
  assert.equal(M(st, 's1', false), false, 'not live');
  assert.equal(M(st, 's2', true), false, 'reported');
  assert.equal(M(st, 's3', true), false, 'other session');
  assert.equal(M(st, '', true), false);
  assert.equal(M(null, 's1', true), false);
  assert.equal(M({ quests: { x: { kind: 'worktree', sessionId: 's1', at: 1 } } }, 's1', true), false, 'worktree entries have no marker');
  assert.equal(M({}, 's1', true), false);
});

test('quest marker: drawn in the seated seat path, memoized per quest file', () => {
  match(html, /if \(!sess\.isSub && questMarked\(sess\.id, sess\.connected && sess\.ended !== true\)\) questDrawMarker\(ctx, seat\.chairX \+ 12, headY \+ 2, now, ch\.alpha\);/);
  const a2 = html.indexOf('let questMarkFile'), b2 = html.indexOf('function questDrawMarker(');
  const sb = { quest: { file: { quests: { A: { kind: 'session', sessionId: 's1', at: 1 }, B: { kind: 'session', sessionId: 's2', at: 1, reportAt: 2 } } } }, jiraDispatch: {}, AgentDeskQuest: globalThis.AgentDeskQuest, Set, Object, Date };
  vm.createContext(sb); vm.runInContext(html.slice(a2, b2) + ';globalThis.m = questMarked;', sb);
  assert.equal(sb.m('s1', true), true); assert.equal(sb.m('s2', true), false); assert.equal(sb.m('s9', true), false);
  assert.equal(sb.m('s1', false), false, 'ended / disconnected session: no marker');
  sb.quest.file = { quests: {} }; assert.equal(sb.m('s1', true), false, 'cache follows the new state file');
});

test('quest dock fix round 1: Esc closes the modal first, panel closes never shrink under a modal, backdrop click guard', () => {
  const esc = html.slice(html.indexOf("document.addEventListener('keydown', e => {\n  if (e.key === 'Escape') {"));
  assert.ok(esc.indexOf("$('team-modal')") < esc.indexOf('if (sbDockOpen)'), 'team-modal before dock sheets');
  match(html, /if \(dockOn\) closeTeamModal\(\);   \/\/ never shrink/);
  match(html, /if \(dockOn\) closeTeamModal\(\);\n    sbDockOpen = false;/);
  match(html, /teamModalClosedAt = Date\.now\(\)/);
  match(html, /questDockOpen && Date\.now\(\) - teamModalClosedAt > 300/);
});

test('quest dock fix round 1: disconnected dock variant points at the Jira page with a button', () => {
  const { sb, q: Q } = boot();
  sb.dockLeave = page => { sb.left = page; };
  const root = { id: 'q-dock-body', isConnected: true, innerHTML: '', addEventListener() {}, classList: { add() {} } };
  sb.jiraConn = { connected: false, error: 'x' };
  Q.questRender(root);
  assert.match(root.innerHTML, /Jira 페이지에서 연결하세요/);
  assert.match(root.innerHTML, /data-q="jira"/);
  assert.doesNotMatch(root.innerHTML, /연결 설정/);
  match(html, /else if \(act === 'jira'\) dockLeave\('jira'\);/);
  match(html, /'Jira 페이지에서 연결하세요': 'Connect on the Jira page'/);
});

// ── final review fixes ──
const cardOf = (root, key) => { const i = root.innerHTML.indexOf(`<div class="qb-card" data-key="${key}"`); return root.innerHTML.slice(i, root.innerHTML.indexOf('<div class="qb-card"', i + 1) > 0 ? root.innerHTML.indexOf('<div class="qb-card"', i + 1) : undefined); };
const colOf = (root, key) => { const h = root.innerHTML, i = h.indexOf(`data-key="${key}"`); return h.slice(h.lastIndexOf('data-group="', i) + 12, h.indexOf('"', h.lastIndexOf('data-group="', i) + 12)); };
test('quest final: ended or stuck quests can be reassigned (Jira 진행 중, ended session, dead worktree)', () => {
  const { sb, q: Q } = boot();
  const root = { isConnected: true, innerHTML: '', addEventListener() {}, classList: { add() {} } };
  sb.sessions = [sess('s1', 'running')]; sb.handles.set('s1', 'h1');
  const ip = k => ({ key: k, summary: k, status: 'Doing', cat: 'indeterminate', priority: 'High', labels: [] });
  sb.jb.issues = [ip('PROJ-1'), ip('PROJ-2'), ip('PROJ-3'), ip('PROJ-4'), ip('PROJ-5'), ip('PROJ-6'), ip('PROJ-7')];
  Q.quest.file = { quests: {
    'PROJ-2': { kind: 'session', sessionId: 'gone', at: 1 },     // ended session
    'PROJ-3': { kind: 'session', sessionId: 's1', at: 1 },       // live session → no 맡기기
    'PROJ-4': { kind: 'worktree', repo: 'api', at: 1 },          // dispatch timed out
    'PROJ-5': { kind: 'worktree', repo: 'api', at: 1 },          // mapped session gone
    'PROJ-6': { kind: 'worktree', repo: 'api', at: 1 },          // mapped to a live session → no 맡기기
    'PROJ-7': { kind: 'worktree', repo: 'api', at: 1 },          // still starting (not mapped yet) → no 맡기기
  } };
  sb.jiraDispatch = { 'PROJ-4': { key: 'PROJ-4', state: 'timeout' }, 'PROJ-5': { key: 'PROJ-5', state: 'sent', sid: 'dead' }, 'PROJ-6': { key: 'PROJ-6', state: 'sent', sid: 's1' }, 'PROJ-7': { key: 'PROJ-7', state: 'sent', sid: '' } };
  Q.questRender(root);
  for (const k of ['PROJ-1', 'PROJ-2', 'PROJ-4', 'PROJ-5']) { assert.match(cardOf(root, k), /data-q="open"/, k); assert.match(cardOf(root, k), /data-q="auto"/, k); }
  for (const k of ['PROJ-3', 'PROJ-6', 'PROJ-7']) assert.doesNotMatch(cardOf(root, k), /data-q="open"/, k);
  assert.match(cardOf(root, 'PROJ-4'), /종료됨/); assert.match(cardOf(root, 'PROJ-5'), /종료됨/);
  for (const k of ['PROJ-1', 'PROJ-2', 'PROJ-4', 'PROJ-5', 'PROJ-6']) assert.equal(colOf(root, k), 'doing', k);   // Jira says 진행 중
  // the picker opens on such a card too
  Q.quest.picker = 'PROJ-4'; Q.questRender(root); assert.match(cardOf(root, 'PROJ-4'), /qb-pick/);
  // a discarded dispatch or a missing record also ends a worktree quest; a Jira 'new' ticket goes back to 새 퀘스트
  sb.jb.issues = [{ key: 'PROJ-8', summary: 'x', cat: 'new', labels: [] }, { key: 'PROJ-9', summary: 'x', cat: 'new', labels: [] }];
  Q.quest.file = { quests: { 'PROJ-8': { kind: 'worktree', repo: 'api', at: 1 }, 'PROJ-9': { kind: 'worktree', repo: 'api', at: 1 } } };
  sb.jiraDispatch = { 'PROJ-8': { key: 'PROJ-8', state: 'discarded' } };
  Q.questRender(root);
  for (const k of ['PROJ-8', 'PROJ-9']) { assert.equal(colOf(root, k), 'new', k); assert.match(cardOf(root, k), /data-q="open"/, k); }
  match(fn('questRender'), /AgentDeskQuest\.questView\(questIssues\(\), quest\.file, live, questWorktrees\(\)\)/);
});

test('quest final: desk errors show a short fixed reason under 직접 고르세요', () => {
  const { q: Q } = boot();
  const why = { failed: 'claude CLI를 실행하지 못했습니다', timeout: '응답이 늦어 중단했습니다', busy: '다른 제안이 진행 중입니다', invalid: '제안이 목록에 없습니다' };
  for (const [code, text] of Object.entries(why)) {
    Q.quest.errors.set('PROJ-1', code);
    const h = Q.questCardHtml({ key: 'PROJ-1', title: 't', difficulty: 1, group: 'new', status: '' });
    assert.match(h, /직접 고르세요/); assert.ok(h.includes(`<span class="qb-why">${text}</span>`), code);
  }
  for (const code of ['stale', 'ENOENT: spawn claude', '__proto__']) {
    Q.quest.errors.set('PROJ-1', code);
    const h = Q.questCardHtml({ key: 'PROJ-1', title: 't', difficulty: 1, group: 'new', status: '' });
    assert.match(h, /직접 고르세요/); assert.doesNotMatch(h, /qb-why/, code); assert.ok(!h.includes('ENOENT'));
  }
  for (const text of Object.values(why)) match(html, new RegExp(`'${text}': '[A-Za-z]`));
});

test('quest final: prune sends project keys only after a complete, successful load', () => {
  const { q: Q } = boot();
  assert.deepEqual([...Q.questPruneProjects([{ key: 'PROJ-1' }, { key: 'PROJ-2' }, { key: 'OPS-3' }, { key: 'bad' }, null], true)], ['PROJ', 'OPS']);
  assert.deepEqual([...Q.questPruneProjects([{ key: 'PROJ-1' }], false)], []);
  match(html, /window\.orca\.questPrune\(\{ issues: jb\.issues, projects: jb\.truncated \? \[\] : \[jb\.project\] \}\)/);
  match(html, /if \(r && r\.ok !== false && window\.orca\.questPrune\) Promise\.resolve\(window\.orca\.questPrune\(\{ issues: jiraIssues, projects: questPruneProjects\(jiraIssues, jiraIssues\.length < 50\) \}\)\)/);
  match(html, /window\.orca\.jiraList\(\{ filter: jiraFilter, limit: 50 \}\)/);
  // the board prune runs after the early returns of a failed board load
  const jbl = html.slice(html.indexOf("const r = await window.orca.jiraBoard(jb.project"), html.indexOf('function jbBuildCols('));
  assert.ok(jbl.indexOf("if (!r || r.ok === false)") < jbl.indexOf('questPrune'));
});

test('quest final: a worktree quest marks the seat of its mapped live session', () => {
  const a2 = html.indexOf('let questMarkFile'), b2 = html.indexOf('function questDrawMarker(');
  const sb = { quest: { file: { quests: { A: { kind: 'worktree', repo: 'api', at: 1 }, B: { kind: 'worktree', repo: 'api', at: 1, reportAt: 2 }, C: { kind: 'worktree', repo: 'api', at: 1 } } } },
    jiraDispatch: { A: { state: 'sent', sid: 'w1' }, B: { state: 'sent', sid: 'w2' }, C: { state: 'timeout', sid: 'w3' } }, AgentDeskQuest: globalThis.AgentDeskQuest, Set, Object, Date };
  vm.createContext(sb); vm.runInContext(html.slice(a2, b2) + ';globalThis.m = questMarked;', sb);
  assert.equal(sb.m('w1', true), true); assert.equal(sb.m('w1', false), false, 'not live');
  assert.equal(sb.m('w2', true), false, 'reported'); assert.equal(sb.m('w3', true), false, 'timed out');
  // the mapping arrives after the state file: picked up within a second without a new file
  sb.jiraDispatch.A.sid = ''; sb.quest.file = { quests: { ...sb.quest.file.quests } }; assert.equal(sb.m('w1', true), false);
  sb.jiraDispatch.A.sid = 'w4'; vm.runInContext('questMarkAt = 0;', sb); assert.equal(sb.m('w4', true), true);
});

test('quest mode hides the board columns and styles the card buttons', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(html, /\.jb-cols\[hidden\][^{]*\{ display: none; \}/);
  assert.match(html, /\.qb-card button \{ appearance: none;/);
});

test('a proposal is labelled as the AI\'s, and a worktree opened from it starts with autopilot off', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="qb-prop"><span class="qb-ai" title="\$\{escA\(t\('티켓 내용을 읽고 AI가 고른 제안입니다/);
  assert.match(html, /id="jira-wt-auto"\$\{preselect \? '' : ' checked'\}/);
  // only the proposal path passes a preselected repo
  assert.deepEqual([...html.matchAll(/(?<!function )jiraWorktreeModal\(key, ([^)]+)\)/g)].map(m => m[1]), ['ok.repo']);
});

test('quest board header: 보드 and 담당자 pickers, 담당자 defaults to me and filters the cards', () => {
  const { sb, q: Q } = boot();
  sb.jb.me = { accountId: 'me1', displayName: 'Alex' };
  sb.jb.projects = [{ key: 'PROJ', name: 'Project' }, { key: 'OPS', name: 'Ops' }]; sb.jb.project = 'PROJ';
  const iss = (key, who) => ({ key, summary: 'S ' + key, status: 'To Do', statusCategory: 'new', priority: 'Low', labels: [], assigneeId: who || '', assignee: who ? 'N ' + who : '' });
  sb.jb.issues = [iss('PROJ-1', 'me1'), iss('PROJ-2', 'p2'), iss('PROJ-3', '')];
  const root = { isConnected: true, innerHTML: '', addEventListener() {}, classList: { add() {} } };
  Q.questRender(root);
  assert.match(root.innerHTML, /<select data-qf="project"[^>]*><option value="PROJ" selected>/);
  assert.match(root.innerHTML, /<option value="me" selected>나 \(Alex\)<\/option>/);
  assert.match(root.innerHTML, /<option value="p2">N p2<\/option>/);
  assert.ok(root.innerHTML.includes('S PROJ-1') && !root.innerHTML.includes('S PROJ-2') && !root.innerHTML.includes('S PROJ-3'), 'default: mine only');
  const pick = w => { vm.runInContext(`questWhoPref = ${JSON.stringify(w)}`, sb); Q.questRender(root); return ['PROJ-1', 'PROJ-2', 'PROJ-3'].filter(k => root.innerHTML.includes('S ' + k)); };
  assert.deepEqual(pick('none'), ['PROJ-3']);
  assert.deepEqual(pick('all'), ['PROJ-1', 'PROJ-2', 'PROJ-3']);
  assert.deepEqual(pick('p2'), ['PROJ-2']);
  assert.deepEqual(pick('gone-person'), ['PROJ-1'], 'someone no longer on the board falls back to me');
  sb.jb.me = null;
  assert.deepEqual(pick('me'), ['PROJ-1', 'PROJ-2', 'PROJ-3'], 'no profile yet: everything');
});

test('quest board header: changes are wired, the choice is remembered, the Skillbook look is on', () => {
  const src = html.slice(html.indexOf('function questWire('), html.indexOf('// the tickets the view shows'));
  assert.match(src, /f\.dataset\.qf === 'who'\) \{ questWhoPref = f\.value; try \{ localStorage\.setItem\('roca-quest-who', f\.value\)/);
  assert.match(src, /f\.dataset\.qf === 'project' && jb\.projects\.some\(p => p\.key === f\.value\)\) \{[^}]*jbSavePrefs\(\);[^}]*jiraLoad\(\);/);
  assert.match(html, /root\.classList\.add\('qb-book'\);/);
  assert.match(html, /\.qb-book \{[^}]*background: #3b2a1f;[^}]*font-family: 'Galmuri9'/);   // the Skillbook's frame and font
  assert.match(html, /\.qb-book \.qb-col \{[^}]*background: #f3e6c8;/);   // a parchment page per group
  assert.ok(!html.includes('qb-wood'), 'the wooden board is gone');
});

test('dock panels: a click outside AgentDesk (window blur) closes 🗡 and 📖, not under a modal', () => {
  const i = html.indexOf("// the 🗡 quest and 📖 skillbook panels close the same way");
  assert.ok(i > 0);
  const src = html.slice(i, html.indexOf('});', i) + 3);
  assert.match(src, /window\.addEventListener\('blur', \(\) => \{\n  if \(!dockOn \|\| \$\('team-modal'\)\) return;\n  if \(questDockOpen\) questDockToggle\(false\);\n  if \(sbDockOpen\) sbDockToggle\(false\);/);
  // inside the window, both already close on any click outside them
  assert.match(html, /document\.addEventListener\('click', e => \{ if \(sbDockOpen && !e\.composedPath\(\)\.some\(n => n\.id === 'sb-dock' \|\| n\.id === 'dock-sb'\)\) sbDockToggle\(false\); \}\);/);
  assert.match(html, /document\.addEventListener\('click', e => \{ if \(questDockOpen && /);
});

test('dock quest panel scrolls inside itself (the book does not grow past the panel)', () => {
  match(html, /\.q-dock \.qb-book \{ padding: 6px !important; flex: 1 1 auto; min-height: 0; overflow-y: auto; \}/);
});
