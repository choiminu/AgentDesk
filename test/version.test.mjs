// Tests for release version comparison and installer selection (core/version.js).
// Run: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../core/version.js');
const V = globalThis.AgentDeskVersion;

test('parseVersion: v prefix, prerelease identifiers, invalid strings', () => {
  assert.deepEqual(V.parseVersion('v0.2.1-beta.3'), { major: 0, minor: 2, patch: 1, pre: ['beta', 3] });
  assert.deepEqual(V.parseVersion('0.2.1'), { major: 0, minor: 2, patch: 1, pre: [] });
  assert.deepEqual(V.parseVersion('1.0.0+build.5'), { major: 1, minor: 0, patch: 0, pre: [] });
  for (const bad of ['', null, undefined, 'latest', '0.2', '0.2.x', '0.2.1-', 'v', '1.2.3.4']) assert.equal(V.parseVersion(bad), null, String(bad));
});

test('isNewer: internal prereleases < release < next patch', () => {
  const order = ['0.2.0-internal.2', '0.2.0-internal.12', '0.2.0-internal.13', '0.2.0', '0.2.1', '0.2.2', '0.10.0', '1.0.0'];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
    assert.equal(V.isNewer(order[i], order[j]), i > j, `${order[i]} vs ${order[j]}`);
  }
});

test('isNewer: v prefix ignored, equal versions are not newer', () => {
  assert.equal(V.isNewer('v0.2.1', '0.2.0'), true);
  assert.equal(V.isNewer('v0.2.1', 'v0.2.1'), false);
  assert.equal(V.isNewer('0.2.1', 'v0.2.1'), false);
});

test('isNewer: semver prerelease precedence', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < order.length; i++) {
    assert.equal(V.isNewer(order[i], order[i - 1]), true, `${order[i]} > ${order[i - 1]}`);
    assert.equal(V.isNewer(order[i - 1], order[i]), false, `${order[i - 1]} < ${order[i]}`);
  }
});

test('isNewer: invalid strings are never newer', () => {
  assert.equal(V.isNewer('garbage', '0.2.0'), false);
  assert.equal(V.isNewer('0.2.1', 'garbage'), false);
  assert.equal(V.isNewer('', ''), false);
  assert.equal(V.isNewer(null, '0.2.0'), false);
});

const ASSETS = [
  'AgentDesk-0.2.1-arm64.dmg', 'AgentDesk-0.2.1.dmg',
  'AgentDesk-0.2.1.AppImage', 'AgentDesk-0.2.1-arm64.AppImage', 'agentdesk_0.2.1_amd64.deb',
  'AgentDesk.Setup.0.2.1.exe', 'AgentDesk.0.2.1.exe',
].map(name => ({ name, size: 100, browser_download_url: `https://github.com/choiminu/AgentDesk/releases/download/v0.2.1/${name}` }));
const pick = (p, a) => (V.pickAsset(ASSETS, p, a) || {}).name || null;

test('pickAsset: one installer per platform and architecture', () => {
  assert.equal(pick('darwin', 'arm64'), 'AgentDesk-0.2.1-arm64.dmg');
  assert.equal(pick('darwin', 'x64'), 'AgentDesk-0.2.1.dmg');
  assert.equal(pick('linux', 'x64'), 'AgentDesk-0.2.1.AppImage');
  assert.equal(pick('linux', 'arm64'), 'AgentDesk-0.2.1-arm64.AppImage');
  assert.equal(pick('win32', 'x64'), 'AgentDesk.Setup.0.2.1.exe');
  assert.equal(pick('linux', 'ia32'), null);
  assert.equal(pick('freebsd', 'x64'), null);
});

test('pickAsset: no matching asset', () => {
  assert.equal(V.pickAsset([], 'darwin', 'arm64'), null);
  assert.equal(V.pickAsset(null, 'darwin', 'arm64'), null);
  assert.equal(V.pickAsset([{ name: 'AgentDesk-0.2.1-arm64.dmg' }], 'darwin', 'x64'), null);   // Intel never gets the arm64 DMG
  assert.equal(V.pickAsset([{ name: 'AgentDesk-0.2.1.dmg' }], 'darwin', 'arm64'), null);
  assert.equal(V.pickAsset([{ name: 'AgentDesk.0.2.1.exe' }], 'win32', 'x64'), null);           // portable is not the installer
  assert.equal(V.pickAsset([{ name: 'agentdesk_0.2.1_amd64.deb' }], 'linux', 'x64'), null);
  assert.equal(V.pickAsset([{}, { name: 5 }], 'darwin', 'x64'), null);
});

test('download URL allowlist and file name sanitizing', () => {
  assert.equal(V.isAllowedDownloadUrl('https://github.com/choiminu/AgentDesk/releases/download/v0.2.1/a.dmg'), true);
  assert.equal(V.isAllowedDownloadUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(V.isAllowedDownloadUrl('http://github.com/x'), false);
  assert.equal(V.isAllowedDownloadUrl('https://github.com.evil.example/x'), false);
  assert.equal(V.isAllowedDownloadUrl('https://release-assets.githubusercontent.com/x'), false);
  assert.equal(V.isAllowedRedirectUrl('https://release-assets.githubusercontent.com/x'), true);
  assert.equal(V.isAllowedRedirectUrl('https://evil.example/x'), false);
  assert.equal(V.safeAssetFileName('../../etc/AgentDesk.dmg'), 'AgentDesk.dmg');
  assert.equal(V.safeAssetFileName('..\\a\\b.exe'), 'b.exe');
  assert.equal(V.safeAssetFileName('..'), 'AgentDesk-update');
  assert.equal(V.safeAssetFileName('.hidden.dmg'), 'hidden.dmg');
  assert.equal(V.safeAssetFileName('a:b?.dmg'), 'ab.dmg');
});

const HEX = 'ab'.repeat(32);
test('parseDigest: only sha256 with 64 hex digits', () => {
  assert.equal(V.parseDigest(`sha256:${HEX}`), HEX);
  assert.equal(V.parseDigest(`SHA256:${HEX.toUpperCase()}`), HEX);
  for (const bad of [null, undefined, '', HEX, `sha1:${'ab'.repeat(20)}`, `sha256:${HEX.slice(1)}`, `sha256:${'zz'.repeat(32)}`]) assert.equal(V.parseDigest(bad), null, String(bad));
});

const release = (tag, assets = ASSETS) => ({ tag_name: tag, html_url: `https://github.com/choiminu/AgentDesk/releases/tag/${tag}`, assets });
test('downloadPlan: never offers the same or an older release (no downgrade)', () => {
  assert.deepEqual(V.downloadPlan(release('v0.2.1'), '0.2.1', 'darwin', 'arm64'), { upToDate: true, latest: '0.2.1' });
  assert.equal(V.downloadPlan(release('v0.1.3'), '0.2.1', 'darwin', 'arm64').upToDate, true);
  assert.equal(V.downloadPlan(release('v0.2.1-rc.1'), '0.2.1', 'darwin', 'arm64').upToDate, true);
  assert.equal(V.downloadPlan(release('garbage'), '0.2.1', 'darwin', 'arm64').upToDate, true);
  assert.equal(V.downloadPlan(null, '0.2.1', 'darwin', 'arm64').upToDate, true);
});

test('downloadPlan: newer release → asset with its digest, or noAsset', () => {
  const withDigest = ASSETS.map(a => ({ ...a, digest: `sha256:${HEX}` }));
  const p = V.downloadPlan(release('v0.2.2', withDigest), '0.2.1', 'darwin', 'x64');
  assert.equal(p.asset.name, 'AgentDesk-0.2.1.dmg'); assert.equal(p.sha256, HEX); assert.equal(p.latest, '0.2.2');
  assert.equal(V.downloadPlan(release('v0.2.2'), '0.2.1', 'darwin', 'x64').sha256, null);   // no digest → unverified
  assert.deepEqual(V.downloadPlan(release('v0.2.2', []), '0.2.1', 'win32', 'x64'), { noAsset: true, latest: '0.2.2' });
});

test('releaseInfo: cache record keeps only name/size and a github.com page URL', () => {
  const i = V.releaseInfo({ tag_name: 'v0.2.2', name: 'R', html_url: 'https://evil.example/x', assets: [{ name: 'a.dmg', size: 5, browser_download_url: 'https://x' }] }, 7);
  assert.deepEqual(i, { at: 7, latest: '0.2.2', url: V.RELEASES_PAGE, name: 'R', assets: [{ name: 'a.dmg', size: 5 }] });
});

test('main.mjs download path: wx temp file, partial-write check, digest check, abort, confirm dialog', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../main.mjs', import.meta.url), 'utf-8');
  const body = src.slice(src.indexOf('async function downloadUpdateAsset'), src.indexOf('ipcMain.handle("roca:app-version"'));
  assert.match(body, /openSync\(tmp, "wx"/);
  assert.match(body, /written !== value\.length/);
  assert.match(body, /hash\.digest\("hex"\) !== sha256/);
  assert.match(body, /ac\.abort\(/);
  assert.match(body, /if \(plan\.upToDate\) return \{ ok: false, upToDate: true/);
  assert.match(body, /dialog\.showMessageBox/);
  assert.doesNotMatch(body.slice(0, body.indexOf('dialog.showMessageBox')), /shell\.openPath/);   // nothing opens before the user confirms
});
