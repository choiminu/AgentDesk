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
    ['ping neo@eximbay.com', 'neo@eximbay.com'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_'], ['token=supersecret1', 'supersecret1'],
  ];
  for (const [input, leak] of cases) assert.ok(!mask(input).includes(leak), `${input} → ${mask(input)}`);
  // ordinary text stays readable
  for (const ok of ['EP-1234 결제 재시도', 'v0.2.0-internal.3', 'port 7331', '010-1234-5678', 'commit 8330cfb', 'took 1234567 ms']) assert.equal(mask(ok), ok);
});

test('mask stays fast on adversarial input (every repetition is bounded)', () => {
  for (const input of ['a.'.repeat(50000), 'a@'.repeat(50000), 'x@a.'.repeat(25000), 'a-'.repeat(50000), '1 '.repeat(50000), 'Bearer '.repeat(14000), 'mysql://'.repeat(12000), 'password='.repeat(11000), '-----BEGIN PRIVATE KEY-----'.repeat(3500)]) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); mask(input); best = Math.min(best, performance.now() - t0); }
    assert.ok(best < 50, `${input.slice(0, 12)}… took ${best.toFixed(1)} ms`);
  }
  // still masks what it should near the limits
  assert.equal(mask('a'.repeat(64) + '@example.com'), '[MASKED EMAIL]');
  assert.equal(mask('-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(3300) + '\n-----END RSA PRIVATE KEY-----'), '[MASKED PRIVATE KEY]');
});

test('sanitizeSessions cuts long fields before masking', async () => {
  const { sanitizeSessions } = await import('../team/peer.mjs');
  const t0 = performance.now();
  const [o] = sanitizeSessions([{ id: 'a', name: 'a.'.repeat(50000), now: 'x@a.'.repeat(25000), files: ['a.'.repeat(50000)], report: { text: 'a@'.repeat(50000), at: 1 } }]);
  assert.ok(performance.now() - t0 < 100);
  assert.equal(o.name.length, 120); assert.ok(o.now.length <= 200); assert.ok(o.report.text.length <= 200);
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
  assert.match(main, /scannedPids\.has\(pid\)/, 'kill-process only for PIDs the port scan listed');
});
