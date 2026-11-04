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
  match(fn('questRender'), /AgentDeskQuest\.questView\(questIssues\(\), quest\.file, live\)/);
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
  match(html, /window\.orca\.questPrune\(\{ issues: jb\.issues \}\)/);
  match(html, /window\.orca\.questPrune\(\{ issues: jiraIssues \}\)/);
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
    sessions: [], handles: new Map(), nowSummaries: new Map(), jb: { issues: [], q: '', who: new Set(), err: '' }, jiraIssues: [], jiraDetail: new Map(),
    jiraBoardMode: true, jiraBusy: false, jiraErr: '', jiraConn: null,
    dockPermMap: () => new Map(), hookStateFor: () => null, skillCastOf: () => null,
    jiraSessionModal: rec('jiraSessionModal'), jiraWorktreeModal: rec('jiraWorktreeModal'), jbBarRender() {}, jiraRender() {},
    window: { orca: { onHookEvents() {}, questState: async () => ({ quests: {} }), questAssign: rec('questAssign'), questReport: rec('questReport'), questDeskCancel: rec('questDeskCancel'),
      repos: async () => ({ result: { repos: [{ id: 'r1', displayName: 'api', path: '/w/api' }] } }),
      questDesk: rec('questDesk'), terminalSend: rec('terminalSend'), worktreeCreate: rec('worktreeCreate') } },
  };
  vm.createContext(sb);
  vm.runInContext(q + '\n;globalThis.__q = { quest, questAuto, questAccept, questPick, questCardHtml, questPickerHtml, questParty, questRepoList, questRender, questWire, questCancel, QUEST_PROPOSAL_MS };', sb);
  return { sb, calls, q: sb.__q };
}
const sess = (id, status, extra = {}) => ({ id, name: id, status, connected: true, repo: 'api', cwd: '/w/api/x', branch: 'b', ...extra });
const tick = () => new Promise(r => setTimeout(r, 5));

test('quest behavior: 자동 never calls a modal, send, worktree create or questAssign', async () => {
  const { sb, calls, q: Q } = boot({ questDesk: async () => ({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'idle in api' }) });
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1'); sb.jb.issues = [{ key: 'EP-1', summary: 'x', priority: 'High', labels: [] }];
  await Q.questAuto('EP-1');
  assert.equal(Q.quest.proposals.get('EP-1').id, 's1');
  assert.deepEqual(calls.map(c => c[0]).filter(n => n !== 'questDesk'), []);
});

test('quest behavior: accepting a stale proposal is blocked (busy, permission-waiting, ended, expired)', async () => {
  for (const mutate of [s => { s.status = 'running'; }, s => { s.needsInput = true; }, s => { s.connected = false; }, null]) {
    const { sb, calls, q: Q } = boot();
    const s = sess('s1', 'waiting'); sb.sessions = [s]; sb.handles.set('s1', 'h1');
    Q.quest.proposals.set('EP-1', { kind: 'session', id: 's1', label: 's1', reason: 'r', at: mutate ? Date.now() : Date.now() - Q.QUEST_PROPOSAL_MS - 1000 });
    if (mutate) mutate(s);
    await Q.questAccept('EP-1');
    assert.equal(calls.filter(c => /Modal/.test(c[0])).length, 0);
    assert.equal(Q.quest.proposals.has('EP-1'), false);
    assert.ok(Q.quest.errors.has('EP-1'));
  }
  const { sb, calls, q: Q } = boot();
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1');
  Q.quest.proposals.set('EP-1', { kind: 'session', id: 's1', label: 's1', reason: 'r', at: Date.now() });
  await Q.questAccept('EP-1');
  assert.deepEqual(calls.filter(c => /Modal/.test(c[0])), [['jiraSessionModal', 'EP-1', 's1']]);
  Q.quest.proposals.set('EP-1', { kind: 'worktree', repo: 'gone', label: 'gone', reason: 'r', at: Date.now() });
  await Q.questAccept('EP-1');
  assert.equal(calls.filter(c => /Modal/.test(c[0])).length, 1);
});

test('quest behavior: picking a busy session does not open the modal', () => {
  const { sb, calls, q: Q } = boot();
  sb.sessions = [sess('s1', 'running')]; sb.handles.set('s1', 'h1');
  Q.questPick('EP-1', 's1');
  assert.equal(calls.length, 0);
});

test('quest behavior: a cancelled ask cannot overwrite a newer one', async () => {
  let n = 0; const resolvers = [];
  const { sb, q: Q } = boot({ questDesk: () => new Promise(r => resolvers.push(r)) });
  sb.sessions = [sess('s1', 'waiting')]; sb.handles.set('s1', 'h1');
  const first = Q.questAuto('EP-1'); await tick();
  Q.questCancel('EP-1');
  const second = Q.questAuto('EP-1'); await tick();
  resolvers[0]({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'old' }); await first;
  assert.equal(Q.quest.proposals.has('EP-1'), false);
  assert.ok(Q.quest.pending.has('EP-1'));
  resolvers[1]({ ok: true, choice: { kind: 'session', id: 's1' }, reason: 'new' }); await second;
  assert.equal(Q.quest.proposals.get('EP-1').reason, 'new');
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
  const card = Q.questCardHtml({ key: 'EP-1', title: evil, difficulty: 2, group: 'new', status: '', assignee: evil });
  Q.quest.picker = 'EP-1';
  const html2 = Q.questCardHtml({ key: 'EP-1', title: evil, difficulty: 2, group: 'new', status: '' }) + Q.questPickerHtml('EP-1');
  for (const h of [card, html2]) assert.ok(!/<img/.test(h), 'raw tag leaked');
  assert.ok(html2.includes('&lt;img'));
});

test('quest behavior: render shows load / error / not-connected states', () => {
  const { sb, q: Q } = boot();
  const root = { isConnected: true, innerHTML: '', addEventListener() {} };
  sb.jiraBusy = true; Q.questRender(root); assert.match(root.innerHTML, /불러오는 중/);
  sb.jiraBusy = false; sb.jb.err = 'boom'; Q.questRender(root); assert.match(root.innerHTML, /boom/);
  sb.jb.err = ''; sb.jiraConn = { connected: false, error: 'sign in' }; Q.questRender(root); assert.match(root.innerHTML, /sign in/);
  sb.jiraConn = null; Q.questRender(root); assert.match(root.innerHTML, /표시할 티켓이 없습니다/);
  sb.jiraBoardMode = false; sb.jiraIssues = [{ key: 'EP-2', summary: 'list mode', status: 'To Do', priority: 'Low', labels: [] }]; Q.questRender(root); assert.match(root.innerHTML, /list mode/);
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
test('quest dock: 🗡 button with an I18N title, shared dockSheetOpen mutual exclusion with 📥/📖', () => {
  match(html, /<button class="dock-btn" id="dock-q"/);
  match(html, /\['dock-q', '도크: 퀘스트'\]/);
  match(html, /'도크: 퀘스트': 'Quests'/);
  match(html, /const dockSheetOpen = \(\) => inboxQOpen \|\| sbDockOpen \|\| questDockOpen;/);
  match(html, /dockFullPop = k => [^\n]*'quest'/);
  match(html, /if \(questDockOpen\) return 'quest';/);
  const tog = html.slice(html.indexOf('function questDockToggle('), html.indexOf("$('q-dock').addEventListener('keydown'"));
  match(tog, /if \(inboxQOpen\) inboxToggle\(false\);\s*if \(sbDockOpen\) sbDockToggle\(false\);/);
  const sbT = html.slice(html.indexOf('function sbDockToggle('), html.indexOf("$('sb-dock').addEventListener('keydown'"));
  match(sbT, /if \(questDockOpen\) questDockToggle\(false\);/);
  const inb = html.slice(html.indexOf('function inboxToggle('), html.indexOf('function inboxToggle(') + 1500);
  match(inb, /questDockToggle\(false\)/);
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
  const root = { isConnected: true, innerHTML: '', addEventListener() {} };
  sb.jiraConn = { connected: false, error: '' }; assert.doesNotThrow(() => Q.questRender(root));
  assert.match(root.innerHTML, /Jira가 연결되지 않았습니다/);
});

test('quest marker: AgentDeskQuest.markerFor conditions', () => {
  const M = globalThis.AgentDeskQuest.markerFor;
  const st = { quests: { 'EP-1': { kind: 'session', sessionId: 's1', at: 1 }, 'EP-2': { kind: 'session', sessionId: 's2', at: 1, reportAt: 5 }, 'EP-3': { kind: 'worktree', repo: 'api', at: 1 } } };
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
  const sb = { quest: { file: { quests: { A: { kind: 'session', sessionId: 's1', at: 1 }, B: { kind: 'session', sessionId: 's2', at: 1, reportAt: 2 } } } }, AgentDeskQuest: globalThis.AgentDeskQuest, Set, Object };
  vm.createContext(sb); vm.runInContext(html.slice(a2, b2) + ';globalThis.m = questMarked;', sb);
  assert.equal(sb.m('s1', true), true); assert.equal(sb.m('s2', true), false); assert.equal(sb.m('s9', true), false);
  assert.equal(sb.m('s1', false), false, 'ended / disconnected session: no marker');
  sb.quest.file = { quests: {} }; assert.equal(sb.m('s1', true), false, 'cache follows the new state file');
});

test('quest dock fix round 1: Esc closes the modal first, panel closes never shrink under a modal, backdrop click guard', () => {
  const esc = html.slice(html.indexOf("document.addEventListener('keydown', e => {\n  if (e.key === 'Escape') {"));
  assert.ok(esc.indexOf("$('team-modal')") < esc.indexOf('if (inboxQOpen)'), 'team-modal before dock sheets');
  match(html, /if \(dockOn\) closeTeamModal\(\);   \/\/ never shrink/);
  match(html, /if \(!inboxQOpen\) \{ if \(dockOn\) closeTeamModal\(\);/);
  match(html, /if \(dockOn\) closeTeamModal\(\);\n    sbDockOpen = false;/);
  match(html, /teamModalClosedAt = Date\.now\(\)/);
  match(html, /questDockOpen && Date\.now\(\) - teamModalClosedAt > 300/);
});

test('quest dock fix round 1: disconnected dock variant points at the Jira page with a button', () => {
  const { sb, q: Q } = boot();
  sb.dockLeave = page => { sb.left = page; };
  const root = { id: 'q-dock-body', isConnected: true, innerHTML: '', addEventListener() {} };
  sb.jiraConn = { connected: false, error: 'x' };
  Q.questRender(root);
  assert.match(root.innerHTML, /Jira 페이지에서 연결하세요/);
  assert.match(root.innerHTML, /data-q="jira"/);
  assert.doesNotMatch(root.innerHTML, /연결 설정/);
  match(html, /else if \(act === 'jira'\) dockLeave\('jira'\);/);
  match(html, /'Jira 페이지에서 연결하세요': 'Connect on the Jira page'/);
});
