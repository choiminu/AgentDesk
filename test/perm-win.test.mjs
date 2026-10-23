// Windows approval / guardrail transport (perm/server.mjs): the named-pipe address, the Node hook (perm-hook.cjs /
// guard-hook.cjs) with its nonce + HMAC request auth and nonce-bound answer signature, the .cmd launcher and the
// runner choice. The pipe itself only exists on Windows: here the same server listens on a Unix socket and the hook
// reads that socket's path from perm-addr — the hook code and the auth are the same on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const S = await import('../perm/server.mjs');
const ST = await import('../perm/settings.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'adw-'));   // short: a Unix socket path must stay under ~104 bytes
const hmac = (k, s) => createHmac('sha256', k).update(s).digest('hex');
const pre = (extra = {}) => ({ session_id: 'sess-1', cwd: '/w/app', hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm -rf ~', description: 'x'.repeat(50) }, ...extra });
const ASK = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '[AgentDesk 가드] test' } };

function runHook(script, input, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script], { env: { ...process.env, AGENTDESK_RECALL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', code => resolve({ code, out, err }));
    c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
function writeHook(dir, kind, timeoutSec = 10) {
  const f = join(dir, `${kind}-hook.cjs`); writeFileSync(f, S.nodeHookScript({ kind, dir, timeoutSec })); return f;
}
function rawPost(sock, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, path: S.GUARD_PATH, method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, sig: res.headers['x-ad-sig'] }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('permAddress: a fresh random pipe name on Windows, the private socket elsewhere', () => {
  const a = S.permAddress('C:\\Users\\u\\.roca\\perm', 'win32'), b = S.permAddress('C:\\Users\\u\\.roca\\perm', 'win32');
  assert.match(a, /^\\\\\.\\pipe\\agentdesk-perm-[0-9a-f]{32}$/);
  assert.ok(S.PIPE_RE.test(a)); assert.notEqual(a, b);
  assert.equal(S.permAddress('/h/.roca/perm', 'darwin'), join('/h/.roca/perm', S.PERM_SOCK));
  assert.equal(S.permAddress('/h/.roca/perm', 'linux'), join('/h/.roca/perm', S.PERM_SOCK));
  for (const bad of ['\\\\.\\pipe\\agentdesk-perm-x', '\\\\.\\pipe\\other-' + 'a'.repeat(32), '\\\\evil\\pipe\\agentdesk-perm-' + 'a'.repeat(32)]) assert.equal(S.PIPE_RE.test(bad), false, bad);
});

test('openPermEndpoint: writes perm-addr (0600) next to the token and removes both on close', async () => {
  const dir = tmp();
  try {
    const srv = await S.openPermEndpoint({ dir, onGuard: () => ({}) });
    const addr = join(dir, S.PERM_ADDR);
    assert.equal(readFileSync(addr, 'utf-8'), join(dir, S.PERM_SOCK));
    assert.equal(statSync(addr).mode & 0o777, 0o600);
    await srv.close();
    assert.equal(existsSync(addr), false); assert.equal(existsSync(join(dir, S.PERM_TOKEN)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server: nonce + HMAC auth — valid → answer signed over nonce+body; wrong MAC, bad nonce, body changed → 401', async () => {
  const dir = tmp();
  try {
    const srv = await S.openPermEndpoint({ dir, onGuard: () => ASK });
    const tok = readFileSync(join(dir, S.PERM_TOKEN), 'utf-8'), sock = srv.socketPath;
    const body = JSON.stringify(pre()), nonce = 'c'.repeat(32);
    const auth = hmac(tok, `${nonce}\n${createHash('sha256').update(body).digest('hex')}`);
    const ok = await rawPost(sock, body, { 'X-AD-Nonce': nonce, 'X-AD-Perm-Auth': auth });
    assert.equal(ok.status, 200); assert.deepEqual(JSON.parse(ok.body), ASK);
    assert.equal(ok.sig, hmac(tok, `${nonce}\n${ok.body}`));
    assert.notEqual(ok.sig, hmac(tok, ok.body));   // not the bash hook's signature: an answer cannot be replayed across modes
    assert.equal((await rawPost(sock, body, { 'X-AD-Nonce': nonce, 'X-AD-Perm-Auth': 'f'.repeat(64) })).status, 401);
    assert.equal((await rawPost(sock, body, { 'X-AD-Nonce': 'xyz', 'X-AD-Perm-Auth': auth })).status, 401);
    assert.equal((await rawPost(sock, body, { 'X-AD-Perm-Auth': auth })).status, 401);
    assert.equal((await rawPost(sock, body.replace('rm -rf', 'rm -fr'), { 'X-AD-Nonce': nonce, 'X-AD-Perm-Auth': auth })).status, 401);
    // the token header path (bash hook) is unchanged
    const legacy = await rawPost(sock, body, { 'X-AD-Perm-Token': tok });
    assert.equal(legacy.status, 200); assert.equal(legacy.sig, hmac(tok, legacy.body));
    await srv.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server: a MAC-auth guard body over 2 MB is refused at once (413), unlike the bash hook\'s cut-and-drain', async () => {
  const dir = tmp();
  try {
    let called = false;
    const srv = await S.openPermEndpoint({ dir, onGuard: () => { called = true; return ASK; } });
    const tok = readFileSync(join(dir, S.PERM_TOKEN), 'utf-8');
    const body = JSON.stringify(pre({ tool_name: 'Write', tool_input: { file_path: '/w/app/big.txt', content: 'x'.repeat(3 * 1024 * 1024) } })), nonce = 'd'.repeat(32);
    const mac = hmac(tok, `${nonce}\n${createHash('sha256').update(body).digest('hex')}`);
    const r = await rawPost(srv.socketPath, body, { 'X-AD-Nonce': nonce, 'X-AD-Perm-Auth': mac }).catch(e => ({ status: 'closed', e }));
    assert.ok(r.status === 413 || r.status === 'closed', String(r.status));
    assert.equal(called, false);
    assert.deepEqual(srv.lastHookAt(), { perm: null, guard: null });   // never authenticated
    // the token path (bash hook) still reads the first 2 MB and answers
    const legacy = await rawPost(srv.socketPath, body, { 'X-AD-Perm-Token': tok });
    assert.equal(legacy.status, 200); assert.equal(called, true);
    await srv.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server: lastHookAt records only hook requests that passed auth, per endpoint', async () => {
  const dir = tmp();
  try {
    const srv = await S.openPermEndpoint({ dir, onGuard: () => ({}) });
    const tok = readFileSync(join(dir, S.PERM_TOKEN), 'utf-8');
    assert.deepEqual(srv.lastHookAt(), { perm: null, guard: null });
    await rawPost(srv.socketPath, JSON.stringify(pre()), { 'X-AD-Perm-Token': 'b'.repeat(64) });
    assert.deepEqual(srv.lastHookAt(), { perm: null, guard: null });
    const t0 = Date.now();
    await rawPost(srv.socketPath, JSON.stringify(pre()), { 'X-AD-Perm-Token': tok });
    const a = srv.lastHookAt(); assert.ok(a.guard >= t0); assert.equal(a.perm, null);
    a.guard = 1; assert.notEqual(srv.lastHookAt().guard, 1);   // a copy
    await srv.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard-hook.cjs: prints the signed ask; sends only the guard fields; nothing without server, token or for no hit', async () => {
  const dir = tmp();
  try {
    const script = writeHook(dir, 'guard');
    assert.deepEqual(await runHook(script, pre()), { code: 0, out: '', err: '' });   // widget not running
    let seen = null;
    const srv = await S.openPermEndpoint({ dir, onGuard: (b) => { seen = b; return b.tool_input.command === 'rm -rf ~' ? ASK : {}; } });
    const r = await runHook(script, pre());
    assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.out), ASK);
    assert.deepEqual(Object.keys(seen.tool_input).sort(), ['command']);   // description dropped, like the jq filter
    assert.equal(seen.session_id, 'sess-1');
    const none = await runHook(script, pre({ tool_input: { command: 'npm test' } }));
    assert.deepEqual(JSON.parse(none.out), {});
    assert.equal((await runHook(script, pre(), { AGENTDESK_RECALL: '1' })).out, '');
    writeFileSync(join(dir, S.PERM_TOKEN), 'b'.repeat(64));   // a token the server does not hold → 401 → nothing
    assert.equal((await runHook(script, pre())).out, '');
    await srv.close();
    assert.equal((await runHook(script, pre())).out, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hook.cjs: an impostor holding the address cannot answer (unsigned, signed without nonce, wrong key → nothing)', async () => {
  const dir = tmp();
  try {
    const script = writeHook(dir, 'perm');
    const tok = 'a'.repeat(64), sock = join(dir, S.PERM_SOCK);
    writeFileSync(join(dir, S.PERM_TOKEN), tok); writeFileSync(join(dir, S.PERM_ADDR), sock);
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    for (const sign of [() => '', () => hmac(tok, allow), (n) => hmac('e'.repeat(64), `${n}\n${allow}`)]) {
      let tokenSeen = null;
      const fake = createServer((req, res) => { tokenSeen = req.headers['x-ad-perm-token'] || null; req.resume(); req.on('end', () => res.writeHead(200, { 'X-AD-Sig': sign(String(req.headers['x-ad-nonce'])) }).end(allow)); });
      await new Promise(r => fake.listen(sock, r));
      const r = await runHook(script, { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
      await new Promise(r => fake.close(r));
      assert.equal(r.out, ''); assert.equal(tokenSeen, null);   // and the token itself never left the hook
    }
    // the right key and nonce → printed (proves the loop above failed for the signature, not the setup)
    const real = createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(200, { 'X-AD-Sig': hmac(tok, `${req.headers['x-ad-nonce']}\n${allow}`) }).end(allow)); });
    await new Promise(r => real.listen(sock, r));
    const ok = await runHook(script, { session_id: 's' });
    await new Promise(r => real.close(r));
    assert.deepEqual(JSON.parse(ok.out), JSON.parse(allow));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hook.cjs: an address that is neither our pipe nor the socket in its own dir is never contacted', async () => {
  const dir = tmp(), other = tmp();
  try {
    const script = writeHook(dir, 'guard');
    const sock = join(other, 'x.sock'); let hit = false;
    const fake = createServer((req, res) => { hit = true; res.end('{}'); });
    await new Promise(r => fake.listen(sock, r));
    writeFileSync(join(dir, S.PERM_TOKEN), 'a'.repeat(64)); writeFileSync(join(dir, S.PERM_ADDR), sock);
    assert.equal((await runHook(script, pre())).out, '');
    assert.equal(hit, false);
    await new Promise(r => fake.close(r));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('nodeHookScript: perm waits timeoutSec + 5 s, guard 2 s; the dir is embedded as a JSON string', () => {
  const p = S.nodeHookScript({ kind: 'perm', dir: 'C:\\Users\\a "b"\\.roca\\perm', timeoutSec: 90 });
  assert.match(p, /setTimeout\(done, 95000\)/); assert.match(p, /\/v1\/permission/);
  assert.ok(p.includes(JSON.stringify('C:\\Users\\a "b"\\.roca\\perm')));
  const g = S.nodeHookScript({ kind: 'guard', dir: '/d' });
  assert.match(g, /setTimeout\(done, 2000\)/); assert.match(g, /\/v1\/guard/);
  assert.doesNotMatch(p + g, /X-AD-Perm-Token/);   // the Node hook never sends the token
});

test('winHookCmd: % doubled inside the .cmd; quote or line break in a path → error', () => {
  const c = S.winHookCmd({ runner: 'C:\\Users\\100%\\AgentDesk.exe', script: 'C:\\Users\\100%\\.roca\\perm-hook.cjs' });
  assert.match(c, /"C:\\Users\\100%%\\AgentDesk\.exe" "C:\\Users\\100%%\\\.roca\\perm-hook\.cjs"/);
  for (const bad of ['C:\\a"b\\node.exe', 'C:\\a\nb', 'C:\\a\rb', '']) assert.throws(() => S.winHookCmd({ runner: bad, script: 'C:\\x.cjs' }), /unusable path/);
  assert.throws(() => S.winHookCmd({ runner: 'C:\\n.exe', script: 'C:\\x"y.cjs' }), /unusable path/);
});

test('winHookCommand: node.exe + script with forward slashes, else cmd /d /c launcher; bad paths refused', () => {
  assert.equal(S.winHookCommand({ systemNode: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\u\\.roca\\perm-hook.cjs', launcher: 'C:\\Users\\u\\.roca\\perm-hook.cmd' }),
    '"C:/Program Files/nodejs/node.exe" "C:/Users/u/.roca/perm-hook.cjs"');
  assert.equal(S.winHookCommand({ systemNode: null, script: 'C:\\Users\\u\\.roca\\guard-hook.cjs', launcher: 'C:\\Users\\u\\.roca\\guard-hook.cmd' }),
    'cmd /d /c "C:\\Users\\u\\.roca\\guard-hook.cmd"');
  assert.throws(() => S.winHookCommand({ systemNode: null, launcher: 'C:\\Users\\50%\\.roca\\perm-hook.cmd' }), /unusable path/);
  assert.throws(() => S.winHookCommand({ systemNode: 'C:\\n"\\node.exe', script: 'C:\\x.cjs' }), /unusable path/);
  // both forms are recognised as ours in settings.json
  for (const command of ['"C:/Program Files/nodejs/node.exe" "C:/Users/u/.roca/perm-hook.cjs"', 'cmd /d /c "C:\\Users\\u\\.roca\\perm-hook.cmd"']) assert.equal(ST.isOurPermHook({ hooks: [{ command }] }), true, command);
  assert.equal(ST.isOurGuardHook({ hooks: [{ command: '"C:/n/node.exe" "C:/Users/u/.roca/guard-hook.cjs"' }] }), true);
});

test('winHookCmd / winHookRunner: launcher sets Node mode and always exits 0; portable without node → unavailable', () => {
  const c = S.winHookCmd({ runner: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\u\\.roca\\perm-hook.cjs' });
  assert.match(c, /^@echo off\r\n/); assert.match(c, /set "ELECTRON_RUN_AS_NODE=1"\r\n/);
  assert.match(c, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\u\\\.roca\\perm-hook\.cjs"\r\n/);
  assert.match(c, /exit \/b 0\r\n$/);
  assert.equal(S.winHookRunner({ execPath: 'C:\\A\\AgentDesk.exe', portable: false, systemNode: 'C:\\n\\node.exe' }), 'C:\\n\\node.exe');
  assert.equal(S.winHookRunner({ execPath: 'C:\\A\\AgentDesk.exe', portable: false, systemNode: null }), 'C:\\A\\AgentDesk.exe');
  assert.equal(S.winHookRunner({ execPath: 'C:\\Temp\\x\\AgentDesk.exe', portable: true, systemNode: null }), null);
});

test('settings: the Windows .cmd launchers are recognised as ours (replaced, not duplicated; removed on uninstall)', () => {
  const dir = tmp(), file = join(dir, 'settings.json');
  try {
    const other = { hooks: [{ type: 'command', command: 'C:\\tools\\perm-hook.cmd.bak' }] };
    writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [other] } }));
    const cmd = '"C:\\Users\\u\\.roca\\perm-hook.cmd"';
    ST.installPermHookAt({ settingsFile: file, command: cmd, timeoutSec: 90 });
    ST.installPermHookAt({ settingsFile: file, command: cmd, timeoutSec: 90 });
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).hooks.PermissionRequest.length, 2);
    assert.equal(ST.permHookPresent(file), true);
    ST.installGuardHookAt({ settingsFile: file, command: '"C:\\Users\\u\\.roca\\guard-hook.cmd"' });
    assert.equal(ST.guardHookPresent(file), true);
    ST.uninstallPermHookAt({ settingsFile: file }); ST.uninstallGuardHookAt({ settingsFile: file });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')).hooks, { PermissionRequest: [other] });
    assert.equal(ST.isOurPermHook({ hooks: [{ command: '/h/.roca/perm-hook.sh' }] }), true);
    assert.equal(ST.isOurPermHook({ hooks: [{ command: '/h/.roca/perm-hook.shx' }] }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
