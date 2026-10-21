// Dangerous-command guardrail (PreToolUse): guard/guard.mjs (rule file, log, handler, vm runner), POST /v1/guard on the
// permission socket (perm/server.mjs), guard-hook.sh end to end (bash + curl + openssl) and the settings install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const S2 = await import('../perm/server.mjs');
const { createPermServer, openPermEndpoint, guardHookScript, signBody, GUARD_PATH } = S2;
const S = await import('../perm/settings.mjs');
const GG = await import('../guard/guard.mjs');
const G = globalThis.AgentDeskGuard;

const until = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };
const TOKEN = 'a'.repeat(64);
const tmp = () => mkdtempSync(join(tmpdir(), 'adg-'));   // short: a Unix socket path must stay under ~104 bytes
const pre = (extra = {}) => ({ session_id: 'sess-1', cwd: '/w/app', hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, ...extra });
function post(sock, body, { token = TOKEN, path = GUARD_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, path, method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', ...(token ? { 'X-AD-Perm-Token': token } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, sig: res.headers['x-ad-sig'] }));
    });
    req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
function guardEnv(cfg) {
  const dir = tmp(); const file = join(dir, 'guard.json');
  if (cfg) writeFileSync(file, JSON.stringify(cfg));
  const log = GG.createGuardLog(join(dir, 'guard-log.jsonl'));
  const hits = [], disabled = [];
  const h = GG.createGuardHandler({ file, log, onHit: e => hits.push(e), onRuleDisabled: i => disabled.push(i) });
  return { dir, file, log, h, hits, disabled, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const cfgWith = (mode, extra = []) => ({ mode, rules: [...G.defaultRules(), ...extra], allowRepos: [] });

// ── guard/guard.mjs ──
test('handler: missing guard.json is created 0600 with the default rules in warn mode', () => {
  const e = guardEnv();
  try {
    const c = e.h.config();
    assert.equal(c.mode, 'warn'); assert.equal(c.rules.length, G.defaultRules().length); assert.deepEqual(c.errors, []);
    assert.equal(statSync(e.file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(e.file, 'utf-8')).rules, G.defaultRules());
  } finally { e.done(); }
});

test('handler: warn → ask, block mode → deny for block rules / ask for warn rules, off → {}; no hit → {}; hits are logged', () => {
  const e = guardEnv(cfgWith('warn'));
  try {
    const ask = e.h.handle(pre());
    assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(ask.hookSpecificOutput.permissionDecisionReason, /^\[AgentDesk 가드\] rm -rf .*— 터미널에서 확인하세요$/);
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'npm test' } })), {});
    writeFileSync(e.file, JSON.stringify(cfgWith('block')));
    const deny = e.h.handle(pre());
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /AgentDesk 설정 → 가드레일에서 규칙을 조정할 수 있습니다/);
    assert.equal(e.h.handle(pre({ tool_input: { command: 'sudo ls' } })).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(e.h.handle(pre({ tool_name: 'Write', tool_input: { file_path: '/Users/x/.ssh/authorized_keys', content: 'k' } })).hookSpecificOutput.permissionDecision, 'deny');
    writeFileSync(e.file, JSON.stringify({ ...cfgWith('block'), mode: 'off' }));
    assert.deepEqual(e.h.handle(pre()), {});
    const log = e.log.read();
    assert.deepEqual(log.map(x => [x.rule, x.decision]), [['rm-rf', 'ask'], ['rm-rf', 'deny'], ['sudo', 'ask'], ['secret-path', 'deny']]);
    assert.deepEqual(Object.keys(log[0]).sort(), ['at', 'cwd', 'decision', 'label', 'mode', 'rule', 'session_id', 'severity', 'summary', 'tool']);
    assert.equal(log[0].session_id, 'sess-1');
    assert.equal(e.hits.length, 4);
    assert.equal(statSync(e.log.file).mode & 0o777, 0o600);
  } finally { e.done(); }
});

test('handler: summaries are masked and ≤120 chars; allowRepos skips file paths only; a broken guard.json is reported and never overwritten', () => {
  const e = guardEnv({ ...cfgWith('warn'), allowRepos: ['/w/sandbox'] });
  try {
    e.h.handle(pre({ tool_input: { command: 'mysql -h db -u root --password=hunter2secret ' + 'x'.repeat(300) } }));
    const s = e.log.read().at(-1).summary;
    assert.ok(!s.includes('hunter2secret') && s.length <= 120, s);
    const envW = { tool_name: 'Write', tool_input: { file_path: '/w/sandbox/sub/.env', content: 'x' } };
    assert.deepEqual(e.h.handle(pre({ cwd: '/w/sandbox/sub', ...envW })), {}, 'file rules skipped inside allowRepos');
    assert.equal(e.h.handle(pre({ cwd: '/w/sandbox-other', ...envW })).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(e.h.handle(pre({ cwd: '/w/sandbox/sub' })).hookSpecificOutput.permissionDecision, 'ask', 'Bash is checked inside allowRepos too');
    writeFileSync(e.file, '{ broken');
    const c = e.h.config();
    assert.match(c.fileError, /guard\.json을 읽을 수 없습니다/);
    assert.equal(c.mode, 'warn', 'the last config that loaded is kept');
    assert.deepEqual(c.allowRepos, ['/w/sandbox']);
    assert.equal(e.h.handle(pre()).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(readFileSync(e.file, 'utf-8'), '{ broken');
  } finally { e.done(); }
});

test('handler: a catastrophic user regex is cut off by the vm limit; a block rule asks and is only marked slow, never switched off', () => {
  const evil = { id: 'evil', label: 'evil', pattern: '(a+)+$', tools: ['Bash'], enabled: true, severity: 'block' };
  const slowSeen = [];
  const e = guardEnv(cfgWith('block', [evil]));
  const h = GG.createGuardHandler({ file: e.file, log: e.log, onRuleDisabled: i => e.disabled.push(i), onRuleSlow: i => slowSeen.push(i) });
  try {
    const t0 = Date.now();
    const out = h.handle(pre({ tool_input: { command: 'a'.repeat(40) + '!' } }));
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);   // hang guard only: the vm limit is 20 ms
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', 'a block rule that could not finish → ask');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /차단 규칙의 정규식이 시간 안에 끝나지 않았습니다/);
    h.handle(pre({ tool_input: { command: 'a'.repeat(40) + '!' } }));   // the same input again: still one strike
    assert.deepEqual(slowSeen, []);
    h.handle(pre({ tool_input: { command: 'a'.repeat(41) + '?' } }));   // a second, different input
    const saved = JSON.parse(readFileSync(e.file, 'utf-8')).rules.find(r => r.id === 'evil');
    assert.equal(saved.enabled, true, 'a block rule stays on'); assert.match(saved.slowNote, /느린 정규식.*직접 끄세요/);
    assert.equal(saved.disabledReason, undefined);
    assert.deepEqual(slowSeen, [{ id: 'evil', label: 'evil' }]); assert.deepEqual(e.disabled, []);
    assert.equal(e.log.read().filter(x => x.type === 'rule-slow').length, 1);
    assert.equal(h.handle(pre({ tool_input: { command: 'a'.repeat(42) + '!' } })).hookSpecificOutput.permissionDecision, 'ask', 'still protecting (asks)');
    assert.equal(statSync(e.file).mode & 0o777, 0o600);
  } finally { e.done(); }
});

test('handler: a slow warn-level user rule is disabled after timing out on 2 different inputs', () => {
  const evil = { id: 'evil', label: 'evil', pattern: '(a+)+$', tools: ['Bash'], enabled: true, severity: 'warn' };
  const e = guardEnv(cfgWith('block', [evil]));
  try {
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'a'.repeat(40) + '!' } })), {}, 'warn rule timing out: no question');
    e.h.handle(pre({ tool_input: { command: 'a'.repeat(41) + '?' } }));
    const saved = JSON.parse(readFileSync(e.file, 'utf-8')).rules.find(r => r.id === 'evil');
    assert.equal(saved.enabled, false); assert.match(saved.disabledReason, /자동 비활성화/);
    assert.deepEqual(e.disabled, [{ id: 'evil', label: 'evil', reason: 'slow' }]);
    assert.equal(e.log.read().filter(x => x.type === 'rule-disabled').length, 1);
    const t1 = Date.now(); assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'a'.repeat(40) + '!' } })), {}); assert.ok(Date.now() - t1 < 3000, 'a disabled rule is not evaluated again (hang guard)');
  } finally { e.done(); }
});

test('handler: a user rule that times out once is retried at once; only a second timeout counts (ask / strike)', () => {
  const kube = { id: 'kube', label: 'kube', pattern: 'kubectl\\s+delete', tools: ['Bash'], enabled: true, severity: 'block' };
  const warnRule = { id: 'w', label: 'w', pattern: 'kubectl', tools: ['Bash'], enabled: true, severity: 'warn' };
  const e = guardEnv({ mode: 'block', rules: [kube], allowRepos: [] });
  const cmd = n => pre({ tool_input: { command: `kubectl delete ns x${n}` } });
  try {
    // 1st attempt hits the limit (a stall under load), the retry finishes: the rule decides, nothing is struck
    let calls = 0, mode = 'once';
    const flaky = GG.createGuardHandler({ file: e.file, log: e.log, onRuleSlow: i => e.disabled.push(i),
      runner: (rule, forms) => { calls++; if (mode === 'always' || calls % 2 === 1) throw new Error('Script execution timed out.'); return forms.some(f => rule.re.test(f)); } });
    assert.equal(flaky.handle(cmd(1)).hookSpecificOutput.permissionDecision, 'deny', 'the retry saw the match: block, not ask');
    assert.equal(calls, 2);
    // timing out twice in a row is a real timeout: ask (never allow), and it is struck
    mode = 'always'; calls = 0;
    const out = flaky.handle(cmd(2));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /시간 안에 끝나지 않았습니다/);
    assert.equal(calls, 2, 'one retry, no more');
    assert.deepEqual(e.disabled, [], 'one input is not yet a second strike');
    flaky.handle(cmd(3));
    assert.deepEqual(e.disabled, [{ id: 'kube', label: 'kube' }], 'two different inputs → marked slow');
    // a warn rule that stalled once is not disabled either
    writeFileSync(e.file, JSON.stringify({ mode: 'warn', rules: [warnRule], allowRepos: [] }));
    calls = 0; mode = 'once';
    const w = GG.createGuardHandler({ file: e.file, log: e.log, onRuleDisabled: i => e.disabled.push(i),
      runner: (rule, forms) => { calls++; if (calls % 2 === 1) throw new Error('timed out'); return forms.some(f => rule.re.test(f)); } });
    for (let i = 0; i < 3; i++) assert.equal(w.handle(cmd(10 + i)).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(JSON.parse(readFileSync(e.file, 'utf-8')).rules[0].enabled, true);
  } finally { e.done(); }
});

// reviewer redos.mjs: each catastrophic pattern is interrupted by the vm limit in well under a second
test('vmRunner: catastrophic patterns throw at the limit instead of hanging', () => {
  const run = GG.vmRunner();
  for (const p of ['(a+)+$', '^(a|a)*$', '(\\w+\\s?)*$', '(.*a){12}']) {
    const { rules } = G.compileRules([{ id: 'x', pattern: p, tools: ['Bash'] }]);
    const t0 = Date.now();
    let threw = false; try { run(rules[0], ['a'.repeat(40) + '!']); } catch { threw = true; }
    if (p !== '(.*a){12}') assert.ok(threw, p);   // that one matches 40 a's quickly; it only has to return
    assert.ok(Date.now() - t0 < 3000, `${p}: ${Date.now() - t0} ms`);   // hang guard only
  }
});

// reviewer b6.mjs: ids are stored as compileRules sees them, so disabling finds the rule
test('config: rule ids are normalised like compileRules (trimmed, empty → user-<n>)', () => {
  const e = guardEnv({ mode: 'block', rules: [...G.defaultRules(), { id: '', label: 'noid', pattern: 'zz', tools: ['Bash'] }, { id: ' sp ', label: 'spaced', pattern: 'qq', tools: ['Bash'] }], allowRepos: [] });
  try {
    const c = e.h.config();
    const n = G.defaultRules().length;
    assert.deepEqual(c.rules.slice(n).map(r => r.id), [`user-${n + 1}`, 'sp']);
    assert.deepEqual(c.errors, []);
    GG.writeGuardConfig(e.file, c);
    assert.deepEqual(JSON.parse(readFileSync(e.file, 'utf-8')).rules.slice(n).map(r => r.id), [`user-${n + 1}`, 'sp']);
  } finally { e.done(); }
});

// reviewer b3.mjs / b5.mjs: adversarial padding before a dangerous tail is judged fast and still caught
test('handler: adversarial 8,000-char commands answer in well under the hook limit and still catch the tail', () => {
  const e = guardEnv(cfgWith('block'));
  try {
    for (const [unit, tail, rule] of [['base64 -d"" $(x) ', '; mysql -h rds-prod.db -e "select 1"', 'db-prod'], ['base64 -d"" ', '; mysql -h rds-prod.db -e "select $(true)"', 'db-prod'],
      ['base64 -d ', '; dd if=/dev/zero of=/dev/disk2 "$(true)"', 'disk-destroy'], ['git push ', '; rm -rf ~', 'rm-rf']]) {
      const s = unit.repeat(Math.floor((8000 - tail.length) / unit.length)) + tail;
      const t0 = performance.now();
      const out = e.h.handle(pre({ tool_input: { command: s } }));
      const ms = performance.now() - t0;
      assert.ok(ms < 3000, `${unit}: ${ms.toFixed(0)} ms`);   // hang guard; the absolute limit is in guard.test.mjs (AGENTDESK_PERF=1)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', unit);
      assert.equal(e.log.read().at(-1).rule, rule);
    }
  } finally { e.done(); }
});

test('handler: a timed-out evaluation asks (block / warn) or does nothing (off)', () => {
  const e = guardEnv(cfgWith('block'));
  const slow = GG.createGuardHandler({ file: e.file, log: e.log, deadline: -1 });
  try {
    const out = slow.handle(pre({ tool_input: { command: 'ls' } }));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /평가 시간 초과/);
    assert.equal(e.log.read().at(-1).rule, 'timeout');
    writeFileSync(e.file, JSON.stringify(cfgWith('warn')));
    assert.equal(slow.handle(pre({ tool_input: { command: 'ls' } })).hookSpecificOutput.permissionDecision, 'ask');
    writeFileSync(e.file, JSON.stringify({ ...cfgWith('warn'), mode: 'off' }));
    assert.deepEqual(slow.handle(pre({ tool_input: { command: 'ls' } })), {});
  } finally { e.done(); }
});

// re-review #1: the default (warn) mode must not let a command through because the danger sits in the middle
test('handler: long commands — built-ins see the whole input in every mode; a user rule that saw only part asks (warn too)', () => {
  const pad = 'x'.repeat(4100);
  const mid = `echo ${pad}; rm -rf ~; echo ${pad}`;
  const e = guardEnv(cfgWith('warn'));
  e.h = GG.createGuardHandler({ file: e.file, log: e.log, timeoutMs: 1000 });   // a loaded machine must not make the user rule time out here
  try {
    const w = e.h.handle(pre({ tool_input: { command: mid } }));
    assert.equal(w.hookSpecificOutput.permissionDecision, 'ask'); assert.match(w.hookSpecificOutput.permissionDecisionReason, /rm -rf/);
    writeFileSync(e.file, JSON.stringify(cfgWith('block')));
    assert.equal(e.h.handle(pre({ tool_input: { command: mid } })).hookSpecificOutput.permissionDecision, 'deny');
    // far past 8,000: still the built-in
    assert.equal(e.h.handle(pre({ tool_input: { command: 'echo ' + 'x'.repeat(100000) + '; git push --force origin main; ' + 'y'.repeat(100000) } })).hookSpecificOutput.permissionDecision, 'deny');
    // only built-ins and a harmless long command: nothing (no part went unseen)
    writeFileSync(e.file, JSON.stringify(cfgWith('warn')));
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'echo ' + 'x'.repeat(20000) } })), {});
    // a user rule only sees the first and last 4,000 chars: its middle match → ask, in warn mode as well
    const kube = { id: 'kube', label: 'kubectl 운영', pattern: 'kubectl\\s+delete', tools: ['Bash'], severity: 'block' };
    writeFileSync(e.file, JSON.stringify({ mode: 'warn', rules: [kube], allowRepos: [] }));
    const km = e.h.handle(pre({ tool_input: { command: `echo ${pad}; kubectl delete ns x; echo ${pad}` } }));
    assert.equal(km.hookSpecificOutput.permissionDecision, 'ask'); assert.match(km.hookSpecificOutput.permissionDecisionReason, /명령이 너무 길어/);
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'echo short' } })), {});
    writeFileSync(e.file, JSON.stringify({ mode: 'off', rules: [kube], allowRepos: [] }));
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: `echo ${pad}; kubectl delete ns x; echo ${pad}` } })), {});
    // a 2 MB body cut short (Bash): ask in warn and block
    writeFileSync(e.file, JSON.stringify(cfgWith('warn')));
    assert.match(e.h.handle(pre({ tool_input: { command: 'ls' }, __truncated: true })).hookSpecificOutput.permissionDecisionReason, /명령이 너무 길어/);
  } finally { e.done(); }
});

// re-review #2: a body cut at 2 MB whose path came after the content (no jq) — no path found → ask, not pass
test('handler: a cut body without the target path asks (block and warn); with the path it is judged by the path', () => {
  const e = guardEnv(cfgWith('block'));
  try {
    const contentFirst = '{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"content":"' + 'A'.repeat(2 * 1024 * 1024) + '","file_path":"/Users/x/.ssh/authorized_keys"}}';
    const part = S2.guardFieldsFromPartial(contentFirst.slice(0, 2 * 1024 * 1024)); part.__truncated = true;
    assert.equal(part.tool_input.file_path, undefined);
    const o = e.h.handle(part);
    assert.equal(o.hookSpecificOutput.permissionDecision, 'ask'); assert.match(o.hookSpecificOutput.permissionDecisionReason, /대상 경로를 확인하지 못했습니다/);
    const nameLast = S2.guardFieldsFromPartial(('{"tool_input":{"content":"' + 'A'.repeat(2 * 1024 * 1024)).slice(0, 2 * 1024 * 1024)); nameLast.__truncated = true;
    assert.equal(e.h.handle(nameLast).hookSpecificOutput.permissionDecision, 'ask', 'tool name not found either');
    // reviewer r2: tool_name after the content (lost in the cut) but file_path found → judged as a file tool
    const lost = S2.guardFieldsFromPartial(('{"tool_input":{"file_path":"/Users/x/.ssh/a","content":"' + 'A'.repeat(2 * 1024 * 1024) + '"},"tool_name":"Write"}').slice(0, 2 * 1024 * 1024)); lost.__truncated = true;
    assert.equal(lost.tool_name, undefined);
    assert.equal(e.h.handle(lost).hookSpecificOutput.permissionDecision, 'deny');
    // a decoy key inside the content (escaped quotes) is never taken for the real one
    const decoy = S2.guardFieldsFromPartial(('{"tool_name":"Write","tool_input":{"content":"\\"file_path\\":\\"/tmp/ok\\"' + 'A'.repeat(2 * 1024 * 1024) + '","file_path":"/etc/passwd"}}').slice(0, 2 * 1024 * 1024)); decoy.__truncated = true;
    assert.equal(decoy.tool_input.file_path, undefined);
    assert.equal(e.h.handle(decoy).hookSpecificOutput.permissionDecision, 'ask');
    writeFileSync(e.file, JSON.stringify(cfgWith('warn')));
    assert.equal(e.h.handle(part).hookSpecificOutput.permissionDecision, 'ask');
    const pathFirst = S2.guardFieldsFromPartial(('{"tool_name":"Write","tool_input":{"file_path":"/w/app/a.txt","content":"' + 'A'.repeat(2 * 1024 * 1024)).slice(0, 2 * 1024 * 1024)); pathFirst.__truncated = true;
    assert.deepEqual(e.h.handle(pathFirst), {}, 'path found and harmless');
    writeFileSync(e.file, JSON.stringify({ ...cfgWith('warn'), mode: 'off' }));
    assert.deepEqual(e.h.handle(part), {});
  } finally { e.done(); }
});

test('handler: with meta.settle the hit is logged when the answer was delivered — late-pass when the hook had gone; errors ask in block mode', () => {
  const e = guardEnv(cfgWith('block'));
  try {
    let settle = null;
    const out = e.h.handle(pre(), { settle: fn => { settle = fn; } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(e.log.read().length, 0, 'not logged before delivery is known');
    settle(false);
    const last = e.log.read().at(-1);
    assert.deepEqual([last.decision, last.rule], ['late-pass', 'rm-rf']);
    assert.equal(e.hits.at(-1).decision, 'late-pass');
    e.h.handle(pre(), { settle: fn => fn(true) });
    assert.equal(e.log.read().at(-1).decision, 'deny');
    e.h.handle(pre());
    assert.equal(e.log.read().at(-1).decision, 'deny', 'no settle → logged at once');
    // a body that makes judging throw
    const evil = { get tool_name() { throw new Error('boom'); } };
    assert.equal(e.h.handle(evil).hookSpecificOutput.permissionDecision, 'ask');
    writeFileSync(e.file, JSON.stringify(cfgWith('warn')));
    assert.deepEqual(e.h.handle(evil), {});
  } finally { e.done(); }
});

test('server /v1/guard: an answer the hook received is logged as its decision; a hook that hung up first → late-pass', async () => {
  const dir = tmp(); const sock = join(dir, 's.sock');
  const e = guardEnv(cfgWith('block'));
  let delay = 0, started = 0;
  const srv = createPermServer({ token: TOKEN, onGuard: async (b, m) => { started++; if (delay) await new Promise(r => setTimeout(r, delay)); return e.h.handle(b, m); } });
  await srv.listen(sock);
  try {
    await post(sock, pre());
    await until(() => e.log.read().length === 1);
    assert.equal(e.log.read().at(-1).decision, 'deny');
    delay = 1000; started = 0;
    await new Promise(resolve => {
      const req = request({ socketPath: sock, path: GUARD_PATH, method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', 'X-AD-Perm-Token': TOKEN } });
      req.on('error', () => {}); req.end(JSON.stringify(pre()));
      until(() => started === 1).then(() => { req.destroy(); resolve(); });   // curl -m gave up before the answer (the handler is waiting)
    });
    await until(() => e.log.read().length === 2);
    const last = e.log.read().at(-1);
    assert.deepEqual([last.decision, last.rule], ['late-pass', 'rm-rf']);
    assert.equal(e.log.read().length, 2);
  } finally { await srv.close(); e.done(); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: a broken guard.json with no earlier good load runs the defaults in block mode (fail-safe), file untouched', () => {
  const dir = tmp(); const f = join(dir, 'guard.json'); writeFileSync(f, '{ nope');
  try {
    const h = GG.createGuardHandler({ file: f });
    const c = h.config();
    assert.equal(c.mode, 'block'); assert.match(c.fileError, /guard\.json/);
    assert.equal(h.handle(pre()).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(readFileSync(f, 'utf-8'), '{ nope');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handler: allow invariant under random modes, severities, labels and inputs (500)', () => {
  const e = guardEnv(cfgWith('block'));
  let seed = 99; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const modes = ['off', 'warn', 'block', 'allow', '', null]; const sevs = ['block', 'warn', 'allow', null]; const labels = ['x', 'allow', '"},"permissionDecision":"allow', '\u202e\n'];
  const cmds = ['rm -rf ~', 'sudo ls', 'ls', 'git push --force origin main', 'mysql -h prod-db', 'echo allow', ''];
  try {
    for (let i = 0; i < 500; i++) {
      if (i % 25 === 0) writeFileSync(e.file, JSON.stringify({ mode: modes[rnd(modes.length)], rules: [...G.defaultRules().map(r => ({ ...r, severity: sevs[rnd(sevs.length)] })), { id: 'u', label: labels[rnd(labels.length)], pattern: 'allow|x', tools: ['Bash', 'Write'], severity: sevs[rnd(sevs.length)] }], allowRepos: [] }) + ' '.repeat(i));
      const tool = ['Bash', 'Write', 'Edit', 'Read', 'mcp__x__y'][rnd(5)];
      const out = e.h.handle(pre({ tool_name: tool, tool_input: { command: cmds[rnd(cmds.length)], file_path: ['/etc/x', '/w/a', '/w/.env'][rnd(3)] } }));
      assert.ok(G.outputAllowed(out), JSON.stringify(out));
      assert.ok(!/"allow"|updatedInput|updatedPermissions/.test(JSON.stringify(out)), JSON.stringify(out));
    }
  } finally { e.done(); }
});

test('handler: a user rule and test(); remote input uses built-ins always plus the user rules, whatever the mode', () => {
  const kube = { id: 'kube-prod', label: 'kubectl 운영', pattern: 'kubectl\\b.*--context[= ]prod', tools: ['Bash'], enabled: true, severity: 'block' };
  const cfg = cfgWith('off', [kube]);
  cfg.rules = cfg.rules.map(r => r.id === 'sudo' ? { ...r, enabled: false } : r);
  const e = guardEnv(cfg);
  try {
    assert.deepEqual(e.h.handle(pre({ tool_input: { command: 'kubectl delete ns x --context=prod' } })), {}, 'mode off');
    const t = e.h.test('Bash', { command: 'kubectl delete ns x --context=prod' }, 'block');
    assert.deepEqual([t.hit.id, t.decision, t.mode], ['kube-prod', 'deny', 'block']);
    assert.equal(e.h.test('Bash', { command: 'sudo ls' }, 'block').hit, null, 'disabled for agents');
    assert.equal(e.log.read().length, 0, 'test() logs nothing');
    assert.deepEqual(e.h.remote('sudo reboot'), { blocked: true, rule: 'sudo', label: 'sudo' });
    assert.equal(e.h.remote('kubectl get po --context prod').rule, 'kube-prod');
    assert.deepEqual(e.h.remote('git status 보여줘'), { blocked: false });
    assert.equal(e.h.remote('git push ' + 'x '.repeat(4000)).blocked, false, 'long remote input is judged quickly');
    assert.equal(e.h.remote('git push --force origin main').rule, 'git-push-force', 'first hit in table order, as before');
  } finally { e.done(); }
});

test('guard log: rotates to the last 2,000 lines once past 2,400, stays 0600', () => {
  const dir = tmp(); const f = join(dir, 'g.jsonl');
  try {
    const log = GG.createGuardLog(f);
    for (let i = 0; i < 2401; i++) log.append({ i });
    const lines = readFileSync(f, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2000); assert.equal(JSON.parse(lines[0]).i, 401); assert.equal(JSON.parse(lines.at(-1)).i, 2400);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(log.read(10).length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── POST /v1/guard on the permission socket ──
test('server /v1/guard: answers at once, signed; 401 without the token; {} without a handler or when it throws; 400 other events', async () => {
  const dir = tmp(); const sock = join(dir, 's.sock');
  const e = guardEnv(cfgWith('block'));
  let throwNext = false;
  const srv = createPermServer({ token: TOKEN, isKnownSession: () => false, onGuard: b => { if (throwNext) throw new Error('x'); return e.h.handle(b); } });
  await srv.listen(sock);
  try {
    const r = await post(sock, pre({ session_id: 'never-seen' }));
    assert.equal(r.status, 200); assert.equal(r.sig, signBody(TOKEN, r.body));
    assert.equal(JSON.parse(r.body).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await post(sock, pre(), { token: 'b'.repeat(64) })).status, 401);
    assert.equal((await post(sock, pre({ hook_event_name: 'PermissionRequest' }))).status, 400);
    throwNext = true;
    assert.deepEqual(JSON.parse((await post(sock, pre())).body), {});
    assert.equal(srv.list().length, 0, 'nothing queued');
  } finally { await srv.close(); e.done(); rmSync(dir, { recursive: true, force: true }); }
  const dir2 = tmp(); const sock2 = join(dir2, 's.sock');
  const bare = createPermServer({ token: TOKEN });
  await bare.listen(sock2);
  try { assert.deepEqual(JSON.parse((await post(sock2, pre())).body), {}); } finally { await bare.close(); rmSync(dir2, { recursive: true, force: true }); }
});

test('server /v1/guard: only {} or a PreToolUse ask / deny leaves the server; onGuardFail answers a thrown handler', async () => {
  const dir = tmp(); const sock = join(dir, 's.sock');
  const answers = [
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'x' } },
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'x', updatedInput: { command: 'rm -rf /' } } },
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' }, continue: false },
    { decision: 'approve' }, 'allow', null,
  ];
  let i = 0, fail = false;
  const srv = createPermServer({ token: TOKEN, onGuard: () => { if (fail) throw new Error('x'); return answers[i++]; }, onGuardFail: () => G.askOutput('오류') });
  await srv.listen(sock);
  try {
    assert.equal(srv.server.maxConnections, 80);
    for (const a of answers) assert.deepEqual(JSON.parse((await post(sock, pre())).body), {}, JSON.stringify(a));
    fail = true;
    assert.equal(JSON.parse((await post(sock, pre())).body).hookSpecificOutput.permissionDecision, 'ask');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('server /v1/guard: a body over 2 MB is cut, not refused (413 would let it through): the target path and command are still judged', async () => {
  const dir = tmp(); const sock = join(dir, 's.sock');
  const e = guardEnv(cfgWith('block'));
  const seen = [];
  const srv = createPermServer({ token: TOKEN, onGuard: b => { seen.push(b); return e.h.handle(b); } });
  await srv.listen(sock);
  try {
    const big = pre({ tool_name: 'Write', tool_input: { file_path: '/Users/x/.ssh/authorized_keys', content: 'k'.repeat(3 * 1024 * 1024) } });
    const r = await post(sock, big);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(seen.at(-1).__truncated, true); assert.equal(seen.at(-1).tool_input.file_path, '/Users/x/.ssh/authorized_keys');
    const bash = pre({ tool_input: { command: 'echo "quote \\" ok" && ' + 'y'.repeat(3 * 1024 * 1024) } });
    const r2 = JSON.parse((await post(sock, bash)).body);
    assert.match(r2.hookSpecificOutput.permissionDecisionReason, /명령이 너무 길어/, 'block mode: a command cut short asks');
    assert.ok(seen.at(-1).tool_input.command.startsWith('echo "quote \\" ok" && yyy'));
    // the approval endpoint keeps refusing big bodies
    assert.deepEqual(S2.guardFieldsFromPartial('{"session_id":"s","tool_name":"Bash","tool_input":{"command":"rm -rf ~ \\u00'), { tool_input: { command: 'rm -rf ~ ' }, session_id: 's', tool_name: 'Bash' });
  } finally { await srv.close(); e.done(); rmSync(dir, { recursive: true, force: true }); }
});

// ── guard-hook.sh end to end ──
function hookHome() {
  const home = tmp(); const d = join(home, '.roca'); mkdirSync(join(d, 'perm'), { recursive: true, mode: 0o700 });
  const script = join(d, 'guard-hook.sh'); writeFileSync(script, guardHookScript(), { mode: 0o700 });
  const run = (input = pre(), extraEnv = {}) => new Promise(resolve => {
    const c = spawn('/bin/bash', [script], { env: { PATH: process.env.PATH, HOME: home, ...extraEnv } }); let out = '';
    c.stdout.on('data', x => { out += x; }); c.on('close', code => resolve({ code, out }));
    c.stdin.on('error', () => {});   // the script may exit without reading stdin (EPIPE)
    c.stdin.end(JSON.stringify(input));
  });
  return { home, dir: join(d, 'perm'), run };
}

test('guard-hook.sh: prints the signed ask / deny; nothing without the socket, with a wrong token, for no hit, or when the widget is down', async () => {
  const h = hookHome(); const e = guardEnv(cfgWith('block'));
  try {
    assert.deepEqual(await h.run(), { code: 0, out: '' }, 'no socket / token → silent');
    const srv = await openPermEndpoint({ dir: h.dir, isKnownSession: () => false, onGuard: b => e.h.handle(b) });
    try {
      const t0 = Date.now();
      const deny = await h.run();
      const ms = Date.now() - t0;
      assert.equal(deny.code, 0);
      assert.equal(JSON.parse(deny.out).hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(ms < 5000, `round trip ${ms} ms`);   // hang guard (the hook's curl gives up after 2 s)
      const ask = await h.run(pre({ tool_input: { command: 'sudo ls' } }));
      assert.equal(JSON.parse(ask.out).hookSpecificOutput.permissionDecision, 'ask');
      assert.deepEqual(await h.run(pre({ tool_input: { command: 'ls -la' } })), { code: 0, out: '{}\n' }, '{} = no effect');
      const tok = readFileSync(join(h.dir, 'perm-token'), 'utf-8');
      writeFileSync(join(h.dir, 'perm-token'), 'b'.repeat(64));
      assert.deepEqual(await h.run(), { code: 0, out: '' }, 'wrong token → 401 → silent');
      writeFileSync(join(h.dir, 'perm-token'), tok);
      // reviewer srv.mjs: proxy variables must not divert the socket request
      const prox = await h.run(pre(), { http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'socks5://127.0.0.1:9', all_proxy: 'socks5://127.0.0.1:9' });
      assert.equal(JSON.parse(prox.out).hookSpecificOutput.permissionDecision, 'deny', 'with proxy variables set');
    } finally { await srv.close(); }
    const t1 = Date.now();
    assert.deepEqual(await h.run(), { code: 0, out: '' }, 'widget down → silent (fail-open)');
    assert.ok(Date.now() - t1 < 5000, 'widget down → fails open without hanging');
  } finally { e.done(); rmSync(h.home, { recursive: true, force: true }); }
});

test('guard-hook.sh: an impostor on the socket path cannot answer (unsigned / wrongly signed allow → nothing)', async () => {
  const h = hookHome();
  writeFileSync(join(h.dir, 'perm-token'), 'c'.repeat(64), { mode: 0o600 });
  const FORGED = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  try {
    for (const sig of [null, 'f'.repeat(64), signBody('d'.repeat(64), FORGED)]) {
      const imp = createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, sig ? { 'X-AD-Sig': sig } : {}); r.end(FORGED); }); });
      const sock = join(h.dir, 'perm.sock'); rmSync(sock, { force: true });
      await new Promise(res => imp.listen(sock, res));
      try { assert.deepEqual(await h.run(), { code: 0, out: '' }, `sig=${sig}`); } finally { await new Promise(res => imp.close(res)); }
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── settings.json install ──
test('settings: the guard hook goes on PreToolUse with the matcher; perm hook, logging hook and Orca hooks are kept', () => {
  const home = tmp(); const file = join(home, 'settings.json'); const backups = join(home, 'bk');
  const orca = { matcher: '*', hooks: [{ type: 'command', command: '/Applications/Orca.app/hook orca-agent-status' }] };
  const logging = { hooks: [{ type: 'command', command: '/h/.roca/hook.sh', timeout: 5, async: true }] };
  const perm = { hooks: [{ type: 'command', command: '/h/.roca/perm-hook.sh', timeout: 100 }] };
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [orca, logging], PermissionRequest: [logging, perm], Stop: [logging] } }), { mode: 0o644 });
  try {
    S.installGuardHookAt({ settingsFile: file, command: '/h/.roca/guard-hook.sh', backupDir: backups });
    S.installGuardHookAt({ settingsFile: file, command: '/h/.roca/guard-hook.sh', backupDir: backups });   // replaces, not duplicates
    let s = JSON.parse(readFileSync(file, 'utf-8'));
    assert.deepEqual(s.hooks.PreToolUse, [orca, logging, { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: '/h/.roca/guard-hook.sh', timeout: 3 }] }]);
    assert.deepEqual(s.hooks.PermissionRequest, [logging, perm]);
    assert.equal(S.guardHookPresent(file), true); assert.equal(S.permHookPresent(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    S.uninstallPermHookAt({ settingsFile: file });
    assert.equal(S.guardHookPresent(file), true, 'turning approval off keeps the guard');
    S.uninstallGuardHookAt({ settingsFile: file });
    s = JSON.parse(readFileSync(file, 'utf-8'));
    assert.deepEqual(s.hooks, { PreToolUse: [orca, logging], PermissionRequest: [logging], Stop: [logging] });
    assert.equal(S.guardHookPresent(file), false);
    writeFileSync(file, '{ "hooks": [ ,, }');
    assert.throws(() => S.installGuardHookAt({ settingsFile: file, command: '/h/.roca/guard-hook.sh' }), /settings\.json을 읽을 수 없습니다/);
    assert.equal(readFileSync(file, 'utf-8'), '{ "hooks": [ ,, }');
    assert.ok(existsSync(backups));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('guard-hook.sh: with jq only the needed fields are sent (a 3 MB Write is judged by its path, not refused)', async () => {
  const h = hookHome(); const e = guardEnv(cfgWith('block'));
  const seen = [];
  try {
    const srv = await openPermEndpoint({ dir: h.dir, onGuard: b => { seen.push(b); return e.h.handle(b); } });
    try {
      const r = await h.run(pre({ tool_name: 'Write', tool_input: { file_path: '/Users/x/.ssh/authorized_keys', content: 'k'.repeat(3 * 1024 * 1024) } }));
      assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
      const hasJq = spawnSync('/bin/bash', ['-c', 'command -v jq']).status === 0;
      if (hasJq) assert.deepEqual(Object.keys(seen.at(-1).tool_input).sort(), ['command', 'file_path', 'notebook_path'], 'content not sent');
      else assert.equal(seen.at(-1).__truncated, true);
    } finally { await srv.close(); }
  } finally { e.done(); rmSync(h.home, { recursive: true, force: true }); }
});
