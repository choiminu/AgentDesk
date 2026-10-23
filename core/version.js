// AgentDesk core: release version comparison and installer selection for the update check / download (main.mjs).
// Pure functions only — no DOM, no Electron, no network.
//
//   parseVersion("v0.2.1-beta.3")       → { major, minor, patch, pre: ['beta', 3] } | null
//   isNewer(latest, current)            → true when latest > current (semver precedence; build metadata ignored)
//   pickAsset(assets, platform, arch, format) → the release asset that installs on this machine, or null
//                                         (format: Linux 'appimage' | 'deb', from linuxFormat(); other platforms ignore it)
//   linuxFormat(env, packaged)          → 'appimage' when running from an AppImage, 'deb' for an installed package
//   markDownloadedPlan(platform)        → 'quarantine' | 'zone' | null — how [받기] marks a downloaded installer
//   installerSigned(platform, signed)   → true when this build is signed for this OS (the confirm dialog says so)
//   isAllowedDownloadUrl(url)           → the initial download URL is a GitHub release URL
//   isAllowedRedirectUrl(url)           → a redirect hop stays on GitHub's release storage hosts
//   safeAssetFileName(name)             → the asset name with path characters removed (a bare file name)
//   parseDigest("sha256:<hex>")         → lowercase hex, or null for a missing / other-algorithm digest
//   releaseInfo(json, now)              → { at, latest, url, name, assets: [{ name, size }] } for the update cache
//   downloadPlan(json, current, p, a, format) → { upToDate } | { noAsset } | { asset, sha256 } — what [받기] may do
(function (root) {
'use strict';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map(id => /^\d+$/.test(id) ? Number(id) : id) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

// semver §11: numeric identifiers compare numerically and sort before alphanumeric ones; a longer list wins a tie
function comparePre(a, b) {
  if (!a.length || !b.length) return a.length === b.length ? 0 : (a.length ? -1 : 1);   // no prerelease > prerelease
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i], y = b[i];
    if (x === y) continue;
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) return x < y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

// electron-builder names (GitHub turns spaces into dots): AgentDesk-<v>-arm64.dmg, AgentDesk-<v>.dmg (Intel),
// AgentDesk-<v>.AppImage (x64), AgentDesk-<v>-arm64.AppImage, agentdesk_<v>_amd64.deb, agentdesk_<v>_arm64.deb,
// AgentDesk.Setup.<v>.exe (NSIS), AgentDesk.<v>.exe (portable)
const ARM_RE = /(^|[-_.])(arm64|aarch64)([-_.]|$)/i;
function pickAsset(assets, platform, arch, format) {
  const list = (Array.isArray(assets) ? assets : []).filter(a => a && typeof a.name === 'string' && a.name);
  const ends = ext => a => a.name.toLowerCase().endsWith(ext);
  const isArm = a => ARM_RE.test(a.name);
  const wantArm = arch === 'arm64';
  let found;
  if (platform === 'darwin') found = list.filter(ends('.dmg')).find(a => isArm(a) === wantArm);
  else if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') return null;
    // a deb install updates with a deb (the package manager keeps owning the files); an AppImage — or no deb in the
    // release — with an AppImage
    if (format === 'deb') found = list.filter(ends('.deb')).find(a => isArm(a) === wantArm);
    if (!found) found = list.filter(ends('.appimage')).find(a => isArm(a) === wantArm);
  } else if (platform === 'win32') found = list.filter(ends('.exe')).find(a => /setup/i.test(a.name));
  return found || null;
}

// electron-builder's AppImage runtime sets APPIMAGE to the image's path; a packaged app without it was installed
// from the deb (the only other Linux target). A dev run (not packaged) is treated as an AppImage user.
function linuxFormat(env, packaged) {
  if (env && typeof env.APPIMAGE === 'string' && env.APPIMAGE) return 'appimage';
  return packaged ? 'deb' : 'appimage';
}

// every downloaded installer is marked like a browser download, signed build or not, so Gatekeeper / SmartScreen
// always check the file themselves (one more layer on top of the sha256 check)
function markDownloadedPlan(platform) {
  if (platform === 'darwin') return 'quarantine';
  if (platform === 'win32') return 'zone';
  return null;
}
// signed: the build flag CI injects (package.json agentdeskSigned = 'mac' | 'win') into a Developer ID signed +
// notarized (macOS) / Authenticode signed (Windows) build. Only used for a line in the confirm dialog: the release
// comes from the same pipeline, so its installer is signed the same way.
function installerSigned(platform, signed) {
  return (platform === 'darwin' && signed === 'mac') || (platform === 'win32' && signed === 'win');
}

const isAllowedDownloadUrl = url => /^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(String(url || ''));
// GitHub answers a release download with a redirect to its storage host (objects.* earlier, release-assets.* since 2025)
const isAllowedRedirectUrl = url => /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(String(url || ''));

function safeAssetFileName(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  return base.slice(0, 200) || 'AgentDesk-update';
}

// GitHub's release API lists `digest: "sha256:<64 hex>"` per asset (assets uploaded since mid-2025)
function parseDigest(d) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(d == null ? '' : d).trim());
  return m ? m[1].toLowerCase() : null;
}

const RELEASES_PAGE = 'https://github.com/choiminu/AgentDesk/releases';
function releaseInfo(j, now) {
  j = j || {};
  const assets = (Array.isArray(j.assets) ? j.assets : []).map(a => ({ name: String((a && a.name) || ''), size: Number(a && a.size) || 0 }));
  const url = /^https:\/\/github\.com\//.test(String(j.html_url || '')) ? j.html_url : RELEASES_PAGE;
  return { at: now, latest: String(j.tag_name || '').replace(/^v/, ''), url, name: String(j.name || ''), assets };
}

// never offers a release that is not newer than the running app (no downgrade through [받기])
function downloadPlan(j, current, platform, arch, format) {
  const latest = String((j && j.tag_name) || '').replace(/^v/, '');
  if (!isNewer(latest, current)) return { upToDate: true, latest };
  const asset = pickAsset(j.assets, platform, arch, format);
  if (!asset) return { noAsset: true, latest };
  return { asset, latest, sha256: parseDigest(asset.digest) };
}

const AgentDeskVersion = { parseVersion, compareVersions, isNewer, pickAsset, linuxFormat, markDownloadedPlan, installerSigned, isAllowedDownloadUrl, isAllowedRedirectUrl, safeAssetFileName, parseDigest, releaseInfo, downloadPlan, RELEASES_PAGE };
root.AgentDeskVersion = AgentDeskVersion;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskVersion;
else Object.assign(root, AgentDeskVersion);
})(typeof globalThis !== 'undefined' ? globalThis : this);
