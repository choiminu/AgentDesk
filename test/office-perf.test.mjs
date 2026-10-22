// widget.html — CPU/GPU with team sharing on: teammates' area drawing (filter cache, floor cache, culling), the office
// frame cap, the team tick's change detection and the remote screen poll interval. Source-level checks like dock.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REMOTE_SCREEN_CACHE_MS } from '../team/remote.mjs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); return src.slice(i, j < 0 ? undefined : j); };

test('office peers: sprites use a cached filtered sheet, never a per-frame ctx.filter', () => {
  const seat = between(html, 'function officeDrawPeerSeat(', '\n}\n');
  assert.doesNotMatch(seat, /ctx\.filter\s*=/, 'no ctx.filter in the per-frame seat draw');
  assert.match(seat, /officePeerSheet\(sheet, off\)/);
  const cache = between(html, 'function officePeerSheet(', '\n}\n');
  assert.match(cache, /officePeerSheetCache\.get\(key\)/);
  assert.match(cache, /if \(!sheet\.complete \|\| !sheet\.naturalWidth\) return null;/, 'built only after the image loaded');
  assert.match(cache, /g\.filter = off \? 'grayscale\(1\) brightness\(0\.85\)' : 'saturate\(0\.5\)'/);
  assert.match(html, /const officePeerSheetCache = new Map\(\);/);
});

test('office peers: the floor is tiled once into a cached canvas, re-tiled only when its signature changes', () => {
  const floor = between(html, 'function officePeerFloor(', '\n}\n');
  assert.match(floor, /if \(!e \|\| e\.sig !== sig\)/);
  assert.match(floor, /officeTileArea\(g, im, 'floor_grid'/, 'tiles go to the offscreen context');
  assert.match(floor, /a\.h\}.*a\.seats\.length\}.*a\.off/, 'size, rows and state are part of the signature');
  const zone = between(html, 'function officeDrawPeerZone(', '\n}\n');
  assert.doesNotMatch(zone, /officeTileArea\(ctx/, 'no per-frame tiling of teammate floors');
  assert.match(zone, /ctx\.drawImage\(officePeerFloor\(im, a, 4, fy, worldW - 8\), 4, fy\)/);
});

test('office peers: areas outside the scrolled viewport are culled before floor and seats', () => {
  const zone = between(html, 'function officeDrawPeerZone(', '\n}\n');
  assert.match(zone, /wrap\.scrollTop \/ scale - M/);
  assert.match(zone, /\(wrap\.scrollTop \+ wrap\.clientHeight\) \/ scale \+ M/);
  const cull = zone.indexOf('if (fy + a.h < viewTop || fy > viewBottom) {');
  assert.ok(cull > 0, 'culling check present');
  assert.ok(cull < zone.indexOf('officePeerFloor(') && cull < zone.indexOf('officeDrawPeerSeat('), 'culling happens before any drawing');
});

test('office loop: frame cap — 31 ms while moving, 100 ms when still, >= 66 ms unfocused, none while hidden', () => {
  const loop = between(html, 'function officeLoop(', '\n}\n');
  assert.match(loop, /let cap = officeMoving \|\| now - officeWakeAt < 400 \? 31 : 100;/);
  assert.match(loop, /if \(officeBlurred\) cap = Math\.max\(cap, 66\);/);
  assert.match(loop, /officeReady && !document\.hidden && now - officeLastDraw >= cap/);
  assert.match(html, /window\.addEventListener\('blur', \(\) => \{ officeBlurred = true; \}\);/);
  const frame = between(html, 'function officeFrame(', '\n}\n');
  assert.match(frame, /officeMoving = /, 'officeFrame decides whether anything moves');
  assert.match(frame, /c\.state !== 'sit'/);
  assert.match(frame, /c\.sess\.status === 'running' \|\| c\.sess\.needsInput/);
  assert.match(frame, /p\.heartT > 0/);
  assert.match(frame, /debateState\.running && debateState\.currentHandle/);
  assert.match(frame, /for \(const c of officeChars\.values\(\)\) \{/, 'a loop, no array copy per frame');
  assert.doesNotMatch(frame, /\[\.\.\.officeChars\.values\(\)\]\.some/);
  assert.match(html, /window\.addEventListener\('resize', \(\) => \{ officeWakeAt = performance\.now\(\); \}\);/);
});

test('team tick: hidden skips the rendering only, skips unchanged status work, still notifies every tick', () => {
  const tick = between(html, 'async function teamPageTick(', '\n}\n');
  assert.match(tick, /notifyPeersTick\(\);[^\n]*\n\s*if \(poll && document\.hidden\) \{ if \(!same\) teamTickDirty = true; return; \}/, 'hidden: alerts still go out, the rendering waits');
  assert.match(tick, /same = poll && !changed && !teamTickDirty/);
  assert.match(tick, /teamTickDirty = false;/);
  assert.match(tick, /if \(!same \|\| Date\.now\(\) - peerConflictCheckAt >= 60000\) \{ peerConflictCheckAt = Date\.now\(\); peerUpdateConflicts\(\); \}/);
  assert.match(tick, /if \(!same\) peerSafetyAlerts\(\);/);
  assert.match(tick, /\n  notifyPeersTick\(\);/, 'notifyPeersTick is not behind the change check');
  assert.match(tick, /if \(!same\) inboxRender\(\);/);
  assert.match(tick, /Date\.now\(\) - teamRenderAt >= 30000/);
  assert.match(html, /setInterval\(\(\) => teamPageTick\(true\), 3000\)/);
  const sig = between(html, 'function teamStatusSig(', '\n}\n');
  assert.match(sig, /TEAM_SIG_SKIP\.has\(k\) \? undefined : v/);
  assert.match(html, /const TEAM_SIG_SKIP = new Set\(\['rtt', 'at', 'checkedAt'/);
});

test('team tick: a change seen while hidden is caught up when shown (dirty flag + visibilitychange)', () => {
  assert.match(html, /teamTickDirty = false, peerConflictCheckAt = 0;/);
  assert.match(html, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) teamPageTick\(\); \}\);/);
});

test('team signature: my sessions\' ended / isSub / handle / report / ticket are signed', () => {
  const local = between(html, 'function teamSigLocal(', '\n}\n');
  for (const f of ['s.ended', 's.isSub', '!!handles.get(s.id)', '(peerReports.get(s.id) || {}).at', "jira.get(s.id) || ''", 's.repo', 's.branch', 's.files'])
    assert.ok(local.includes(f), f);
  assert.match(local, /peerNotes\.map\(n => \[n\.id, n\.state\]\)/);
});

test('team signature (pure): rtt / at changes are the same, an ok change is not', () => {
  const src = html.match(/const TEAM_SIG_SKIP = new Set\([^\n]*\);/)[0] + '\n' + between(html, 'function teamStatusSig(', '\n}\n') + '\n}\nreturn teamStatusSig;';
  const sig = new Function(src)();
  const st = (o = {}) => ({ configured: true, name: 'me', peers: { kim: { name: 'kim', ok: true, rtt: 12, at: 1000, checkedAt: 1000, lastOk: 1000, sessions: [{ id: 'a', status: 'running', report: { text: 'x', at: 5 } }], ...o } } });
  const local = [[['s1', 'n', 'running']], []];
  assert.equal(sig(st(), local), sig(st({ rtt: 99, at: 2000, checkedAt: 2000, lastOk: 2000, nextAt: 5, theirAt: 7 }), local), 'timing-only fields ignored');
  assert.notEqual(sig(st(), local), sig(st({ ok: false }), local), 'ok flip is a change');
  assert.notEqual(sig(st(), local), sig(st({ sessions: [{ id: 'a', status: 'waiting' }] }), local), 'session status is a change');
  assert.notEqual(sig(st(), local), sig(st(), [[['s1', 'n', 'done']], []]), 'my sessions are part of it');
});

test('office peers: culled areas still record their seats (minimap dots, hit-test)', () => {
  const zone = between(html, 'function officeDrawPeerZone(', '\n}\n');
  assert.match(zone, /if \(fy \+ a\.h < viewTop \|\| fy > viewBottom\) \{ for \(const seat of a\.seats\) officePeerSeatMeta\(seat, a\); continue; \}/);
  assert.match(between(html, 'function officeDrawPeerSeat(', '\n}\n'), /officePeerSeatMeta\(seat, area\);/);
  assert.match(between(html, 'function officePeerSeatMeta(', '\n}\n'), /officePeerSeats\.push\(/);
});

test('office peers: floor signature includes the origin and width; caches are pruned', () => {
  assert.match(between(html, 'function officePeerFloor(', '\n}\n'), /const sig = `\$\{x0\},\$\{y0\},\$\{w\},/);
  assert.match(between(html, 'function officeDrawPeerZone(', '\n}\n'), /if \(!zone\.areas\.some\(a => a\.peer\.name === k\)\) officePeerFloorCache\.delete\(k\);/);
  assert.match(html, /officeDrawPeerZone\(ctx, im, peerZone[^\n]*\n\s*else officePeerFloorCache\.clear\(\);/);
});

test('remote screen: input / interrupt drop the cached screen; the client reads again quickly once', () => {
  const peer = readFileSync(new URL('../team/peer.mjs', import.meta.url), 'utf8');
  assert.equal((peer.match(/if \(r && r\.ok\) screenReads\.delete\(sid\);/g) || []).length, 2);
  assert.equal((html.match(/st\.delay = PEER_TERM_MS; st\.fastOnce = true;/g) || []).length, 2);
  assert.match(html, /st\.delay = r\.status === 'running' \|\| st\.fastOnce \? PEER_TERM_MS : PEER_TERM_IDLE_MS; st\.fastOnce = false;/);
});

test('teamRender: innerHTML is assigned only when the markup changed', () => {
  const r = between(html, 'function teamRender(', '\n}\n');
  assert.doesNotMatch(r, /(bar|list)\.innerHTML\s*\+?=\s*`/, 'no direct template assignment');
  assert.match(r, /if \(force \|\| bar\.__html !== h\)/);
  assert.match(r, /if \(force \|\| list\.__html !== h\)/);
});

test('remote screen: server cache 2 s, client poll 1.5 s while running and 3 s otherwise', () => {
  assert.equal(REMOTE_SCREEN_CACHE_MS, 2000);
  assert.match(html, /const PEER_TERM_MS = 1500, PEER_TERM_IDLE_MS = 3000,/);
  assert.match(between(html, 'async function peerTermPoll(', '\n}\n'), /st\.delay = r\.status === 'running' \|\| st\.fastOnce \? PEER_TERM_MS : PEER_TERM_IDLE_MS;/);
});
