// Text that leaves the company network (Jira comments, Slack thread replies) is masked with core/mask.js:
// the comment draft (core/jira.js), the main process before any send (maskForSend), and the Slack bridge (replyPayload).
// Every "secret" below is an obviously fake value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replyPayload } from '../recall/slack-format.mjs';
import { maskRows } from '../team/peer.mjs';
await import('../core/mask.js');
await import('../core/outbound.js');
await import('../core/jira.js');
const { mask, maskForSend, maskWithCount, secretRanges } = globalThis.AgentDeskMask;
const J = globalThis.AgentDeskJira, O = globalThis.AgentDeskOutbound;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CARD = '4111 1111 1111 1111', PASS = 'fake-pass-000', SLACK = 'xoxb-0000000000-FAKEFAKEFAKE', URI = 'mysql://fakeuser:fakepw@db.invalid/fakedb';
const RAW = [CARD, PASS, SLACK, 'fakeuser:fakepw', 'db.invalid', 'fake@example.invalid'];
const REPORT = `REPORT_START
[한 일] 테스트 카드 ${CARD} 로 결제 재현, 담당 fake@example.invalid
[변경 파일] application.yml (password=${PASS})
\`\`\`
SLACK_BOT_TOKEN=${SLACK}
DB_URL=${URI}
\`\`\`
[막힌 점] 없음
REPORT_END`;
const leaks = s => RAW.filter(r => s.includes(r));

test('reportToComment: card number, password=, Slack token, mysql URI, e-mail → [MASKED], no original left', () => {
  const c = J.reportToComment(REPORT, { session: 'ep-7' });
  assert.deepEqual(leaks(c), []);
  assert.match(c, /\[MASKED NUMBER\]/); assert.match(c, /password=\[MASKED\]/); assert.match(c, /\[MASKED URI\]/); assert.match(c, /\[MASKED EMAIL\]/);
  assert.ok((c.match(/\[MASKED/g) || []).length >= 5);
  assert.ok(c.startsWith('AgentDesk 에이전트 보고 (ep-7)'));
});

test('reportToComment takes the mask function from meta (testable without the global)', () => {
  const maskWithCount = s => ({ text: s.replace('secret-ish', 'X'), count: 1 });
  assert.equal(J.reportToComment('[한 일] secret-ish', { maskWithCount }), 'AgentDesk 에이전트 보고\n\n[한 일] X');
});

test('reportToCommentDraft counts markers added in the header (session name) as well as the report', () => {
  const d = J.reportToCommentDraft(`[한 일] 카드 ${CARD}`, { session: 'fake@example.invalid' });
  assert.equal(d.masked, 2);
  assert.ok(d.text.startsWith('AgentDesk 에이전트 보고 ([MASKED EMAIL])'));
  assert.equal(J.reportToComment(`[한 일] 카드 ${CARD}`, { session: 'fake@example.invalid' }), d.text);
});

test('maskWithCount counts only the markers mask() added', () => {
  assert.deepEqual(maskWithCount(`a ${CARD} b`), { text: 'a [MASKED NUMBER] b', count: 1 });
  assert.equal(maskWithCount('already [MASKED] here').count, 0);
  assert.equal(maskWithCount(REPORT).count, 5);
});

test('maskForSend masks before the length cap and rejects empty or non-text bodies', () => {
  // over the cap as sent, under it once the fake private key collapses to one marker: accepted → masking ran first
  const key = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(200)}\n-----END PRIVATE KEY-----`;
  const r = maskForSend('x'.repeat(31900) + key, { max: 32000 });
  assert.equal(r.ok, true); assert.ok(r.text.endsWith('[MASKED PRIVATE KEY]')); assert.equal(r.masked, 1);
  // under the cap as sent, over it once masked: rejected (the cap is checked on what would be sent)
  assert.equal('a@b.invalid'.length, 11);
  assert.deepEqual(maskForSend('a@b.invalid', { max: 12 }), { ok: false, error: 'body is too long after masking' });
  const masked = maskForSend(REPORT, { max: 32000 });
  assert.equal(masked.ok, true); assert.deepEqual(leaks(masked.text), []); assert.equal(masked.masked, 5);
  for (const bad of ['', '   \n\t ', null, undefined, 42, { text: 'x' }]) assert.equal(maskForSend(bad).ok, false, String(bad));
  assert.equal(maskForSend('y'.repeat(32001), { max: 32000 }).ok, false);
  assert.equal(maskForSend('y'.repeat(2000000), { max: 32000, truncate: true }).ok, false, 'huge input refused before masking');
  // truncate (Slack): cut after masking, never before
  const t = maskForSend(`${'y'.repeat(50)} ${CARD}`, { max: 60, truncate: true });
  assert.equal(t.ok, true); assert.equal(t.text.length, 60); assert.deepEqual(leaks(t.text), []);
});

test('replyPayload masks report, text, title and session (code blocks included) before the mrkdwn conversion', () => {
  const p = replyPayload({ title: `EP-1 ${CARD}`, session: 'front-desk', report: REPORT, text: `✅ done ${SLACK}` });
  const all = JSON.stringify(p);
  assert.deepEqual(leaks(all), []);
  assert.match(all, /SLACK_BOT_TOKEN=\[MASKED\]/);
  assert.match(all, /\[MASKED URI\]/);
  assert.deepEqual(replyPayload({ text: `▶ 시작 ${URI}` }), { text: '▶ 시작 [MASKED URI]' });
});

test('widget.html loads core/mask.js before core/jira.js', () => {
  const html = readFileSync(join(root, 'widget.html'), 'utf-8');
  const m = html.indexOf('<script src="core/mask.js"></script>'), j = html.indexOf('<script src="core/jira.js"></script>');
  assert.ok(m > 0 && m < j);
});

// ── security review follow-ups ──
const ZW = '​';
test('mask: bypass shapes from the review are masked (separators, zero-width, full-width, JSON / env / yml keys, JDBC)', () => {
  const cases = {
    [`4111${ZW}1111${ZW}1111${ZW}1111`]: '[MASKED NUMBER]',
    '４１１１１１１１１１１１１１１１': '[MASKED NUMBER]',
    '4111.1111.1111.1111': '[MASKED NUMBER]',
    [`fake${ZW}@example.invalid`]: '[MASKED EMAIL]',
    [`xox${ZW}b-0000000000-FAKEFAKEFAKE`]: '[MASKED]',
    'password = "fake pass 000"': 'password = "[MASKED]"',
    'password=abcde': 'password=[MASKED]',
    'pwd=abcd': 'pwd=[MASKED]',
    'password="a b"': 'password="a b"',
    'DB_PASSWORD=fakepass000': 'DB_PASSWORD=[MASKED]',
    'spring.datasource.password: fakepass000': 'spring.datasource.password: [MASKED]',
    '{"password": "fakepass000"}': '{"password": "[MASKED]"}',
    "{'token':'fake'}": "{'token':'[MASKED]'}",
    'jdbc:oracle:thin:@db.invalid:1521/x': '[MASKED URI]',
    'jdbc:mysql://db.invalid/x?user=u&password=p': '[MASKED URI]',
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(mask(src), want, JSON.stringify(src));
  // a value is masked only once: re-masking is stable and adds no marker
  assert.equal(mask(mask('password="fake pass"')), 'password="[MASKED]"');
  assert.equal(maskWithCount('token=[MASKED]').count, 0);
});

test('mask: line-separated numbers and 20+ digit runs stay; a card the terminal wrapped is masked via maskRows', () => {
  for (const s of ['4111 1111\n1111 1111', '1,200,000\n3,400,000\n5,600,000\n7,800,000', '100\n200\n300\n400\n500', '41111111111111111234', '9'.repeat(40)]) assert.equal(mask(s), s, JSON.stringify(s));
  assert.equal(mask('1 000 000 000 000'), '[MASKED NUMBER]');
  assert.equal(mask('일시 20261021134500'), '일시 [MASKED NUMBER]');
  assert.deepEqual(maskRows(['카드 4111 1111', '1111 1111 끝']), ['카드 [MASKED]', '[MASKED] 끝']);
});

test('mask: harmless full-width / zero-width text and short key values are left as written', () => {
  for (const s of ['token: 5', 'secret: yes', 'pwd=abc', 'api_key=""', 'ＡＢＣ 전각 글자', `zero${ZW}width`, '버전 1.2.3, 2026.10.21', '﻿첫 줄']) assert.equal(mask(s), s);
});

test('secretRanges maps a secret found after normalization back to source positions', () => {
  const src = `ab 4111${ZW}1111${ZW}1111${ZW}1111 cd`;
  const r = secretRanges(src);
  assert.ok(r.some(([a, b]) => a === 3 && b === src.length - 3), JSON.stringify(r));
  const fw = 'x ４１１１１１１１１１１１１１１１';
  assert.ok(secretRanges(fw).some(([a, b]) => a === 2 && b === fw.length));
});

test('mask stays fast on 100 KB adversarial input', () => {
  for (const s of ['1 '.repeat(50000) + 'x', ('1'.repeat(11) + 'a ').repeat(8000), 'password='.repeat(11000), ('４' + ZW).repeat(50000), '"password": "'.repeat(7000)]) {
    const t0 = performance.now(); mask(s.slice(0, 100000)); assert.ok(performance.now() - t0 < 1000, `slow on ${s.slice(0, 20)}`);
  }
});

test('maskForSend refuses input over 100 KB before masking', () => {
  assert.equal(maskForSend('y'.repeat(100000), { max: 200000 }).ok, true);
  assert.deepEqual(maskForSend('y'.repeat(100001), { max: 200000, truncate: true }), { ok: false, error: 'body is too long' });
});

test('replyPayload: icon only from the fixed set, unknown fields ignored, every free-text path escaped', () => {
  const evil = { title: 't', report: '[한 일] ok', icon: 'SECRET 4111111111111111 xoxb-0000000000-FAKEFAKEFAKE <!channel>', extra: '<!here>' };
  const p = replyPayload(evil), all = JSON.stringify(p);
  assert.deepEqual([...O.REPLY_ICONS], ['✅', '⏸', '▶', '⚠️', '⏱']);
  assert.ok(!all.includes('4111111111111111') && !all.includes('xoxb-0000000000') && !all.includes('<!channel>') && !all.includes('<!here>'));
  assert.ok(p.blocks[0].text.text.startsWith('✅ *t*'));
  assert.equal(replyPayload({ title: 't', report: 'x', icon: '⚠️' }).text, '⚠️ t');
  assert.deepEqual(replyPayload({ text: '<!channel> 끝 & <@U123|x>' }), { text: '&lt;!channel&gt; 끝 &amp; &lt;@U123|x&gt;' });
  assert.equal(replyPayload({ title: '<!everyone>', session: '<!here>', report: '[한 일] <!channel>' }).text, '✅ &lt;!everyone&gt; · &lt;!here&gt;');
  assert.ok(!JSON.stringify(replyPayload({ title: 'a', report: '[한 일] <!channel> 끝\n```\n<!here>\n```' }).blocks).match(/<!(channel|here)>/));
});


// ── core/outbound.js: the bodies the main process sends (its IPC handlers only call these) ──
test('prepareJiraComment: masked before the 32,000 cap, empty refused, error says the cap counts after masking', () => {
  const ok = O.prepareJiraComment(REPORT);
  assert.equal(ok.ok, true); assert.deepEqual(leaks(ok.body), []); assert.equal(ok.masked, 5);
  const key = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}\n-----END PRIVATE KEY-----`;
  assert.equal(O.prepareJiraComment('x'.repeat(31900) + key).ok, true, 'over the cap as sent, under it once masked');
  const long = O.prepareJiraComment('a@b.io '.repeat(4500));   // 31,500 as sent, 67,500 once masked
  assert.equal(long.ok, false); assert.match(long.error, /counted after masking/);
  assert.deepEqual(O.prepareJiraComment('  \n '), { ok: false, error: 'comment body is empty' });
  assert.equal(O.prepareJiraComment(null).ok, false);
  assert.equal(O.prepareJiraComment('y'.repeat(100001)).error, 'comment body is too long');
});

test('prepareInboxReply: channel / thread from the saved route only, id checked, unknown task refused', () => {
  const route = { channel: 'C0FAKE01', thread: '1700000000.000100' };
  const evilRoute = { channel: 'C0EVIL99', thread: '1.1' };
  const p = O.prepareInboxReply({ id: '1700-abc', ...evilRoute, text: `✅ done ${CARD}`, report: REPORT, title: 't', session: 's', extra: 'x', blocks: [1] }, route);
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.reply).sort(), ['channel', 'id', 'report', 'session', 'text', 'thread', 'title']);
  assert.equal(p.reply.channel, 'C0FAKE01'); assert.equal(p.reply.thread, '1700000000.000100');
  assert.deepEqual(leaks(JSON.stringify(p.reply)), []); assert.equal(p.masked, 6);
  assert.deepEqual(O.prepareInboxReply({ id: '1700-abc', text: 'x' }, undefined), { ok: false, error: 'unknown task' });
  assert.deepEqual(O.prepareInboxReply({ id: '1700-abc', text: 'x' }, { channel: '<!here>', thread: '1.1' }), { ok: false, error: 'unknown task' });
  for (const id of ['../../x', '', 'a'.repeat(65), 'a b', 42, undefined]) assert.deepEqual(O.prepareInboxReply({ id, text: 'x' }, route), { ok: false, error: 'bad id' }, String(id));
  assert.equal(O.prepareInboxReply({ id: 'a', text: '   ' }, route).error, 'reply body is empty');
});

test('prepareInboxReply: icon from the fixed set, labels masked before they are cut, report masked then cut to 12,000', () => {
  const route = { channel: 'C0FAKE01', thread: '1.2' };
  assert.equal(O.prepareInboxReply({ id: 'a', text: 'x', icon: '⏱' }, route).reply.icon, '⏱');
  assert.equal(O.prepareInboxReply({ id: 'a', text: 'x', icon: `<!channel> ${CARD}` }, route).reply.icon, '✅');
  assert.equal('icon' in O.prepareInboxReply({ id: 'a', text: 'x' }, route).reply, false);
  // a card number straddling the 500-character label cap is masked whole, not cut into a visible prefix
  const t = O.prepareInboxReply({ id: 'a', text: 'x', title: 'y'.repeat(490) + ' ' + CARD }, route).reply.title;
  assert.equal(t.length, 500); assert.ok(!/\d{4}/.test(t), t.slice(-20));
  const rep = O.prepareInboxReply({ id: 'a', text: 'x', report: 'z'.repeat(11990) + ' ' + CARD + ' tail' }, route).reply.report;
  assert.equal(rep.length, 12000); assert.ok(!rep.includes('4111'));
});

test('routeFromTask accepts Slack channel / thread ids only', () => {
  assert.deepEqual(O.routeFromTask({ channel: 'D0FAKE01', thread: '1700000000.000100', x: 1 }), { channel: 'D0FAKE01', thread: '1700000000.000100' });
  for (const bad of [{ channel: 'c0fake', thread: '1.1' }, { channel: 'C0FAKE01', thread: '1' }, { channel: 'C0FAKE01', thread: 1.1 }, null, {}]) assert.equal(O.routeFromTask(bad), null);
});

test('checkJql: control characters dropped, length capped, only credentials refused (e-mail and long numbers are fine)', () => {
  assert.deepEqual(O.checkJql('project = EP\u0000AND status = "In Progress"'), { ok: true, jql: 'project = EP AND status = "In Progress"' });
  assert.deepEqual(O.checkJql(undefined), { ok: true, jql: '' });
  assert.equal(O.checkJql('x'.repeat(2001)).ok, false); assert.equal(O.checkJql('-x').ok, false);
  for (const q of ['reporter = "fake@example.invalid"', 'text ~ "100000000012"', `text ~ "${CARD}"`, 'assignee = currentUser() AND text ~ "token"', 'text ~ "token: 5"'])
    assert.equal(O.checkJql(q).ok, true, q);
  for (const q of [`text ~ "${SLACK}"`, `text ~ "xox${ZW}b-0000000000-FAKEFAKEFAKE"`, 'text ~ "password=fakepass000"', `text ~ "${URI}"`, 'text ~ "AKIA0000000000FAKE00"', 'text ~ "Bearer fakefakefake"', 'text ~ "-----BEGIN PRIVATE KEY----- x -----END PRIVATE KEY-----"'])
    assert.match(O.checkJql(q).error, /credential/, q);
});
