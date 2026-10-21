// Widget permission approval: core/perm.js (summaries, hook output), perm/server.mjs (Unix socket, auth, signed
// answers, long-poll, queue), perm-hook.sh (end to end through bash + curl + openssl) and perm/settings.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
await import('../core/mask.js');
await import('../core/perm.js');
const P = globalThis.AgentDeskPerm;
const { createPermServer, openPermEndpoint, permHookScript, signBody, PERM_PATH, PERM_MAX_BODY } = await import('../perm/server.mjs');
const S = await import('../perm/settings.mjs');

const TOKEN = 'a'.repeat(64);
const hookInput = (extra = {}) => ({
  session_id: 'sess-1', cwd: '/w/app', hook_event_name: 'PermissionRequest', permission_mode: 'default',
  tool_name: 'Bash', tool_input: { command: 'ls', description: 'List' }, ...extra,
});
const tmp = () => mkdtempSync(join(tmpdir(), 'adp-'));   // short: a Unix socket path must stay under ~104 bytes
function post(sock, body, { token = TOKEN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request({ socketPath: sock, path: PERM_PATH, method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json', ...(token ? { 'X-AD-Perm-Token': token } : {}), ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, sig: res.headers['x-ad-sig'] }));
    });
    req.on('error', reject); req.end(data);
  });
}
async function withServer(opts, fn) {
  const dir = tmp(); const sock = join(dir, 's.sock');
  const got = [], resolved = [];
  const srv = createPermServer({ token: TOKEN, isKnownSession: sid => sid.startsWith('sess-'), onRequest: e => got.push(e), onResolved: (id, why) => resolved.push({ id, why }), ...opts });
  await srv.listen(sock);
  try { await fn({ srv, sock, got, resolved }); } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
}
const until = async (cond, ms = 2000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };

// ── core/perm.js ──
test('decisionOutput: allow / deny in the PermissionRequest hook output shape, never updatedPermissions', () => {
  assert.deepEqual(P.decisionOutput('allow'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(P.decisionOutput('deny'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'AgentDesk에서 거부' } } });
  assert.equal(P.decisionOutput('deny', '  운영 DB\u0000 금지\n').hookSpecificOutput.decision.message, '운영 DB  금지');
  assert.equal(P.decisionOutput('allow', 'ignored').hookSpecificOutput.decision.message, undefined);
  assert.throws(() => P.decisionOutput('ask'));
  assert.deepEqual(P.timeoutOutput(), {});
});

test('cleanReason strips C0/C1 controls, bidi controls and zero-width characters', () => {
  assert.equal(P.cleanReason('a‮b​c\u0085d⁦e\u007Ff'), 'a b c d e f');
});

test('revealInvisible: bidi / invisible characters become ⟨U+XXXX⟩, normal text and newlines stay', () => {
  assert.equal(P.revealInvisible('ls‮ -la'), 'ls⟨U+202E⟩ -la');
  assert.equal(P.revealInvisible('a​b﻿c⁦d­e'), 'a⟨U+200B⟩b⟨U+FEFF⟩c⟨U+2066⟩d⟨U+00AD⟩e');
  assert.equal(P.revealInvisible('x\u001b[31my'), 'x⟨U+001B⟩[31my');
  assert.equal(P.revealInvisible('한글\n\tok'), '한글\n\tok');
  // and every displayed field goes through it
  const s = P.summarize(hookInput({ tool_input: { command: 'rm -rf /tmp/x ⁧#⁩ safe' } }));
  assert.ok(s.command.includes('⟨U+2067⟩') && !/[⁦-⁩]/.test(s.command));
  const e = P.summarize(hookInput({ tool_name: 'Write', tool_input: { file_path: '/w/a‮txt.js', content: 'x​y' } }));
  assert.ok(e.filePath.includes('⟨U+202E⟩') && e.preview.includes('⟨U+200B⟩'));
});

test('summarize: Bash shows the whole command, masked; over 4,000 chars → truncated', () => {
  const s = P.summarize(hookInput({ tool_input: { command: 'mysql -u root --password=hunter2secret -e "select 1"', description: 'Query' } }));
  assert.equal(s.kind, 'bash'); assert.equal(s.tool, 'Bash'); assert.equal(s.truncated, false);
  assert.ok(!s.command.includes('hunter2secret') && s.command.includes('[MASKED]'));
  assert.equal(s.desc, 'Query'); assert.equal(s.text, `Query\n${s.command}`);
  assert.equal(s.hasSuggestions, false);
  const tok = P.summarize(hookInput({ tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x' } }));
  assert.ok(!tok.command.includes('abcdefghijklmnop'));
  assert.equal(P.summarize(hookInput({ tool_input: { command: 'x'.repeat(P.CMD_MAX) } })).truncated, false);
  assert.equal(P.summarize(hookInput({ tool_input: { command: 'x'.repeat(P.CMD_MAX + 1) } })).truncated, true);
});

test('summarize: Write previews 40 lines / 3,000 chars, truncated beyond', () => {
  const w = P.summarize(hookInput({ tool_name: 'Write', tool_input: { file_path: '/w/c.txt', content: '1\n2\n3\n4' } }));
  assert.deepEqual([w.kind, w.added, w.removed, w.text, w.preview, w.truncated], ['edit', 4, 0, '/w/c.txt (+4 -0)', '1\n2\n3\n4', false]);
  const many = Array.from({ length: 41 }, (_, i) => `line${i}`).join('\n');
  const w2 = P.summarize(hookInput({ tool_name: 'Write', tool_input: { file_path: '/w/c.txt', content: many } }));
  assert.equal(w2.truncated, true); assert.ok(w2.preview.includes('line39') && !w2.preview.includes('line40'));
  assert.equal(P.summarize(hookInput({ tool_name: 'Write', tool_input: { file_path: '/w/c', content: 'y'.repeat(3001) } })).truncated, true);
  assert.equal(P.summarize(hookInput({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/w/n.ipynb', new_source: 'print(1)' } })).preview, 'print(1)');
});

test('summarize: Edit previews old → new (20 lines each); MultiEdit shows the count and the first edit', () => {
  const e = P.summarize(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/w/app/a.js', old_string: 'a\nb', new_string: 'a\nb\nc' } }));
  assert.deepEqual([e.kind, e.filePath, e.added, e.removed, e.truncated], ['edit', '/w/app/a.js', 3, 2, false]);
  assert.equal(e.preview, '--- a\n--- b\n+++ a\n+++ b\n+++ c');
  const long = Array.from({ length: 21 }, (_, i) => `n${i}`).join('\n');
  assert.equal(P.summarize(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/w/a', old_string: 'x', new_string: long } })).truncated, true);
  const m = P.summarize(hookInput({ tool_name: 'MultiEdit', tool_input: { file_path: '/w/b.js', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'p\nq', new_string: '' }] } }));
  assert.deepEqual([m.added, m.removed, m.edits, m.truncated], [2, 3, 2, true]);
  assert.ok(m.preview.startsWith('--- x\n+++ y'));
  const m1 = P.summarize(hookInput({ tool_name: 'MultiEdit', tool_input: { file_path: '/w/b.js', edits: [{ old_string: 'x', new_string: 'y' }] } }));
  assert.equal(m1.truncated, false);
});

test('summarize: other tools are JSON cut at 1,000 chars (truncated) and masked; suggestions are only flagged', () => {
  const s = P.summarize(hookInput({ tool_name: 'mcp__db__query', tool_input: { sql: 'x'.repeat(5000) }, permission_suggestions: [{ type: 'addRules', behavior: 'allow' }] }));
  assert.equal(s.kind, 'json'); assert.equal(s.truncated, true);
  assert.ok(s.text.length <= P.JSON_MAX + 1, String(s.text.length));
  assert.equal(s.hasSuggestions, true);
  const d = P.summarize(hookInput({ tool_name: 'WebFetch', tool_input: { url: 'https://e.com', dsn: 'mysql://u:p@db.internal/prod' } }));
  assert.ok(!d.text.includes('db.internal'), d.text); assert.equal(d.truncated, false);
  assert.equal(P.summarize(null).tool, '?');
});

test('sortQueue: oldest first, seq breaks ties', () => {
  const q = P.sortQueue([{ id: 'c', createdAt: 30, seq: 3 }, { id: 'a', createdAt: 10, seq: 2 }, { id: 'b', createdAt: 10, seq: 1 }]);
  assert.deepEqual(q.map(x => x.id), ['b', 'a', 'c']);
});

// ── perm/server.mjs ──
test('server: 401 wrong/missing token, 403 unknown session / Origin / other Host, 400 bad JSON, 413 too big', async () => {
  await withServer({}, async ({ sock, got }) => {
    assert.equal((await post(sock, hookInput(), { token: 'b'.repeat(64) })).status, 401);
    assert.equal((await post(sock, hookInput(), { token: '' })).status, 401);
    assert.equal((await post(sock, hookInput({ session_id: 'other' }))).status, 403);
    assert.equal((await post(sock, hookInput(), { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await post(sock, hookInput(), { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await post(sock, hookInput(), { headers: { Host: 'localhost:7333' } })).status, 403);
    assert.equal((await post(sock, '{nope')).status, 400);
    // declared too big: refused before the body is read
    const status413 = await new Promise((resolve, reject) => {
      const req = request({ socketPath: sock, path: PERM_PATH, method: 'POST', headers: { Host: 'localhost', 'X-AD-Perm-Token': TOKEN, 'Content-Length': PERM_MAX_BODY + 1 } }, res => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on('error', e => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
      req.write('{"session_id":"sess-1"');
    });
    assert.equal(status413, 413);
    assert.equal(got.length, 0, 'nothing reached the renderer');
  });
});

test('server: holds the request until a decision; the answer is signed; decide only works once', async () => {
  await withServer({}, async ({ srv, sock, got, resolved }) => {
    const p = post(sock, hookInput());
    await until(() => got.length === 1);
    const e = got[0];
    assert.equal(e.sessionId, 'sess-1'); assert.equal(e.summary.command, 'ls'); assert.ok(e.expiresAt > e.createdAt);
    assert.equal(JSON.stringify(e).includes(TOKEN), false, 'the token never reaches the renderer');
    assert.equal(srv.list().length, 1);
    assert.equal(srv.decide('not-pending', 'allow'), false);
    assert.equal(srv.decide(e.id, 'deny', '테스트 거부'), true);
    const r = await p;
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '테스트 거부' } } });
    assert.equal(r.sig, signBody(TOKEN, r.body));
    assert.equal(srv.decide(e.id, 'allow'), false);
    assert.deepEqual(resolved, [{ id: e.id, why: 'deny' }]);
  });
});

test('server: no decision in time → 200 {} (terminal prompt); "pass" answers {} at once', async () => {
  await withServer({ timeoutSec: 0.05 }, async ({ sock, resolved }) => {
    const r = await post(sock, hookInput());
    assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), {});
    assert.equal(resolved[0].why, 'timeout');
  });
  await withServer({}, async ({ srv, sock, got }) => {
    const p = post(sock, hookInput());
    await until(() => got.length === 1);
    assert.equal(srv.decide(got[0].id, 'pass'), true);
    assert.deepEqual(JSON.parse((await p).body), {});
  });
});

test('server: queue is oldest first, capped at maxPending (429)', async () => {
  await withServer({ maxPending: 2 }, async ({ srv, sock, got }) => {
    const a = post(sock, hookInput({ tool_input: { command: 'first' } }));
    await until(() => got.length === 1);
    const b = post(sock, hookInput({ tool_input: { command: 'second' } }));
    await until(() => got.length === 2);
    assert.equal((await post(sock, hookInput())).status, 429);
    assert.deepEqual(srv.list().map(e => e.summary.command), ['first', 'second']);
    srv.decide(got[1].id, 'allow'); srv.decide(got[0].id, 'allow');
    assert.equal(JSON.parse((await a).body).hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(JSON.parse((await b).body).hookSpecificOutput.decision.behavior, 'allow');
  });
});

test('server: closing answers every pending request with {} (no decision)', async () => {
  const dir = tmp(); const sock = join(dir, 's.sock'); const got = [];
  const srv = createPermServer({ token: TOKEN, isKnownSession: () => true, onRequest: e => got.push(e) });
  await srv.listen(sock);
  const p = post(sock, hookInput());
  await until(() => got.length === 1);
  await srv.close();
  assert.deepEqual(JSON.parse((await p).body), {});
  rmSync(dir, { recursive: true, force: true });
});

test('server: a request answered in the terminal goes stale on the matching tool event or the end of the turn', async () => {
  await withServer({}, async ({ srv, sock, got, resolved }) => {
    const a = post(sock, hookInput({ tool_input: { command: 'one' } }));
    const b = post(sock, hookInput({ tool_input: { command: 'two' } }));
    await until(() => got.length === 2);
    assert.equal(srv.staleFromEvent({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { command: 'one' } }), 0);
    assert.equal(srv.staleFromEvent({ session_id: 'sess-2', hook_event_name: 'Stop' }), 0);
    assert.equal(srv.staleFromEvent({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'one' } }), 0);
    assert.equal(srv.staleFromEvent({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'one' } }), 1);
    assert.deepEqual(JSON.parse((await a).body), {});
    assert.equal(srv.list().length, 1);
    assert.equal(srv.staleFromEvent({ session_id: 'sess-1', hook_event_name: 'Stop' }), 1);
    assert.deepEqual(JSON.parse((await b).body), {});
    assert.deepEqual(resolved.map(r => r.why), ['stale', 'stale']);
  });
});

test('server: staleFromEvent never produces a decision (fuzz, 200 random events)', async () => {
  const names = ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd', 'PreToolUse', 'Notification', 'PermissionRequest', '', null];
  const tools = ['Bash', 'Edit', 'Write', '', null, 42];
  const inputs = [{ command: 'c0' }, { command: 'c1' }, { command: 'c2' }, null, 'str', { behavior: 'allow' }, { hookSpecificOutput: { decision: { behavior: 'allow' } } }];
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  await withServer({ maxPending: 20 }, async ({ srv, sock, got }) => {
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(post(sock, hookInput({ tool_input: { command: `c${i}` } })));
    await until(() => got.length === 3);
    for (let i = 0; i < 200; i++) {
      const ev = { session_id: ['sess-1', 'sess-2', 'x', '', 7][rnd(5)], hook_event_name: names[rnd(names.length)], tool_name: tools[rnd(tools.length)], tool_input: inputs[rnd(inputs.length)], behavior: 'allow' };
      srv.staleFromEvent(ev);
      if (rnd(5) === 0) srv.staleFromEvent(null);
    }
    srv.staleFromEvent({ session_id: 'sess-1', hook_event_name: 'Stop' });
    for (const p of answers) { const r = await p; assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), {}, r.body); }
  });
});

// ── openPermEndpoint: files and permissions ──
test('endpoint: socket and token live in a 0700 directory, token 0600; close removes both; stale files are replaced', async () => {
  const home = tmp(); const dir = join(home, 'perm');
  mkdirSync(dir, { mode: 0o755 }); writeFileSync(join(dir, 'perm-token'), 'stale', { mode: 0o644 }); writeFileSync(join(dir, 'perm.sock'), 'junk');
  const srv = await openPermEndpoint({ dir, isKnownSession: () => true });
  try {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'perm-token')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dir, 'perm-token'), 'utf-8'), /^[0-9a-f]{64}$/);
    assert.ok(statSync(join(dir, 'perm.sock')).isSocket());
  } finally { await srv.close(); }
  assert.equal(existsSync(join(dir, 'perm-token')), false); assert.equal(existsSync(join(dir, 'perm.sock')), false);
  rmSync(home, { recursive: true, force: true });
});

test('endpoint: when listening fails no token file is left', async () => {
  const home = tmp(); const blocker = join(home, 'perm');
  writeFileSync(blocker, '');                     // a regular file where the directory should be: mkdir / listen fail on every OS
  const dir = join(blocker, 'sub');
  let opened = null;
  try { await assert.rejects(openPermEndpoint({ dir }).then(s => { opened = s; })); }
  finally { if (opened) await opened.close(); }   // never leave a listening server behind (it would keep the process alive)
  assert.equal(existsSync(join(dir, 'perm-token')), false);
  rmSync(home, { recursive: true, force: true });
});

// ── perm-hook.sh end to end (bash + curl + openssl) ──
function hookHome() {
  const home = tmp(); const d = join(home, '.roca'); mkdirSync(join(d, 'perm'), { recursive: true, mode: 0o700 });
  const script = join(d, 'perm-hook.sh'); writeFileSync(script, permHookScript(5), { mode: 0o700 });
  const run = (input = hookInput()) => new Promise(resolve => {
    const env = { PATH: process.env.PATH, HOME: home };
    const c = spawn('/bin/bash', [script], { env }); let out = '';
    c.stdout.on('data', x => { out += x; }); c.on('close', code => resolve({ code, out }));
    c.stdin.on('error', () => {});   // the script may exit without reading stdin (EPIPE)
    c.stdin.end(JSON.stringify(input));
  });
  return { home, dir: join(d, 'perm'), run };
}

test('perm-hook.sh: prints the signed decision; nothing without the socket, with a wrong token, or when the widget is down', async () => {
  const h = hookHome();
  try {
    assert.deepEqual(await h.run(), { code: 0, out: '' }, 'no socket / token → silent');
    const got = [];
    const srv = await openPermEndpoint({ dir: h.dir, isKnownSession: () => true, onRequest: e => got.push(e) });
    try {
      const p = h.run();
      await until(() => got.length === 1, 5000);
      srv.decide(got[0].id, 'allow');
      const r = await p;
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.out), P.decisionOutput('allow'));
      const tok = readFileSync(join(h.dir, 'perm-token'), 'utf-8');
      writeFileSync(join(h.dir, 'perm-token'), 'b'.repeat(64));   // wrong token → 401 → nothing printed
      assert.deepEqual(await h.run(), { code: 0, out: '' });
      writeFileSync(join(h.dir, 'perm-token'), tok);
    } finally { await srv.close(); }
    const t0 = Date.now();
    assert.deepEqual(await h.run(), { code: 0, out: '' }, 'widget down → silent');
    assert.ok(Date.now() - t0 < 3000);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// regression for the review's PoC: a stale token from a crashed run and another process answering where the widget
// used to listen must not get an allow through, with or without a forged signature
test('perm-hook.sh: an impostor holding the socket path cannot answer (unsigned or wrongly signed allow → nothing)', async () => {
  const h = hookHome();
  writeFileSync(join(h.dir, 'perm-token'), 'c'.repeat(64), { mode: 0o600 });   // left behind by a crashed run
  const ALLOW = JSON.stringify(P.decisionOutput('allow'));
  try {
    for (const sig of [null, 'f'.repeat(64), signBody('d'.repeat(64), ALLOW)]) {
      let seenToken = '';
      const imp = createServer((q, r) => { seenToken = q.headers['x-ad-perm-token']; q.resume(); q.on('end', () => { r.writeHead(200, sig ? { 'X-AD-Sig': sig } : {}); r.end(ALLOW); }); });
      const sock = join(h.dir, 'perm.sock'); rmSync(sock, { force: true });
      await new Promise(res => imp.listen(sock, res));
      try {
        const r = await h.run(hookInput({ tool_input: { command: 'rm -rf ~' } }));
        assert.deepEqual(r, { code: 0, out: '' }, `sig=${sig}`);
        assert.ok(seenToken, 'the impostor did get a request');
      } finally { await new Promise(res => imp.close(res)); }
    }
    // the same impostor that does know the token is indistinguishable — that is why the token is 0600 in a 0700 dir
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── perm/settings.mjs ──
test('settings: install / uninstall keep every other hook; a broken settings.json is refused and left untouched', () => {
  const home = tmp(); const file = join(home, 'settings.json'); const backups = join(home, 'bk');
  const other = { matcher: '*', hooks: [{ type: 'command', command: 'orca-hook' }] };
  const logging = { hooks: [{ type: 'command', command: '/h/.roca/hook.sh', timeout: 5, async: true }] };
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PermissionRequest: [other, logging], Stop: [logging] } }), { mode: 0o644 });
  S.installPermHookAt({ settingsFile: file, command: '/h/.roca/perm-hook.sh', timeoutSec: 90, backupDir: backups });
  S.installPermHookAt({ settingsFile: file, command: '/h/.roca/perm-hook.sh', timeoutSec: 60, backupDir: backups });   // replaces, not duplicates
  let s = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks.PermissionRequest.slice(0, 2), [other, logging]);
  assert.deepEqual(s.hooks.PermissionRequest[2], { hooks: [{ type: 'command', command: '/h/.roca/perm-hook.sh', timeout: 70 }] });
  assert.equal(s.hooks.PermissionRequest.length, 3);
  assert.equal(S.permHookPresent(file), true);
  assert.equal(statSync(file).mode & 0o777, 0o644, 'file mode kept');
  const bks = readdirSync(backups); assert.ok(bks.length >= 1);
  for (const b of bks) assert.equal(statSync(join(backups, b)).mode & 0o777, 0o600);
  S.uninstallPermHookAt({ settingsFile: file });
  s = JSON.parse(readFileSync(file, 'utf-8'));
  assert.deepEqual(s.hooks, { PermissionRequest: [other, logging], Stop: [logging] });
  assert.equal(S.permHookPresent(file), false);

  const broken = '{ "hooks": { "Stop": [ ,,, }';
  writeFileSync(file, broken);
  assert.throws(() => S.installPermHookAt({ settingsFile: file, command: '/h/.roca/perm-hook.sh', timeoutSec: 90 }), /settings\.json을 읽을 수 없습니다/);
  assert.throws(() => S.uninstallPermHookAt({ settingsFile: file }), /settings\.json을 읽을 수 없습니다/);
  assert.equal(readFileSync(file, 'utf-8'), broken, 'never overwritten with {}');
  assert.throws(() => S.readJsonStrict(file));
  writeFileSync(file, '[1,2]'); assert.throws(() => S.readJsonStrict(file), /JSON 객체가 아닙니다/);
  assert.deepEqual(S.readJsonStrict(join(home, 'missing.json')), {});
  assert.equal(readdirSync(home).some(n => n.includes('.tmp')), false, 'no temp files left');
  rmSync(home, { recursive: true, force: true });
});
