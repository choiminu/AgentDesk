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
const fn = name => { const i = q.indexOf(`function ${name}(`); const j = q.indexOf('\nfunction ', i + 1); return i < 0 ? '' : q.slice(i, j < 0 ? undefined : j); };
const modal = name => { const i = html.indexOf(`async function ${name}(`); return html.slice(i, html.indexOf('\nasync function ', i + 1) > 0 ? html.indexOf('\nasync function ', i + 1) : undefined); };

test('quest ui: 퀘스트 mode switch on the board and core/quest.js loaded', () => {
  assert.ok(q.length > 1500, 'quest section exists');
  match(html, /<script src="core\/quest\.js"><\/script>/);
  match(html, /data-jb="quest"/);
  match(html, /act === 'quest'/);
  match(html, /id="jb-quest"/);
  match(html, /if \(questOn\) \{[\s\S]{0,160}questRender\(qe\)/);
});

test('quest ui: cards render through questRender(root) into any container, state kept outside the DOM', () => {
  match(q, /function questRender\(root\)/);
  match(fn('questRender'), /AgentDeskQuest\.questView\(jb\.issues, quest\.file, live\)/);
  match(q, /const quest = \{ file: [^\n]*proposals: new Map\(\), pending: new Set\(\)/);
  match(q, /for \(const \[g, label\] of \[\]\)|QUEST_GROUPS = \[\['new', '새 퀘스트'\], \['doing', '진행 중'\], \['report', '보고 대기'\], \['done', '완료'\]\]/);
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
  match(wire, /act === 'accept'[\s\S]*jiraSessionModal\(key, p\.id\)[\s\S]*jiraWorktreeModal\(key, p\.repo\)/);
  match(q, /AgentDeskQuest\.acceptProposal\(/);
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
