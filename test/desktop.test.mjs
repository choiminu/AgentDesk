// Desktop integration (core/desktop.js) and the main-process wiring that cannot run without Electron: single-instance
// lock, global shortcuts, start at login, the app icon and the build / signing configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
await import('../core/desktop.js');
const D = globalThis.AgentDeskDesktop;
const src = readFileSync(new URL('../main.mjs', import.meta.url), 'utf-8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

test('SHORTCUTS: dock toggle and approval open, CommandOrControl+Shift', () => {
  assert.deepEqual({ ...D.SHORTCUTS }, { 'dock-toggle': 'CommandOrControl+Shift+D', 'perm-open': 'CommandOrControl+Shift+A' });
  assert.ok(Object.isFrozen(D.SHORTCUTS));
});

test('normalizeShortcutCfg: off unless explicitly enabled: true (no shortcuts.json → off)', () => {
  for (const v of [null, undefined, {}, 'x', [], { enabled: false }, { enabled: 'yes' }, { enabled: 1 }]) assert.deepEqual(D.normalizeShortcutCfg(v), { enabled: false }, JSON.stringify(v));
  assert.deepEqual(D.normalizeShortcutCfg({ enabled: true }), { enabled: true });
});

test('linuxAutostartDesktop: quoted Exec with spec escaping; refuses line breaks', () => {
  const t = D.linuxAutostartDesktop('/home/u/Apps/AgentDesk-0.2.8.AppImage');
  assert.match(t, /^\[Desktop Entry\]\n/);
  assert.match(t, /\nType=Application\n/);
  assert.match(t, /\nExec="\/home\/u\/Apps\/AgentDesk-0\.2\.8\.AppImage"\n/);
  assert.equal(D.linuxAutostartDesktop('/opt/A B/x$y').split('\n').find(l => l.startsWith('Exec=')), 'Exec="/opt/A B/x\\\\$y"');
  assert.equal(D.linuxAutostartDesktop('/o/50%').split('\n').find(l => l.startsWith('Exec=')), 'Exec="/o/50%%"');
  assert.equal(D.linuxAutostartDesktop('/o/a\\b').split('\n').find(l => l.startsWith('Exec=')), 'Exec="/o/a\\\\\\\\b"');
  for (const bad of ['', null, '/x\nExec=evil', '/x\r', '/x\0']) assert.throws(() => D.linuxAutostartDesktop(bad), /bad executable path/);
});

test('main.mjs: single-instance lock before anything opens; the second copy never touches the approval files', () => {
  const lock = src.indexOf('app.requestSingleInstanceLock()');
  assert.ok(lock > 0 && lock < src.indexOf('function createWindow'));
  assert.match(src, /if \(!SINGLE_INSTANCE\) app\.exit\(0\);/);
  assert.match(src, /app\.on\("second-instance", \(\) => \{[\s\S]{0,200}mainWindow\.show\(\); mainWindow\.focus\(\);/);
  assert.match(src, /app\.on\("before-quit", \(\) => \{ if \(!SINGLE_INSTANCE\) return;/);
  assert.match(src, /app\.on\("ready", \(\) => \{\n  if \(!SINGLE_INSTANCE\) return;/);
  assert.match(src, /function startPermServer\(\) \{\n  if \(permServer \|\| permStarting \|\| !SINGLE_INSTANCE\)/);
});

test('main.mjs: global shortcuts are opt-in, failures ignored, renderer gets roca:shortcut { action }', () => {
  assert.match(src, /ipcMain\.handle\("roca:shortcuts"/);
  assert.match(src, /globalShortcut\.register\(accel, \(\) => onGlobalShortcut\(action\)\); \} catch \{ shortcutsRegistered\[action\] = false; \}/);
  assert.match(src, /toRenderer\("roca:shortcut", \{ action \}\)/);
  assert.match(src, /app\.on\("will-quit", \(\) => \{ try \{ globalShortcut\.unregisterAll\(\); \} catch \{\} \}\)/);
  assert.match(src, /if \(!shortcutsCfg\.enabled\) return;/);
});

test('main.mjs: start at login via roca:autostart — OS login item, XDG autostart on Linux, never from a dev run', () => {
  const body = src.slice(src.indexOf('ipcMain.handle("roca:autostart"'), src.indexOf('// ── Global shortcuts'));
  assert.match(body, /if \(!autostartSupported\(\)\) return \{ ok: false/);
  assert.match(body, /app\.setLoginItemSettings\(\{ openAtLogin: on \}\)/);
  assert.match(body, /linuxAutostartDesktop\(process\.env\.APPIMAGE \|\| process\.execPath\)/);
  assert.match(body, /typeof on === "boolean"/);
});

test('main.mjs: approval / guardrail hooks on Windows use the Node hook and its launcher, never the bash script', () => {
  assert.match(src, /join\(ROCA_DIR, IS_WIN \? "perm-hook\.cmd" : "perm-hook\.sh"\)/);
  assert.match(src, /join\(ROCA_DIR, IS_WIN \? "guard-hook\.cmd" : "guard-hook\.sh"\)/);
  assert.doesNotMatch(src, /error: "macOS \/ Linux only"/);
  assert.match(src, /nodeHookScript\(\{ kind, dir: PERM_DIR, timeoutSec: t \}\)/);
  assert.match(src, /permAvailable: safetyHooksAvailable\(\)/);
});

test('main.mjs: update always marks downloads; the build flag only adds a dialog line; Linux picks by install format', () => {
  assert.match(src, /markDownloadedPlan\(process\.platform\)/);
  assert.doesNotMatch(src, /markDownloadedPlan\([^)]*BUILD_SIGNED/);
  assert.match(src, /installerSigned\(process\.platform, BUILD_SIGNED\) \? \(IS_MAC \? "\\n공증된 설치 파일입니다"/);
  assert.match(src, /downloadPlan\(j, app\.getVersion\(\), process\.platform, process\.arch, INSTALL_FORMAT\)/);
  assert.match(src, /pickAsset\(info\.assets, process\.platform, process\.arch, INSTALL_FORMAT\)/);
});

test('icon: assets/icon.png is a 512×512 RGBA PNG and every platform build uses it', () => {
  const b = readFileSync(new URL('../assets/icon.png', import.meta.url));
  assert.equal(b.readUInt32BE(0), 0x89504e47);
  assert.equal(b.readUInt32BE(16), 512); assert.equal(b.readUInt32BE(20), 512); assert.equal(b[25], 6);
  for (const p of ['mac', 'linux', 'win']) assert.equal(pkg.build[p].icon, 'assets/icon.png', p);
  assert.ok(pkg.build.files.includes('assets/**/*'));   // packaged for the window / tray icon
});

test('make-icon: decode → encode round trip keeps every pixel', async () => {
  const M = await import('../scripts/make-icon.mjs');
  const src2 = M.decodePng(readFileSync(new URL('../assets/pixel/char_0.png', import.meta.url)));
  const again = M.decodePng(M.encodePng(src2.w, src2.h, src2.px));
  assert.equal(again.w, src2.w); assert.equal(again.h, src2.h); assert.ok(again.px.equals(src2.px));
  const icon = M.decodePng(readFileSync(new URL('../assets/icon.png', import.meta.url)));
  assert.ok(icon.px.equals(M.drawIcon(src2)));   // the committed icon is what the script draws
});

test('build config: hardened runtime + entitlements, no null identity, notarize left to env, deb for both arches', () => {
  const m = pkg.build.mac;
  assert.equal(m.hardenedRuntime, true);
  assert.equal(m.entitlements, 'build/entitlements.mac.plist'); assert.equal(m.entitlementsInherit, 'build/entitlements.mac.plist');
  assert.equal('identity' in m, false);   // identity: null would skip signing even with CSC_LINK
  assert.equal('notarize' in m, false);   // electron-builder notarizes only when APPLE_* env vars are present
  assert.equal(m.type, 'distribution');   // never falls back to a "Mac Developer" certificate
  assert.ok(m.extendInfo.NSAppleEventsUsageDescription);
  const ent = readFileSync(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf-8');
  assert.match(ent, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(ent, /com\.apple\.security\.automation\.apple-events/);
  assert.doesNotMatch(ent, /disable-library-validation|app-sandbox/);
  assert.deepEqual(pkg.build.linux.target.find(t => t.target === 'deb').arch, ['x64', 'arm64']);
  assert.ok(existsSync(new URL('../scripts/adhoc-sign.cjs', import.meta.url)));
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.cjs');
  assert.ok(pkg.devDependencies['@electron/fuses']);
});

test('fuses: RunAsNode only on Windows; NODE_OPTIONS / inspect off; asar-only; asar integrity on macOS + Windows', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { fuseConfigFor } = req('../scripts/after-pack.cjs');
  const { FuseV1Options: F, FuseVersion } = req('@electron/fuses');
  for (const p of ['darwin', 'linux', 'win32']) {
    const c = fuseConfigFor(p);
    assert.equal(c.version, FuseVersion.V1);
    assert.equal(c[F.RunAsNode], p === 'win32', p);
    assert.equal(c[F.EnableNodeOptionsEnvironmentVariable], false);
    assert.equal(c[F.EnableNodeCliInspectArguments], false);
    assert.equal(c[F.OnlyLoadAppFromAsar], true);
    assert.equal(c[F.EnableEmbeddedAsarIntegrityValidation], p === 'linux' ? undefined : true, p);
  }
  const src2 = readFileSync(new URL('../scripts/after-pack.cjs', import.meta.url), 'utf-8');
  assert.ok(src2.indexOf('addElectronFuses') < src2.indexOf('await adhocSign(context)'));   // fuses first, then the signature
});

test('main.mjs: helper scripts never run this binary in Node mode (utility process when there is no system node)', () => {
  assert.doesNotMatch(src.replace('delete e.ELECTRON_RUN_AS_NODE;', ''), /ELECTRON_RUN_AS_NODE/);
  assert.match(src, /utilityProcess\.fork\(script, args,/);
  for (const f of ['"brief.mjs"', '"slack-bridge.mjs"']) assert.match(src, new RegExp(`runHelper\\(join\\(dirname\\(RECALL_CLI\\), ${f}\\)`), f);
  assert.match(src, /runHelper\(RECALL_CLI, \["list"/);
  // briefing handoff: removed on error / exit, never inherited from the environment
  const brief = src.slice(src.indexOf('function runBrief()'), src.indexOf('function briefTick()'));
  assert.match(brief, /delete env\.AGENTDESK_BRIEF_JIRA;/);
  assert.match(brief, /child\.onError\(\(\) => \{ briefRunning = false; dropHandoff\(\); \}\)/);
});

test('main.mjs: hooks-status reports lastHookAt; autostart unsupported in the portable exe', () => {
  assert.match(src, /const n = Math\.max\(by\.perm \|\| 0, by\.guard \|\| 0\); return \{ lastHookAt: n \|\| null, lastHookAtBy: by \};/);
  assert.match(src, /const autostartSupported = \(\) => app\.isPackaged && !process\.env\.PORTABLE_EXECUTABLE_FILE;/);
  assert.match(src, /command: safetyHookCommand\("perm"\)/);
  assert.match(src, /winHookCommand\(\{ systemNode: winSystemNode, script: PERM_HOOK_NODE, launcher: PERM_HOOK_SCRIPT \}\)/);
});

test('CI: signing secrets are optional and the signed flag is injected only in signed mode', () => {
  const y = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf-8');
  assert.match(y, /if: steps\.sign\.outputs\.mode != 'none'\n\s+run: npm run \$\{\{ matrix\.script \}\} -- -c\.extraMetadata\.agentdeskSigned=\$\{\{ steps\.sign\.outputs\.mode \}\}/);
  assert.match(y, /if: steps\.sign\.outputs\.mode == 'none'\n\s+run: npm run \$\{\{ matrix\.script \}\}\n\s+env:\n\s+CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  for (const s of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) assert.match(y, new RegExp(`secrets\\.${s}\\b`), s);
  assert.doesNotMatch(y, /echo .*\$(CSC|APPLE|WIN_CSC)/);   // no secret value is ever echoed
  assert.match(y, /GITHUB_REF_TYPE" = tag \] && \[ "\$have" -gt 0 \] && \[ "\$have" -lt "\$need" \]/);   // partial secrets fail a tag build
  assert.match(y, /REQUIRE_SIGNING: \$\{\{ vars\.REQUIRE_SIGNING \}\}/);
  assert.match(y, /"\$REQUIRE_SIGNING" = true \] && \[ "\$need" -gt 0 \] && \[ "\$mode" = none \]/);
});
