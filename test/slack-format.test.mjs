// Slack thread reply formatting: screen → report text (core/status.js) → mrkdwn blocks (recall/slack-format.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMrkdwn, splitMrkdwn, replyPayload } from '../recall/slack-format.mjs';
await import('../core/status.js');
const S = globalThis.AgentDeskStatus;

const W = 120;
const pad = (s) => s + ' '.repeat(Math.max(0, W - S.displayCols(s)));
const screen = [
  '❯ 정산 README를 요약해줘 그리고 REPORT_START [한 일] REPORT_END 형식으로',
  '',
  '⏺ 요약입니다.',
  '',
  '  REPORT_START',
  '  [한 일] README를 읽고 세 단계를 정리했습니다.',
  '  • 첫 번째 단계는 ' + '가'.repeat(48) + ' 그리고',            // wraps: fills the screen width
  '  이어지는 문장입니다.',
  '  [변경 파일] 없음',
  '  [막힌 점]',
  '  SELECT CODE, CODENAME',
  '    FROM codelist WHERE CODEGROUP = \'A7\';',
  '  • 코드 <step1 MERCHANTNO> 확인이 필요합니다.',
  '  [다음 제안]',
  '  1. 다음에 할 일',
  '  REPORT_END',
  '✻ Cooked for 1m 5s · done 6:22 PM',
  '❯',
];

test('responseTextFromScreen keeps indentation and rejoins a wrapped line', () => {
  const txt = S.responseTextFromScreen(screen.map(pad));
  assert.ok(txt.startsWith('요약입니다.'));
  assert.match(txt, /그리고 이어지는 문장입니다\./);                 // glued back with one space
  assert.match(txt, /\n  FROM codelist/);                           // relative indent kept
  assert.ok(!/^ {2}REPORT_START/m.test(txt));                       // base indent removed
});

test('wrapped join requires the previous line to reach the screen width', () => {
  const txt = S.responseTextFromScreen(['❯ ask something long enough', '⏺ short line', '  next line', '✻ done'].map(pad));
  assert.equal(txt, 'short line\nnext line');
});

test('toMrkdwn: sections, bullets, code, escaping', () => {
  const txt = S.responseTextFromScreen(screen.map(pad));
  const report = txt.slice(txt.indexOf('REPORT_START') + 12, txt.indexOf('REPORT_END')).trim();
  const md = toMrkdwn(report);
  assert.match(md, /\*🛠 한 일\*\nREADME를 읽고/);
  assert.match(md, /\*📄 변경 파일\*\n없음/);
  assert.match(md, /```\nSELECT CODE, CODENAME\n  FROM codelist WHERE CODEGROUP = 'A7';\n```/);
  assert.match(md, /• 코드 &lt;step1 MERCHANTNO&gt; 확인/);
  assert.match(md, /\n1\. 다음에 할 일/);
  assert.ok(!/\n{3}/.test(md));
});

test('toMrkdwn: markdown → slack inline', () => {
  const md = toMrkdwn('# 제목\n- **중요** 항목 [문서](https://x.y/z)\n```sql\nSELECT 1;\n```\n* 둘째');
  assert.equal(md, '*제목*\n• *중요* 항목 <https://x.y/z|문서>\n```\nSELECT 1;\n```\n• 둘째');
});

test('splitMrkdwn keeps fences balanced', () => {
  const text = 'a\n```\n' + Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n') + '\n```\nb';
  const parts = splitMrkdwn(text, 120);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.equal((p.match(/```/g) || []).length % 2, 0, p);
  assert.equal(parts.join('\n').replace(/\n```\n```\n/g, '\n'), text.replace(/\n```\n```\n/g, '\n'));
});

test('replyPayload: report → header + divider + sections; plain text otherwise', () => {
  const p = replyPayload({ title: 'EP-1 요약', session: 'front-desk', report: '[한 일] 했음', text: 'fallback' });
  assert.equal(p.blocks[0].text.text, '✅ *EP-1 요약*  ·  _front-desk_');
  assert.equal(p.blocks[1].type, 'divider');
  assert.equal(p.blocks[2].text.text, '*🛠 한 일*\n했음');
  assert.equal(p.text, '✅ EP-1 요약 · front-desk');
  assert.deepEqual(replyPayload({ text: '▶ 시작' }), { text: '▶ 시작' });
});

test('toMrkdwn: a line starting with a [MASKED…] marker stays a plain line, not a section title', () => {
  assert.equal(toMrkdwn('[MASKED EMAIL] 에게 회신함'), '[MASKED EMAIL] 에게 회신함');
  assert.equal(toMrkdwn('[MASKED] 토큰 교체'), '[MASKED] 토큰 교체');
  assert.equal(toMrkdwn('[한 일] 수정'), '*🛠 한 일*\n수정');
});

test('toMrkdwn: a markdown link whose URL holds a [MASKED…] marker is still a Slack link', () => {
  assert.equal(toMrkdwn('회신: [메일함](https://mail.invalid/?u=[MASKED EMAIL]&x=1)'), '회신: <https://mail.invalid/?u=[MASKED%20EMAIL]&amp;x=1|메일함>');
  assert.equal(toMrkdwn('참고 [docs](https://docs.invalid/a)'), '참고 <https://docs.invalid/a|docs>');
});
