// Slack front desk thread context: parent + replies → markdown for the agent (recall/slack-thread.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchThread, formatThread, clipThread } from '../recall/slack-thread.mjs';
// a made-up bot token for the masking checks, put together at run time so secret scanners do not take it for a real one
const FAKE_BOT_TOKEN = ['xox' + 'b', '0000000000-0000000000-FAKEFAKEFAKEFAKE'].join('-');

const msgs = [
  { user: 'U1', ts: '1700000000.000100', text: 'Login page returns 500 since this morning' },
  { user: 'U2', ts: '1700000060.000200', text: 'Happens only on the staging server', files: [{ name: 'trace.log' }] },
  { user: 'UBOT', ts: '1700000070.000300', text: '📥 received' },
  { user: 'U3', ts: '1700000120.000400', text: '<@UBOT> please look into this' },
];

test('formatThread: parent first, replies after, bot posts dropped, caller marked, files listed', () => {
  const s = formatThread(msgs, { botUserId: 'UBOT', mentionTs: '1700000120.000400' });
  const parts = s.split('\n\n');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^### 본문 · <@U1> · /);
  assert.match(parts[0], /Login page returns 500/);
  assert.match(parts[1], /^### 댓글 · <@U2>/);
  assert.match(parts[1], /\[첨부: trace\.log\]/);
  assert.match(parts[2], /← 봇 호출/);
  assert.doesNotMatch(s, /received/);
});

test('formatThread: names shown when known, empty input gives empty text', () => {
  assert.match(formatThread([msgs[0]], { names: { U1: 'Alex' } }), /Alex \(<@U1>\)/);
  assert.equal(formatThread([]), '');
  assert.equal(formatThread(null), '');
});

test('formatThread: secrets in the thread are masked', () => {
  const s = formatThread([{ user: 'U1', ts: '1', text: 'token ' + FAKE_BOT_TOKEN + '' }]);
  assert.ok(!s.includes(FAKE_BOT_TOKEN), 'the token is masked');
});

test('clipThread: keeps the start and the end within the limit', () => {
  const s = 'A'.repeat(500) + 'B'.repeat(500);
  const c = clipThread(s, 300);
  assert.ok(c.length <= 300 + 40);
  assert.ok(c.startsWith('AAA'));
  assert.ok(c.endsWith('BBB'));
  assert.match(c, /생략/);
  assert.equal(clipThread('short', 300), 'short');
});

test('fetchThread: pages through replies and reports a missing scope', async () => {
  let calls = 0;
  const web = { conversations: { replies: async ({ cursor }) => { calls++; return cursor ? { messages: [msgs[1]] } : { messages: [msgs[0]], response_metadata: { next_cursor: 'n1' } }; } } };
  const r = await fetchThread(web, 'C1', '1700000000.000100');
  assert.equal(calls, 2);
  assert.equal(r.messages.length, 2);
  const denied = { conversations: { replies: async () => { const e = new Error('An API error occurred: missing_scope'); e.data = { error: 'missing_scope', needed: 'channels:history' }; throw e; } } };
  assert.deepEqual(await fetchThread(denied, 'C1', '1'), { error: 'missing_scope', needed: 'channels:history' });
  const deniedNoHint = { conversations: { replies: async () => { const e = new Error('x'); e.data = { error: 'missing_scope' }; throw e; } } };
  assert.equal((await fetchThread(deniedNoHint, 'G1', '1')).needed, 'groups:history');
});

test('answerPayload: Markdown headings and bullets become Slack mrkdwn, masked, fallback text set', async () => {
  const { answerPayload } = await import('../recall/slack-format.mjs');
  const p = answerPayload('## Sessions\n- `api` is running\n- token ' + FAKE_BOT_TOKEN + '', 'Who is on it');
  const body = p.blocks.map(b => b.text.text).join('\n');
  assert.doesNotMatch(body, /^##/m);
  assert.match(body, /^\*Sessions\*$/m);
  assert.match(body, /^• `api` is running$/m);
  assert.doesNotMatch(body, /FAKEFAKEFAKEFAKE/);
  assert.equal(p.text, 'Who is on it');
  assert.equal(p.unfurl_links, false);
});

test('noEmoji: nothing pictographic reaches Slack; indentation, times and a:b:c stay', async () => {
  const { noEmoji, replyPayload } = await import('../recall/slack-format.mjs');
  assert.equal(noEmoji('▶ 세션이 이어서 작업합니다.'), '세션이 이어서 작업합니다.');
  assert.equal(noEmoji('⚠️ 전달 실패'), '전달 실패');
  assert.equal(noEmoji(':white_check_mark: 완료 👍 good x👍y'), '완료 good xy');
  assert.equal(noEmoji('```\n  rm -rf ./x\n```'), '```\n  rm -rf ./x\n```');
  assert.equal(noEmoji('12:30:45 a:b:c std::vector'), '12:30:45 a:b:c std::vector');
  assert.doesNotMatch(JSON.stringify(replyPayload({ title: '✅ 끝', session: 's', report: '[한 일] 🛠 고침 ✅' })), /\p{Extended_Pictographic}/u);
});
