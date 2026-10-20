// Tests for the Jira ticket panel logic (core/jira.js).
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/jira.js');
const J = globalThis.AgentDeskJira;

const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '첫 줄' }, { type: 'hardBreak' }, { type: 'text', text: '둘째 줄' }] }, { type: 'paragraph', content: [{ type: 'text', text: '다음 문단' }] }] };

test('isKey accepts project keys and rejects anything else', () => {
  assert.equal(J.isKey('EP-1234'), true); assert.equal(J.isKey('ICV2-7'), true);
  for (const bad of ['ep-1', 'EP-', '-EP-1', 'EP-1; rm -rf /', '1A-2', '', null, 42]) assert.equal(J.isKey(bad), false, String(bad));
});

test('normalizeIssue reads the raw Jira REST shape (fields + ADF description)', () => {
  const i = J.normalizeIssue({ key: 'EP-1', fields: { summary: '정산 확인', status: { name: 'In Progress' }, priority: { name: 'High' }, assignee: { displayName: 'Neo' }, labels: ['recon'], description: adf } });
  assert.deepEqual({ ...i, url: undefined, updated: undefined }, { key: 'EP-1', summary: '정산 확인', status: 'In Progress', priority: 'High', assignee: 'Neo', labels: ['recon'], description: '첫 줄\n둘째 줄\n다음 문단', url: undefined, updated: undefined });
});

test('normalizeIssue reads a flat shape with plain strings and caps the description', () => {
  const i = J.normalizeIssue({ issueKey: 'OPS-9', title: 'Flat', status: 'Done', assignee: 'kim', description: 'x'.repeat(5000), url: 'https://j/browse/OPS-9' });
  assert.equal(i.key, 'OPS-9'); assert.equal(i.summary, 'Flat'); assert.equal(i.status, 'Done'); assert.equal(i.assignee, 'kim');
  assert.equal(i.description.length, 2500); assert.equal(i.url, 'https://j/browse/OPS-9');
  assert.equal(J.normalizeIssue({ key: 'not a key' }), null); assert.equal(J.normalizeIssue(null), null);
});

test('issuesFrom accepts several list envelopes and drops invalid rows', () => {
  const rows = [{ key: 'AB-1', summary: 'one' }, { key: 'bad' }, { key: 'BC-2', summary: 'two' }];
  for (const res of [{ ok: true, result: { issues: rows } }, { ok: true, result: { items: rows } }, { ok: true, result: rows }, { result: { data: { issues: rows } } }])
    assert.deepEqual(J.issuesFrom(res).map(i => i.key), ['AB-1', 'BC-2']);
  assert.deepEqual(J.issuesFrom({ ok: false, error: { message: 'No matching connected Jira site' } }), []);
  assert.equal(J.issueFrom({ ok: true, result: { issue: { key: 'CD-3', summary: 's' } } }).key, 'CD-3');
  assert.equal(J.issueFrom({ ok: true, result: { key: 'CD-4', fields: { summary: 's' } } }).key, 'CD-4');
});

test('connectionFrom: the real "no site" reply is disconnected; errors carry their message', () => {
  assert.deepEqual(J.connectionFrom({ ok: true, result: { connected: false, viewer: null, sites: [], activeSiteId: null } }), { connected: false, sites: [], error: '' });
  assert.equal(J.connectionFrom({ ok: true, result: { connected: true, sites: [{ id: 's1' }] } }).connected, true);
  assert.equal(J.connectionFrom({ ok: false, error: { code: 'x', message: 'boom' } }).error, 'boom');
  assert.equal(J.connectionFrom({ ok: false, error: 'CLI missing' }).error, 'CLI missing');
});

test('worktreeName lowercases and strips unsafe characters', () => {
  assert.equal(J.worktreeName('EP-1234'), 'ep-1234');
  assert.equal(J.worktreeName('A_B/../C-1'), 'a-b-c-1');
  assert.equal(J.worktreeName(''), 'jira-ticket');
});

const issue = { key: 'EP-7', summary: '대사 오류', status: 'To Do', priority: 'High', labels: ['recon'], description: '입금대사 불일치' };

test('worktreePrompt: guidance first, ticket facts, REPORT hint, autopilot last only when asked', () => {
  const p = J.worktreePrompt(issue, { guidance: '로그부터 확인', autopilot: true });
  assert.ok(p.indexOf('로그부터 확인') < p.indexOf('EP-7'));
  assert.ok(p.includes('입금대사 불일치') && p.includes(J.REPORT_HINT));
  assert.ok(p.trimEnd().endsWith('autopilot'));
  assert.ok(!J.worktreePrompt(issue, {}).includes('autopilot'));
  assert.ok(!J.worktreePrompt(issue, {}).includes('접근 지침'));
});

test('sessionMessage puts the guidance before the ticket and requires guidance', () => {
  const m = J.sessionMessage(issue, '테스트 DB만 사용');
  const g = m.indexOf('테스트 DB만 사용'), k = m.indexOf('EP-7'), r = m.indexOf('REPORT_START');
  assert.ok(g >= 0 && g < k && k < r);
  assert.equal(J.sessionMessage(issue, '   '), '');
  assert.ok(J.sessionMessage(issue, 'x', 'en').startsWith('Before reading the ticket'));
});

test('extractReport takes the last real block and ignores the echoed format hint', () => {
  assert.equal(J.extractReport(`> 지시 … ${J.REPORT_HINT}`), null);
  assert.equal(J.extractReport('no block here'), null);
  const screen = `> 지시 ${J.REPORT_HINT}\n⏺ 작업 완료\nREPORT_START\n[한 일] 쿼리 수정\n[변경 파일] a.sql\nREPORT_END`;
  assert.equal(J.extractReport(screen), '[한 일] 쿼리 수정\n[변경 파일] a.sql');
  assert.equal(J.extractReport('REPORT_START\n[한 일] 끝까지 출력 안 됨'), '[한 일] 끝까지 출력 안 됨');
});

test('reportToComment adds a header, strips markers and trailing spaces, caps length', () => {
  const c = J.reportToComment('REPORT_START [한 일] 수정   \n\n\n\n[막힌 점] 없음 REPORT_END', { session: 'ep-7' });
  assert.equal(c, 'AgentDesk 에이전트 보고 (ep-7)\n\n[한 일] 수정\n\n[막힌 점] 없음');
  assert.ok(J.reportToComment('y'.repeat(40000)).length <= 30000);
});

test('jqlFor maps each filter to its JQL and falls back to assigned', () => {
  assert.equal(J.jqlFor('assigned'), 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  assert.equal(J.jqlFor('reported'), 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  assert.equal(J.jqlFor('all'), '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated DESC');
  assert.equal(J.jqlFor('done'), 'assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC');
  assert.equal(J.jqlFor('x" OR 1=1'), J.jqlFor('assigned'));
});

test('textToAdf: one paragraph per non-empty line, ``` fences become code blocks', () => {
  const doc = J.textToAdf('첫 줄  \r\n\r\n```sql\nSELECT 1;\n  -- keep indent\n```\n끝');
  assert.equal(doc.type, 'doc'); assert.equal(doc.version, 1);
  assert.deepEqual(doc.content, [
    { type: 'paragraph', content: [{ type: 'text', text: '첫 줄' }] },
    { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT 1;\n  -- keep indent' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '끝' }] },
  ]);
  assert.deepEqual(J.textToAdf('```\nunclosed').content, [{ type: 'codeBlock', content: [{ type: 'text', text: 'unclosed' }] }]);
  assert.deepEqual(J.textToAdf('').content, []);
});

test('tokenNeedsRefresh: missing token or expiry within 60 s', () => {
  const now = 1_000_000;
  assert.equal(J.tokenNeedsRefresh(null, now), true);
  assert.equal(J.tokenNeedsRefresh({ accessToken: 'a' }, now), true);
  assert.equal(J.tokenNeedsRefresh({ accessToken: 'a', expiresAt: now + 59_000 }, now), true);
  assert.equal(J.tokenNeedsRefresh({ accessToken: 'a', expiresAt: now + 61_000 }, now), false);
});

test('pickSite prefers the given URL among Jira sites, else the first Jira site', () => {
  const res = [
    { id: 'c1', url: 'https://conf-only.atlassian.net', scopes: ['read:confluence-content.all'] },
    { id: 'j1', url: 'https://other.atlassian.net', scopes: ['read:jira-work'] },
    { id: 'j2', url: 'https://eximbay.atlassian.net/', scopes: ['read:jira-work', 'write:jira-work'] },
  ];
  assert.equal(J.pickSite(res, 'https://eximbay.atlassian.net').id, 'j2');
  assert.equal(J.pickSite(res, 'https://missing.atlassian.net').id, 'j1');
  assert.deepEqual(J.jiraSites(res).map(s => s.id), ['j1', 'j2']);
  assert.equal(J.pickSite([], 'x'), null);
});

// ── Kanban board ──
const st = (id, name, cat) => ({ id, name, statusCategory: { key: cat } });
const types = [
  { name: 'Task', statuses: [st('1', 'NEW', 'new'), st('3', 'In Progress', 'indeterminate'), st('5', 'DONE', 'done'), st('2', 'Triage', 'new')] },
  { name: 'Bug', statuses: [st('3', 'In Progress', 'indeterminate'), st('4', 'READY', 'new'), st('6', 'CLOSED', 'done')] },
];

test('boardJql: project, 30-day done window, mine, rank or updated order', () => {
  assert.equal(J.boardJql('EP'), 'project = "EP" AND (statusCategory != Done OR resolved >= -30d) ORDER BY rank ASC');
  assert.equal(J.boardJql('EP', true, 'updated'), 'project = "EP" AND (statusCategory != Done OR resolved >= -30d) AND assignee = currentUser() ORDER BY updated DESC');
});

test('buildColumns: union of statuses deduped by id, ordered by category then Jira order', () => {
  const cols = J.buildColumns(types);
  assert.deepEqual(cols.map(c => c.name), ['NEW', 'Triage', 'READY', 'In Progress', 'DONE', 'CLOSED']);
  assert.deepEqual(cols[0], { id: '1', name: 'NEW', statusIds: ['1'], cat: 'new', hidden: false });
});

test('buildColumns: saved order and hidden columns apply; unknown saved ids are ignored; new ones append', () => {
  const cols = J.buildColumns(types, { order: ['5', 'gone', '1'], hidden: ['6'] });
  assert.deepEqual(cols.map(c => c.id), ['5', '1', '2', '4', '3', '6']);
  assert.equal(cols.find(c => c.id === '6').hidden, true);
});

test('buildColumns: agile board column config wins over statuses', () => {
  const cols = J.buildColumns(types, null, [{ name: 'To Do', statusIds: ['1', '2'] }, { name: 'Doing', statusIds: [3] }, { name: 'Done', statusIds: ['5', '6'] }]);
  assert.deepEqual(cols.map(c => [c.id, c.cat, c.statusIds.join()]), [['b:To Do', 'new', '1,2'], ['b:Doing', 'indeterminate', '3'], ['b:Done', 'done', '5,6']]);
});

test('moveColumn swaps with the neighbour and stops at the edges', () => {
  const cols = J.buildColumns(types);
  assert.deepEqual(J.moveColumn(cols, '2', -1).slice(0, 2), ['2', '1']);
  assert.deepEqual(J.moveColumn(cols, '1', -1), cols.map(c => c.id));
  assert.deepEqual(J.moveColumn(cols, '6', 1), cols.map(c => c.id));
});

test('groupIssues: by status id; unknown status → first column of its category; hidden column drops its issues', () => {
  const cols = J.buildColumns(types, { hidden: ['6'] });
  const iss = [{ key: 'EP-1', statusId: '3', cat: 'indeterminate' }, { key: 'EP-2', statusId: '99', cat: 'done' }, { key: 'EP-3', statusId: '6', cat: 'done' }, { key: 'EP-4', statusId: '98', cat: 'new' }];
  const g = J.groupIssues(cols, iss);
  assert.deepEqual(g.get('3').map(i => i.key), ['EP-1']);
  assert.deepEqual(g.get('5').map(i => i.key), ['EP-2']);
  assert.deepEqual(g.get('1').map(i => i.key), ['EP-4']);
  assert.equal(g.has('6'), false);
  assert.equal([...g.values()].flat().length, 3);
});

test('boardIssue reads status/category, assignee, due, type and subtask progress', () => {
  const i = J.boardIssue({ key: 'EP-1109', fields: { summary: 'S', status: st('3', 'In Progress', 'indeterminate'), priority: { name: 'Medium' }, assignee: { accountId: 'a1', displayName: 'Neo Kim', avatarUrls: { '24x24': 'https://avatar/x.png' } }, duedate: '2026-10-15', issuetype: { name: 'Task' }, subtasks: [{ fields: { status: st('5', 'DONE', 'done') } }, { fields: { status: st('1', 'NEW', 'new') } }] } });
  assert.equal(i.statusId, '3'); assert.equal(i.cat, 'indeterminate'); assert.equal(i.assignee, 'Neo Kim'); assert.equal(i.assigneeId, 'a1');
  assert.equal(i.avatar, 'https://avatar/x.png'); assert.equal(i.due, '2026-10-15'); assert.deepEqual(i.subtasks, { done: 1, total: 2 });
  assert.equal(J.boardIssue({ key: 'EP-1', fields: {} }).subtasks, null);
  assert.equal(J.boardIssue({ key: 'bad' }), null);
});

test('isOverdue: only after the due day ends and never for done issues', () => {
  const at = (y, m, d, h) => new Date(y, m - 1, d, h).getTime();
  assert.equal(J.isOverdue('2026-10-15', 'indeterminate', at(2026, 10, 15, 23)), false);
  assert.equal(J.isOverdue('2026-10-15', 'indeterminate', at(2026, 10, 16, 0)), true);
  assert.equal(J.isOverdue('2026-10-15', 'done', at(2026, 12, 1, 0)), false);
  assert.equal(J.isOverdue('', 'new', at(2026, 12, 1, 0)), false);
  assert.equal(J.formatDue('2026-10-15'), '2026년 10월 15일');
});

test('priorityIcon / typeIcon / initials', () => {
  assert.deepEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest', 'Blocker', ''].map(n => J.priorityIcon(n).icon), ['⇈', '↑', '=', '↓', '⇊', '⇈', '']);
  assert.equal(J.typeIcon('Bug').cls, 'bug'); assert.equal(J.typeIcon('Sub-task').cls, 'sub'); assert.equal(J.typeIcon('Task').cls, 'task');
  assert.equal(J.initials('Neo Kim'), 'NK'); assert.equal(J.initials('최민우'), '민우'); assert.equal(J.initials(''), '?');
});

test('filterIssues: every search word must match key or summary; assignee chips filter by account id', () => {
  const iss = [{ key: 'EP-1', summary: '정산 대사 오류', assigneeId: 'a1' }, { key: 'EP-22', summary: 'Recon batch', assigneeId: 'a2' }, { key: 'EP-3', summary: 'misc', assigneeId: '' }];
  assert.deepEqual(J.filterIssues(iss, { q: 'ep-2' }).map(i => i.key), ['EP-22']);
  assert.deepEqual(J.filterIssues(iss, { q: '정산 오류' }).map(i => i.key), ['EP-1']);
  assert.deepEqual(J.filterIssues(iss, { assignees: new Set(['a2', '']) }).map(i => i.key), ['EP-22', 'EP-3']);
  assert.equal(J.filterIssues(iss, {}).length, 3);
});

test('reportIssues lists missing or empty REPORT sections', () => {
  const J = globalThis.AgentDeskJira;
  assert.deepEqual(J.reportIssues('[한 일] a\n[변경 파일] b.js\n[막힌 점] 없음\n[다음 제안] c'), []);
  assert.deepEqual(J.reportIssues('[한 일] a\n[변경 파일]\n[막힌 점] 없음'), ['변경 파일', '다음 제안']);
  assert.equal(J.reportIssues('').length, 4);
});

test('rememberGuide dedupes, moves to front and caps', () => {
  const J = globalThis.AgentDeskJira;
  assert.deepEqual(J.rememberGuide(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepEqual(J.rememberGuide(['a'], '  '), ['a']);
  assert.equal(J.rememberGuide(Array.from({ length: 10 }, (_, i) => 'x' + i), 'new', 5).length, 5);
});

test('promptTemplates has four presets per language', () => {
  const J = globalThis.AgentDeskJira;
  assert.deepEqual(J.promptTemplates('ko').map(x => x.id), ['analyze', 'implement', 'review', 'report']);
  assert.ok(J.promptTemplates('en').every(x => !/[가-힣]/.test(x.text + x.label)));
});
