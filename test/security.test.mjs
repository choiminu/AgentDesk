// Renderer / app hardening: HTML escaping, the widget's CSP, shared secret masking, the sandbox-ready preload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkWidgetCsp, inlineScripts } from '../scripts/csp-hash.mjs';
await import('../core/mask.js');
const { mask } = globalThis.AgentDeskMask;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'widget.html'), 'utf-8');
const script = inlineScripts(html)[0];

// the widget's esc() as shipped (pulled out of the inline script)
const escSrc = script.match(/const ESC_MAP = [^\n]*\nfunction esc\(s\) \{[^\n]*\}/);
const esc = new Function(`${escSrc[0]}; return esc;`)();

test('esc escapes & < > " \' so it is safe in text and in quoted attributes', () => {
  assert.equal(esc(`<img src=x onerror="a('1')">&`), '&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt;&amp;');
  assert.equal(esc('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(esc("x' autofocus onfocus='y"), 'x&#39; autofocus onfocus=&#39;y');
  assert.equal(esc(''), ''); assert.equal(esc(null), ''); assert.equal(esc(undefined), ''); assert.equal(esc(42), '42');
  assert.equal(esc(0), '0', 'a zero port / failure count is shown, not blank');
  assert.equal(esc('한글 · ok'), '한글 · ok');
});

test('widget.html: CSP without unsafe-inline scripts, hash matches the one inline script, no inline handlers', () => {
  const r = checkWidgetCsp(join(root, 'widget.html'));
  assert.equal(r.inline, 1);
  assert.ok(r.ok, `CSP hash stale (have ${r.have}, want ${r.want}) — run: node scripts/csp-hash.mjs --write`);
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const dirs = Object.fromEntries(meta.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(!dirs['script-src'].includes("'unsafe-inline'") && !dirs['script-src'].includes("'unsafe-eval'"));
  assert.deepEqual(dirs['object-src'], ["'none'"]); assert.deepEqual(dirs['base-uri'], ["'none'"]);
  assert.ok(dirs['img-src'].includes('https:'), 'Jira avatars still load');
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
  assert.equal((html.match(/\son[a-z]+\s*=\s*["'`$]/g) || []).length, 0, 'no inline event handler attributes');
});

test('teammate card: status / ctx / subagents never reach markup unchecked', () => {
  const card = script.slice(script.indexOf('function teamPeerCard('), script.indexOf('function peerBoardHtml('));
  assert.ok(!card.includes('${s.status}') && !card.includes('${s.ctxPct}') && !card.includes('${s.subagents}'));
  assert.ok(card.includes("PEER_STATUSES.includes(s.status)"));
});

test('mask: tokens, keys, connection URIs, card / account numbers and e-mail addresses', () => {
  const cases = [
    ['Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['xoxb-123456789012-abcdefghijkl', 'xoxb-'], ['xapp-1-A0123456789-abcdef', 'xapp-'],
    ['key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['mysql://app:pw@db.internal:3306/pay', 'db.internal'], ['postgres://u@10.0.0.9/x', '10.0.0.9'], ['mongodb+srv://c.mongodb.net/db', 'mongodb.net'],
    ['card 4111111111111111', '4111111111111111'], ['card 4111-1111-1111-1111', '4111-1111'], ['acct 110 123 456 789', '456 789'],
    ['ping ops@example.invalid', 'ops@example.invalid'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_'], ['token=supersecret1', 'supersecret1'],
  ];
  for (const [input, leak] of cases) assert.ok(!mask(input).includes(leak), `${input} → ${mask(input)}`);
  // ordinary text stays readable
  for (const ok of ['EP-1234 결제 재시도', 'v0.2.0-internal.3', 'port 7331', '010-1234-5678', 'commit 8330cfb', 'took 1234567 ms']) assert.equal(mask(ok), ok);
});

// timing: the default run only checks linear growth (2x the input → under 5x the time; linear = 2x, quadratic = 4x is
// too close to tell apart, so 4x the input → under 10x); absolute limits run with AGENTDESK_PERF=1
const bestMs = (k, fn) => { let best = Infinity; for (let i = 0; i < k; i++) { const t0 = performance.now(); fn(); best = Math.min(best, performance.now() - t0); } return best; };
// samples both sizes in rounds until 4x the input takes under 10x the time (a stall on a loaded machine only costs
// another round); a really quadratic function never gets there, and one still over 16x (quadratic) after 3 rounds
// fails right away instead of using every round
const linear = (small, large, floor = 2, rounds = 20) => {
  let t1 = Infinity, t4 = Infinity;
  for (let i = 0; i < rounds; i++) { t1 = Math.min(t1, bestMs(1, small)); t4 = Math.min(t4, bestMs(1, large)); if (t4 <= 10 * Math.max(t1, floor)) break; if (i >= 2 && t4 > 16 * Math.max(t1, floor)) break; }
  return { ok: t4 <= 10 * Math.max(t1, floor), t1, t4 };
};
const ADVERSARIAL_MASK = [['a.', 50000], ['a@', 50000], ['x@a.', 25000], ['a-', 50000], ['1 ', 50000], ['Bearer ', 14000], ['mysql://', 12000], ['password=', 11000], ['-----BEGIN PRIVATE KEY-----', 3500]];
test('mask stays linear on adversarial input (every repetition is bounded)', () => {
  for (const [u, n] of ADVERSARIAL_MASK) {
    const r = linear(() => mask(u.repeat(n / 4)), () => mask(u.repeat(n)));
    assert.ok(r.ok, `${u}… ${r.t1.toFixed(1)} ms → ${r.t4.toFixed(1)} ms for 4x the input`);
  }
  // still masks what it should near the limits
  assert.equal(mask('a'.repeat(64) + '@example.com'), '[MASKED EMAIL]');
  assert.equal(mask('-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(3300) + '\n-----END RSA PRIVATE KEY-----'), '[MASKED PRIVATE KEY]');
});
test('mask stays fast on adversarial input (under 50 ms, AGENTDESK_PERF=1)', { skip: !process.env.AGENTDESK_PERF }, () => {
  for (const [u, n] of ADVERSARIAL_MASK) { const best = bestMs(3, () => mask(u.repeat(n))); assert.ok(best < 50, `${u}… took ${best.toFixed(1)} ms`); }
});

test('sanitizeSessions cuts long fields before masking', async () => {
  const { sanitizeSessions } = await import('../team/peer.mjs');
  const sess = n => [{ id: 'a', name: 'a.'.repeat(n), now: 'x@a.'.repeat(n / 2), files: ['a.'.repeat(n)], report: { text: 'a@'.repeat(n), at: 1 } }];
  sanitizeSessions(sess(1000));   // warm up
  // the fields are cut before masking, so 4x the raw input costs about the same as 1x (not 4x or more)
  const r = linear(() => sanitizeSessions(sess(12500)), () => sanitizeSessions(sess(50000)));
  assert.ok(r.ok, `${r.t1.toFixed(1)} ms → ${r.t4.toFixed(1)} ms`);
  const [o] = sanitizeSessions(sess(50000));
  assert.equal(o.name.length, 120); assert.ok(o.now.length <= 200); assert.ok(o.report.text.length <= 200);
});
test('sanitizeSessions on 100 KB fields takes under 100 ms (AGENTDESK_PERF=1)', { skip: !process.env.AGENTDESK_PERF }, async () => {
  const { sanitizeSessions } = await import('../team/peer.mjs');
  const t0 = performance.now();
  sanitizeSessions([{ id: 'a', name: 'a.'.repeat(50000), now: 'x@a.'.repeat(25000), files: ['a.'.repeat(50000)], report: { text: 'a@'.repeat(50000), at: 1 } }]);
  assert.ok(performance.now() - t0 < 100);
});

test('recall/lib.mjs uses the shared mask rules', () => {
  const src = readFileSync(join(root, 'recall', 'lib.mjs'), 'utf-8');
  assert.match(src, /import "\.\.\/core\/mask\.js"/);
  assert.match(src, /export const mask = s => globalThis\.AgentDeskMask\.mask\(String\(s \?\? ""\)\.slice\(0, 65536\)\)/);
});

test('preload only needs what a sandboxed preload gets', () => {
  const src = readFileSync(join(root, 'preload.cjs'), 'utf-8');
  assert.deepEqual([...src.matchAll(/require\(([^)]+)\)/g)].map(m => m[1]), ['"electron"']);
  const main = readFileSync(join(root, 'main.mjs'), 'utf-8');
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /on\("will-navigate", \(e\) => e\.preventDefault\(\)\)/);
  assert.doesNotMatch(main, /process\.kill\(/, 'no IPC to signal arbitrary PIDs');
  assert.doesNotMatch(src, /killProcess|scanPorts|clipboardRead|kill-process|clipboard-read/, 'no IPC to signal arbitrary PIDs or read the clipboard');
  assert.doesNotMatch(main, /clipboard\.readText/, 'the page cannot read the clipboard (clipboard history was removed)');
});
