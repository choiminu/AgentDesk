// core/dock.js — dock mode: tile states, review-queue badges, shrink / "+N" pile rules, window bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
await import('../core/mask.js');   // AgentDeskMask.ANSI_RE / maskRows, as the renderer loads it first
await import('../core/dock.js');
const D = globalThis.AgentDeskDock;
const { dockModel, dockBounds, stateOf, tilesWidth, TILE } = D;

const sess = (id, status, extra) => ({ id, name: `s-${id}`, status, handle: true, ...extra });
const keys = list => list.map(x => x.key);

test('stateOf: status words → tile state, approval first', () => {
  assert.equal(stateOf({ status: 'running' }), 'run');
  assert.equal(stateOf({ status: 'waiting' }), 'input');
  assert.equal(stateOf({ status: 'error' }), 'err');
  assert.equal(stateOf({ status: 'done' }), 'done');
  assert.equal(stateOf({ status: 'running', needsInput: true }), 'ask');
  assert.equal(stateOf({ status: 'waiting', needsInput: true }), 'ask');
  assert.equal(stateOf({ status: 'done', needsInput: true }), 'done', 'a finished session no longer asks');
  assert.equal(stateOf({ status: 'error', needsInput: true }), 'err');
  assert.equal(stateOf({ status: 'error', hasPerm: true }), 'ask', 'a pending permission request wins');
  assert.equal(stateOf({ status: 'weird' }), 'done');
  assert.equal(stateOf(null), 'done');
});

test('dockModel: empty / junk input', () => {
  for (const input of [undefined, null, {}, { sessions: null, peers: 'x', inbox: 5 }]) {
    const m = dockModel(input);
    assert.equal(m.size, TILE.big);
    assert.deepEqual(m.mine, []); assert.deepEqual(m.peers, []);
    assert.equal(m.selected, null); assert.equal(m.total, 0); assert.equal(m.hidden, 0);
  }
  const m = dockModel({ sessions: [null, {}, { id: '' }, sess('a', 'running'), sess('a', 'done')] });
  assert.deepEqual(keys(m.mine), ['me:a'], 'entries without id dropped, duplicate ids once');
  assert.equal(m.mine[0].state, 'run');
});

test('dockModel: canInput only for a waiting session with a terminal handle', () => {
  const m = dockModel({ sessions: [sess('a', 'waiting'), sess('b', 'waiting', { handle: false }), sess('c', 'running'), sess('d', 'waiting', { needsInput: true })] });
  assert.deepEqual(m.mine.map(x => x.canInput), [true, false, false, false]);
});

test('dockModel: badges count review-queue items per session (mine and teammates)', () => {
  const inbox = [
    { kind: 'perm', target: { page: 'dashboard', sessionId: 'a', permId: 'p1' } },
    { kind: 'perm', target: { page: 'dashboard', sessionId: 'a', permId: 'p2' } },
    { kind: 'stuck', target: { page: 'dashboard', sessionId: 'b' } },
    { kind: 'perm-orphan', target: { page: 'dashboard', sessionId: '', permId: 'p3' } },   // no session: no tile
    { kind: 'usage', target: { page: 'dashboard' } },
    { kind: 'peer-ask', target: { page: 'team', peer: 'kim', sessionId: 'x' } },
    { kind: 'note', target: { page: 'team', peer: 'kim' } },                               // no session id: no tile
    null, { target: null },
  ];
  const m = dockModel({ sessions: [sess('a', 'running'), sess('b', 'running'), sess('c', 'done')], peers: [{ peer: 'kim', id: 'x', name: 'k', status: 'waiting' }], inbox });
  assert.deepEqual(m.mine.map(x => x.badge), [2, 1, 0]);
  assert.equal(m.peers[0].badge, 1);
  assert.equal(m.peers[0].key, 'peer:kim/x');
});

test('dockModel: subagents become a count, teammates keep only known status words', () => {
  const m = dockModel({
    sessions: [sess('a', 'running', { subs: [{}, {}, {}] }), sess('b', 'running', { subs: 2 }), sess('c', 'running', { subs: 'x' })],
    peers: [{ peer: 'kim', id: 'x', status: '<img src=x>', needsInput: 'yes' }, { peer: 'kim', id: 'y', status: 'running', needsInput: true, delegated: true }, { peer: 'lee', id: 'z', status: 'running', ended: true }],
  });
  assert.deepEqual(m.mine.map(x => x.subs), [3, 2, 0]);
  assert.deepEqual(m.peers.map(x => [x.key, x.state, x.delegated]), [['peer:kim/x', 'done', false], ['peer:kim/y', 'ask', true]]);
  const long = dockModel({ peers: [{ peer: 'p'.repeat(60), id: 'x', status: 'running', subs: 2 }] }).peers[0];
  assert.equal(long.peer, 'p'.repeat(60), 'the owner id stays exact for lookups'); assert.ok([...long.owner].length <= 40); assert.equal(long.subs, 2);
  assert.ok(m.peers.every(x => D.STATES.includes(x.state)));
});

test('dockModel: names are cut and cleaned (bidi / control characters)', () => {
  const m = dockModel({ sessions: [{ id: 'a', name: '‮evil\u0007 ' + 'x'.repeat(100), status: 'running' }] });
  assert.ok(!/[‮\u0007]/.test(m.mine[0].name));
  assert.ok([...m.mine[0].name].length <= 40);
  assert.equal(m.mine[0].id, 'a', 'ids stay exact');
});

test('dockModel: 56 px (name beneath) when everything fits, 40 px when only that fits', () => {
  assert.equal(TILE.big, 56); assert.equal(TILE.small, 40);
  const four = ['a', 'b', 'c', 'd'].map(id => sess(id, 'running'));
  const w56 = 4 * 56 + 3 * TILE.gap, w40 = 4 * 40 + 3 * TILE.gap;
  assert.equal(dockModel({ sessions: four, width: w56 }).size, 56);
  const m = dockModel({ sessions: four, width: w56 - 1 });
  assert.equal(m.size, 40); assert.equal(m.mine.length, 4); assert.equal(m.hidden, 0);
  assert.equal(dockModel({ sessions: four, width: w40 }).mine.length, 4);
  assert.equal(dockModel({ sessions: four }).size, 56, 'no width = no limit');
  assert.equal(tilesWidth(dockModel({ sessions: four })), w56);
});

test('dockModel: overflow folds into a "+N" pile, keeping urgent and selected tiles in order', () => {
  const list = [sess('a', 'done'), sess('b', 'running'), sess('c', 'done'), sess('d', 'waiting', { needsInput: true }), sess('e', 'error'), sess('f', 'done')];
  const width = 3 * 40 + 2 * TILE.gap;   // three slots: two tiles + the pile
  const m = dockModel({ sessions: list, width, selectedId: 'me:f' });
  assert.equal(m.size, 40);
  assert.equal(m.mine.length, 3);
  const pile = m.mine[2];
  assert.equal(pile.bundle, true); assert.equal(pile.key, 'more:me'); assert.equal(pile.count, 4);
  assert.deepEqual(keys(m.mine.slice(0, 2)), ['me:d', 'me:f'], 'selected kept, then the most urgent (ask), original order');
  assert.equal(pile.state, 'err', 'the pile shows the most urgent state it holds');
  assert.equal(m.hidden, 4);
  assert.equal(m.selected.key, 'me:f');
  assert.ok(tilesWidth(m) <= width);
});

test('dockModel: pile badge sums the folded tiles; maxTiles caps the count', () => {
  const list = ['a', 'b', 'c', 'd'].map(id => sess(id, 'running'));
  const inbox = list.map(s => ({ target: { page: 'dashboard', sessionId: s.id } }));
  const m = dockModel({ sessions: list, inbox, maxTiles: 2 });
  assert.equal(m.mine.length, 2);
  assert.equal(m.mine[1].bundle, true); assert.equal(m.mine[1].count, 3); assert.equal(m.mine[1].badge, 3);
});

test('dockModel: zero room → no tiles at all (the right-hand buttons keep their width)', () => {
  const m = dockModel({ sessions: [sess('a', 'running'), sess('b', 'running')], width: 0 });
  assert.deepEqual(m.mine, []); assert.equal(m.hidden, 2);
  const one = dockModel({ sessions: [sess('a', 'running'), sess('b', 'running')], width: 40 });
  assert.equal(one.mine.length, 1); assert.equal(one.mine[0].bundle, true); assert.equal(one.mine[0].count, 2);
});

test('dockModel: teammates at most 8 tiles + "+N", delegated ones first', () => {
  const peers = Array.from({ length: 12 }, (_, k) => ({ peer: 'kim', id: `p${k}`, status: 'done', delegated: k === 11 }));
  const m = dockModel({ sessions: [sess('a', 'running')], peers });
  assert.equal(m.peers.length, 9);
  assert.ok(m.peers.some(x => x.key === 'peer:kim/p11'), 'the delegated session stays visible');
  const pile = m.peers[8];
  assert.equal(pile.bundle, true); assert.equal(pile.key, 'more:peer'); assert.equal(pile.count, 4);
  assert.equal(m.hidden, 4);
});

test('dockModel: when tight, teammates get about a third of the slots; mine leave room over', () => {
  const mine = Array.from({ length: 10 }, (_, k) => sess(`m${k}`, 'running'));
  const peers = Array.from({ length: 6 }, (_, k) => ({ peer: 'kim', id: `p${k}`, status: 'running' }));
  const slots = 6, width = slots * 40 + (slots - 1) * TILE.gap + TILE.sep + TILE.gap;
  const m = dockModel({ sessions: mine, peers, width });
  assert.equal(m.mine.length + m.peers.length, slots);
  assert.equal(m.peers.length, 2); assert.equal(m.peers[1].bundle, true); assert.equal(m.peers[1].count, 5);
  assert.equal(m.mine[m.mine.length - 1].bundle, true);
  // few of mine: teammates take the rest
  const m2 = dockModel({ sessions: mine.slice(0, 1), peers, width });
  assert.equal(m2.mine.length, 1); assert.equal(m2.peers.length, 5); assert.equal(m2.peers[4].count, 2);
  // no sessions of mine: no separator, all slots for teammates
  const m3 = dockModel({ peers, width: 6 * 40 + 5 * TILE.gap });
  assert.equal(m3.peers.length, 6); assert.equal(m3.size, 40);
});

test('dockModel: one slot left with both groups → my "+N" pile only, no teammate group', () => {
  const mine = ['a', 'b', 'c'].map(id => sess(id, 'running'));
  const peers = [{ peer: 'kim', id: 'x', status: 'running' }];
  const m = dockModel({ sessions: mine, peers, width: 51 });
  assert.deepEqual(keys(m.mine), ['more:me']); assert.equal(m.mine[0].count, 3);
  assert.deepEqual(m.peers, []);
  assert.ok(tilesWidth(m) <= 51);
  const two = dockModel({ sessions: mine, peers, width: 2 * 40 + TILE.gap + TILE.sep + TILE.gap });
  assert.equal(two.mine.length, 1); assert.equal(two.peers.length, 1, 'two slots: one each');
  assert.ok(tilesWidth(two) <= 2 * 40 + TILE.gap + TILE.sep + TILE.gap);
});

test('dockModel: selected tile reported even when it is a teammate; unknown selection → null', () => {
  const m = dockModel({ sessions: [sess('a', 'running')], peers: [{ peer: 'kim', id: 'x', status: 'running' }], selectedId: 'peer:kim/x' });
  assert.equal(m.selected.key, 'peer:kim/x'); assert.equal(m.peers[0].selected, true); assert.equal(m.mine[0].selected, false);
  assert.equal(dockModel({ sessions: [sess('a', 'running')], selectedId: 'me:gone' }).selected, null);
});

const WA = { x: 0, y: 25, width: 1440, height: 875 };   // a laptop work area under a 25 px menu bar

test('dockBounds: bottom centre of the work area, width and height clamped', () => {
  const b = dockBounds({ workArea: WA, contentWidth: 800, height: 72 });
  assert.deepEqual(b, { x: 320, y: 25 + 875 - 72 - D.MARGIN, width: 800, height: 72, stripX: 0, stripWidth: 800, stripY: 25 + 875 - 72 - D.MARGIN, stripHeight: 72, extra: 0, dir: 'up', workWidth: 1440 });
  assert.equal(dockBounds({ workArea: WA, contentWidth: 100 }).width, 320, 'at least 320');
  assert.equal(dockBounds({ workArea: WA, contentWidth: 5000 }).width, Math.floor(1440 * 0.9), 'at most 90 % of the work area');
  assert.equal(dockBounds({ workArea: WA, contentWidth: 800, height: 20 }).stripHeight, 64);
  assert.equal(dockBounds({ workArea: WA, contentWidth: 800, height: 200 }).stripHeight, 76);
  assert.equal(dockBounds({ workArea: WA }).stripHeight, 72);
});

test('dockBounds: never outside the work area (narrow screens, remembered spot clamped)', () => {
  const narrow = dockBounds({ workArea: { x: 0, y: 0, width: 300, height: 500 }, contentWidth: 800 });
  assert.equal(narrow.width, 300); assert.equal(narrow.x, 0);
  const r = dockBounds({ workArea: WA, contentWidth: 800, remembered: { cx: 1430, y: 890 } });   // dragged to the corner
  assert.equal(r.x + r.width, 1440); assert.ok(r.stripY + r.stripHeight <= 25 + 875);
  const top = dockBounds({ workArea: WA, contentWidth: 800, remembered: { cx: 700, y: 30 } });
  assert.equal(top.stripY, 30); assert.equal(top.x, 300);
  for (const b of [narrow, r, top]) {
    assert.ok(b.x >= 0 && b.y >= 0);
  }
});

test('dockBounds: multi-monitor coordinates; a spot remembered on another display is ignored', () => {
  const second = { x: 1440, y: -200, width: 1920, height: 1040 };   // to the right, higher up
  const b = dockBounds({ workArea: second, contentWidth: 1000 });
  assert.equal(b.x, 1440 + 460); assert.equal(b.stripY, -200 + 1040 - 72 - D.MARGIN);
  const fromFirst = dockBounds({ workArea: second, contentWidth: 1000, remembered: { cx: 700, y: 800 } });
  assert.deepEqual(fromFirst, b, 'remembered point on the first display → default place on this one');
  const onIt = dockBounds({ workArea: second, contentWidth: 1000, remembered: { cx: 2000, y: 0 } });
  assert.equal(onIt.x, 1500); assert.equal(onIt.stripY, 0);
  const left = dockBounds({ workArea: { x: -1280, y: 0, width: 1280, height: 800 }, contentWidth: 600 });
  assert.equal(left.x, -1280 + 340); assert.ok(left.x >= -1280 && left.x + left.width <= 0);
});

test('dockBounds: extra room above the bar grows the window upward, not past the top', () => {
  const b = dockBounds({ workArea: WA, contentWidth: 800, extra: 300 });
  assert.equal(b.stripY, 25 + 875 - 72 - D.MARGIN); assert.equal(b.extra, 300);
  assert.equal(b.y, b.stripY - 300); assert.equal(b.height, 372);
  assert.equal(b.dir, 'up');
  assert.equal(dockBounds({ workArea: WA, contentWidth: 800, extra: -5 }).extra, 0);
});

test('dockBounds: a bar near the top opens its room downward (never a negative height)', () => {
  const nearTop = dockBounds({ workArea: WA, contentWidth: 800, extra: 300, remembered: { cx: 700, y: 100 } });
  assert.equal(nearTop.dir, 'down'); assert.equal(nearTop.extra, 300);
  assert.equal(nearTop.y, 100, 'the bar stays where it is; the window grows below it'); assert.equal(nearTop.height, 372);
  const atTop = dockBounds({ workArea: WA, contentWidth: 800, extra: 360, remembered: { cx: 700, y: 25 } });
  assert.equal(atTop.dir, 'down'); assert.equal(atTop.y, 25); assert.equal(atTop.extra, 360);
  // a short work area: the roomier side, cut to what is there
  const short = dockBounds({ workArea: { x: 0, y: 0, width: 1000, height: 300 }, contentWidth: 600, extra: 360, remembered: { cx: 500, y: 100 } });
  assert.equal(short.dir, 'down'); assert.equal(short.extra, 300 - 100 - 72);
  for (const b of [nearTop, atTop, short]) { assert.ok(b.extra >= 0 && b.height > 0); assert.ok(b.y >= 0 && b.y + b.height <= (b === short ? 300 : 900)); }
});

test('permAllowable: [허용] in the bar only for a one-line Bash command or short request, never a file edit', () => {
  const P = D.permAllowable;
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: 'npm test' }), true);
  assert.equal(P({ tool: 'WebFetch', kind: 'json', text: '{"url":"https://example.com"}' }), true);
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: 'x'.repeat(80) }), true);
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: 'x'.repeat(81) }), false, 'longer than the line');
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: 'echo a\necho b' }), false, 'several lines');
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: 'ls', truncated: true }), false, 'cut by the hook');
  assert.equal(P({ tool: 'Bash', kind: 'bash', command: '   ' }), false, 'nothing to read');
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(P({ tool, kind: 'edit', filePath: 'a.js', added: 1, removed: 0 }), false, tool);
    assert.equal(P({ tool, kind: 'json', text: 'a.js' }), false, `${tool} as json`);
  }
  assert.equal(P({ tool: 'X', kind: 'other', text: 'hi' }), false, 'unknown kinds');
  assert.equal(P(null), false); assert.equal(P({}), false);
});

// ── source checks: main.mjs window handling and the renderer's use of the permission panel's rules ──
const root = new URL('..', import.meta.url);
const main = readFileSync(new URL('main.mjs', root), 'utf-8');
const html = readFileSync(new URL('widget.html', root), 'utf-8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); return src.slice(i, j < 0 ? undefined : j); };

test('main orca:dock: on keeps the panel bounds and unlocks the width; off restores them in finally', () => {
  const h = between(main, 'ipcMain.handle("orca:dock"', '\n});');
  const on = h.slice(h.indexOf('if (!dockState) {\n    dockState = {'));
  assert.match(on, /panel: mainWindow\.getBounds\(\)/); assert.match(on, /setResizable\(false\)/);
  const off = between(h, 'if (!r.on) {', 'return { x, y, width: w, height: h };');
  const fin = off.slice(off.indexOf('} finally {'));
  assert.ok(off.includes('} finally {'), 'restore is in finally');
  for (const re of [/setResizable\(true\)/, /setMinimumSize\(Math\.min\(280, w\)/, /setMaximumSize\(Math\.max\(480, w\)/, /setBounds\(\{ x, y, width: w, height: h \}\)/]) assert.match(fin, re);
  assert.match(off, /setIgnoreMouseEvents\(false\)/);
  const apply = between(main, 'function dockApply(', '\n}\n');
  assert.match(apply, /setMaximumSize\(Math\.max\(480, wa\.width\)/, 'the bar may be as wide as the work area');
  assert.match(apply, /AgentDeskDock\.dockBounds\(/);
});

test('main: resize-window ignored while docked, saveBounds keeps the panel bounds, displays re-place the bar', () => {
  assert.match(between(main, 'ipcMain.on("orca:resize-window"', 'const [curW'), /if \(!mainWindow \|\| dockState\) return;/);
  assert.match(between(main, 'function saveBounds()', '\n}'), /dockState \? dockState\.panel : mainWindow\.getBounds\(\)/);
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) assert.ok(main.includes(`"${ev}"`), ev);
  assert.match(between(main, 'function dockReflow()', '\n}\n'), /dockApply\(dockState\.req\)/);
});

test('widget dock permission line: whitelist from core, arming and answers through the panel\'s own functions', () => {
  const f = between(html, 'function dockPermLine(r)', '\nfunction ');
  assert.match(between(html, 'function dockPermShow(r)', '\n}\n'), /const el = dockPermLine\(r\);/);
  assert.match(f, /AgentDeskDock\.permAllowable\(sm\)/);
  assert.match(f, /dataset\.truncated = cut \? '1' : '0'/);
  assert.match(f, /permArm\(el\)/);
  assert.match(f, /permDecide\(r\.id, b\.dataset\.perm, '', el\)/);
  assert.match(f, /inboxGo\(\{ kind: 'perm'/, '[패널에서 보기] goes to the request in the panel');
  assert.doesNotMatch(f, /window\.orca\.perm/, 'no permission IPC of its own');
  // permArm keeps [허용] off while data-truncated is 1 (the dock relies on it)
  assert.match(between(html, 'function permArm(el)', '\n}'), /b\.dataset\.perm === 'allow' && el\.dataset\.truncated === '1'/);
  // error toasts reach the bar's message pill; the rest stay out of the bar (the tiles' states tell them)
  assert.match(between(html, 'function showInAppToast(', '\n}'), /if \(typeof dockOn !== 'undefined' && dockOn && el\.classList\.contains\('err'\)\) dockHint\(el\.textContent, 'err', true\);/);
  assert.doesNotMatch(html, /dockClickT/);
});

test('dockBounds: missing / empty work area → null; junk numbers fall back', () => {
  assert.equal(dockBounds({}), null);
  assert.equal(dockBounds({ workArea: { x: 0, y: 0, width: 0, height: 800 } }), null);
  assert.equal(dockBounds(null), null);
  const b = dockBounds({ workArea: WA, contentWidth: 'abc', height: NaN, remembered: { cx: 'x', y: null } });
  assert.equal(b.width, 320); assert.equal(b.stripHeight, 72); assert.equal(b.x, 560);
});

// ── terminal window (opened by a hover) / compact card: sizes, window growth, placement ──
const { popWidth, popExtra, popRect, screenLines, POP } = D;

test('popWidth / popExtra: terminal window min(720, 90 %), compact card as before; nothing else has a size', () => {
  assert.equal(popWidth('term', 1440), 720);
  assert.equal(popWidth('term', 700), 630, '90 % of the work area');
  assert.equal(popWidth('term', 320), 288);
  assert.equal(popWidth('tipSmall', 1440), 260);
  assert.equal(popWidth('tipSmall', 200), 188, 'cut to the work area (6 px margins)');
  assert.equal(popWidth('inbox', 1440), 0); assert.equal(popWidth('tip', 1440), 0, 'the old history panel is gone'); assert.equal(popWidth('term', 'x'), 0);
  assert.equal(popExtra('tip'), 0);
  assert.equal(popExtra('term'), POP.termH + 2 * POP.gap); assert.equal(POP.termH, 420);
  assert.equal(popExtra('tipSmall'), 132, 'the compact card keeps the old room');
  assert.equal(popExtra(''), 0); assert.equal(popExtra('inbox'), 0);
});

test('dockBounds: a panel wider than the bar grows the window sideways around it; the bar does not move', () => {
  const bar = dockBounds({ workArea: WA, contentWidth: 400 });
  const b = dockBounds({ workArea: WA, contentWidth: 400, extra: popExtra('term'), popWidth: 720 });
  assert.equal(b.width, 720 + 2 * D.MARGIN); assert.equal(b.stripWidth, 400);
  assert.equal(b.x + b.stripX, bar.x, 'the bar keeps its screen x'); assert.equal(b.stripY, bar.stripY);
  assert.equal(b.extra, 432); assert.equal(b.workWidth, 1440);
  // near the right edge: the window is clamped into the work area, the bar stays where it was
  const r = dockBounds({ workArea: WA, contentWidth: 400, extra: 332, popWidth: 420, remembered: { cx: 1430, y: 700 } });
  const r0 = dockBounds({ workArea: WA, contentWidth: 400, remembered: { cx: 1430, y: 700 } });
  assert.equal(r.x + r.width, 1440); assert.equal(r.x + r.stripX, r0.x); assert.ok(r.stripX > 0);
  // narrower than the bar, no room, or a tiny work area: no change / never wider than the work area
  assert.equal(dockBounds({ workArea: WA, contentWidth: 800, extra: 332, popWidth: 420 }).width, 800);
  assert.equal(dockBounds({ workArea: WA, contentWidth: 400, extra: 0, popWidth: 720 }).width, 400);
  const tiny = dockBounds({ workArea: { x: 0, y: 0, width: 320, height: 800 }, contentWidth: 320, extra: 432, popWidth: 720 });
  assert.equal(tiny.width, 320); assert.equal(tiny.stripX, 0);
});

test('popRect: centred on the anchor, clamped inside the window, above or below the bar, cut to the room', () => {
  assert.deepEqual(popRect({ winWidth: 1000, width: 420, anchor: 500, dir: 'up', stripHeight: 72, height: 320, room: 332 }),
    { x: 290, width: 420, height: 320, top: null, bottom: 78 });
  assert.equal(popRect({ winWidth: 1000, width: 420, anchor: 20 }).x, 6, 'left edge');
  assert.equal(popRect({ winWidth: 1000, width: 420, anchor: 990 }).x, 1000 - 6 - 420, 'right edge');
  const d = popRect({ winWidth: 320, width: 720, anchor: 100, dir: 'down', stripHeight: 72, height: 420, room: 200 });
  assert.equal(d.width, 308); assert.equal(d.x, 6); assert.equal(d.top, 78); assert.equal(d.bottom, null); assert.equal(d.height, 188);
  for (const [w, a] of [[1440, 0], [1440, 1440], [320, 160], [900, -50]]) {
    for (const width of [300, 420, 720]) { const g = popRect({ winWidth: w, width, anchor: a }); assert.ok(g.x >= 6 && g.x + g.width <= w - 6, `${w}/${a}/${width}`); }
  }
  const j = popRect(null); assert.equal(j.width, 0); assert.equal(j.height, 0);
});

test('screenLines: ANSI / format characters gone, masked row by row, control characters blanked, 200 lines / 24 KB', () => {
  assert.deepEqual(screenLines(['\u001b[38:5:1mx\u001b[0m', '\u009b1my', 'a\u001bPq#0\u001b\\b']), ['x', 'y', 'ab'], 'the shared ANSI_RE (":" CSI, 8-bit CSI, DCS)');
  assert.deepEqual(screenLines(['\u001b[31mred\u001b[0m  ', 'a\tb\u0007c', 'x​y', '\u001b]0;title\u0007ok']), ['red', 'a b c', 'xy', 'ok']);
  const masked = screenLines(['token=abcd1234efgh', 'plain'], { mask: rows => rows.map(r => r.replace(/token=\S+/, 'token=[MASKED]')) });
  assert.deepEqual(masked, ['token=[MASKED]', 'plain']);
  assert.deepEqual(screenLines(['a', 'b'], { mask: () => ['only one'] }), [], 'a masker that does not answer row for row: nothing shown');
  assert.deepEqual(screenLines(['a'], { mask: () => null }), []);
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const out = screenLines(many); assert.equal(out.length, 200); assert.equal(out[199], 'line 499', 'the newest lines are kept');
  const wide = Array.from({ length: 200 }, () => '가'.repeat(400));   // 1200 bytes a line
  const cut = screenLines(wide); assert.ok(cut.length < 200);
  assert.ok(cut.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0) <= 24 * 1024);
  assert.equal(screenLines(['x'.repeat(1000)])[0].length, 400);
  assert.deepEqual(screenLines(null), []); assert.deepEqual(screenLines([null, 5]), ['', '5']);
});

test('widget dock: hover opens the terminal window, a click goes to the terminal — data, masking, shared view, keys', () => {
  const read = between(html, 'async function dockScreenRead(', '\n}\n');
  assert.match(read, /window\.orca\.terminalRead\(h, true\)/);
  assert.match(read, /AgentDeskDock\.screenLines\(extractTail\(res\), \{ mask: rows => AgentDeskMask\.maskRows\(rows\) \}\)/, 'the remote view\'s row masking');
  assert.match(read, /Date\.now\(\) - c\.at < DOCK_SCREEN_MS/, 'one read per handle per second');
  const tip = between(html, 'function dockTipHtml(', '\n}\n');
  assert.ok(tip.includes("${esc(x.peer ? `@${x.owner} / ${x.name}` : x.name)}"), 'the session name through esc()');
  assert.ok(tip.includes('${esc(clean(now, 120))}') && tip.includes('${esc(clean(msg, 200))}'), 'the card: 지금 하는 일 / the last answer masked, cut, escaped');
  // hover: the terminal window (setting on, a session with a terminal / delegated to me), else the card
  const hover = between(html, 'function dockHover(key)', '\nfunction dockHoverLeave');
  assert.match(hover, /if \(open && dockTyping\(\)\) return;/, 'typing in a window: another tile does not switch it');
  assert.match(hover, /if \(!dockCfg\.hoverTerm \|\| !dockTermable\(x\)\) \{[\s\S]*dockTipShow\(key\)/);
  assert.match(hover, /dockTermFor\(y\); dockHoverOpened = !!dockTermBg\(\);\n\s*\}, open \? 80 : DOCK_HOVER_MS\)/);
  assert.match(html, /const DOCK_HOVER_MS = 200, DOCK_LEAVE_MS = 300;/);
  assert.match(between(html, 'function dockTermFor(x)', '\n}\n'), /dockTermOpen\(x\)/);
  // it stays while the pointer is on the tiles / the window or the user types (focus or text); else it goes 300 ms later
  assert.match(between(html, 'function dockTyping()', '\n}\n'), /inp\.value\.trim\(\) \|\| \(document\.activeElement === inp && inp\.dataset\.sent !== '1'\)/);
  const hold = between(html, 'function dockHoverHold(over)', '\n}\n');
  assert.match(hold, /over == null \? bg\.matches\(':hover'\) \|\| \$\('dock-tiles'\)\.matches\(':hover'\) : over/);
  assert.match(hold, /return dockTyping\(\) \|\| on \|\| !!\$\('team-modal'\);/);
  // the timers ask main where the pointer is (events replayed after a resize must not open / close anything)
  assert.match(between(html, 'async function dockPointerOn(', '\n}\n'), /window\.orca\.dock\(\{ cursor: true \}\)[\s\S]*document\.elementFromPoint\(p\.x, p\.y\)/);
  const leave = between(html, 'function dockHoverLeave()', '\n}\n');
  assert.match(leave, /const over = await dockPointerOn\(DOCK_HOVER_SEL\);[\s\S]*if \(dockTermBg\(\) && dockHoverOpened && !dockHoverHold\(over\)\) dockTermClose\(true\);[^\n]*\n\s*\}, DOCK_LEAVE_MS\)/);
  assert.doesNotMatch(leave, /dockHoverT|dockHoverGen/, 'a leave never cancels a pending hover');
  assert.match(hover, /const on = await dockPointerOn\(tileSel\);\n\s*if \(gen !== dockHoverGen\) return;\n\s*if \(on === false\) \{ dockHoverLeave\(\); return; \}/);
  assert.match(between(main, 'ipcMain.handle("orca:dock"', '\n});'), /if \(r\.cursor === true\) \{[\s\S]*screen\.getCursorScreenPoint\(\)[\s\S]*getContentBounds\(\)/);
  assert.match(html, /\$\('dock-tiles'\)\.addEventListener\('mouseover', e => \{ const b = e\.target\.closest\('\.dock-tile'\); if \(b\) dockHover\(b\.dataset\.key\); \}\);/);
  assert.match(html, /\$\('dock-tiles'\)\.addEventListener\('mouseleave', dockHoverLeave\);/);
  assert.match(html, /window\.addEventListener\('blur', \(\) => \{ if \(dockOn && dockTermBg\(\) && !\$\('team-modal'\)\) dockTermClose\(true\); \}\);/, 'the widget loses the focus: it goes');
  assert.doesNotMatch(html, /dockTipPoll|dockTipTurns|recentTurns|screenTurns/, 'the history panel is gone');
  // the terminal window: the remote view's markup, local reads / send / interrupt, permission line from the bar
  const open = between(html, 'function dockTermOpen(x)', '\nfunction dockTermSchedule');
  assert.match(open, /termViewHtml\(/); assert.match(open, /dockSendTo\(ys, hh, text\)/);
  assert.match(open, /await teamConfirm\([\s\S]*window\.orca\.terminalInterrupt\(now\.hh\)/, 'interrupt after a confirm');
  assert.match(open, /dockFocusTerminal\(y\)/);
  assert.match(between(html, 'async function dockSendTo(', '\n}\n'), /window\.orca\.terminalSend\(handle, text, true, 15\)[\s\S]*accepted[\s\S]*turn_started/);
  assert.match(between(html, 'function dockTermSync()', '\n}\n'), /\(x\.canInput \|\| st\.freeText\) && !perm/);
  assert.match(between(html, 'function peerRemoteTermOpen(', '\n}\n'), /termViewHtml\(/, 'the teammate view uses the same markup');
  // a click: straight to the terminal (no timer); a teammate's delegated session: its remote window
  const click = between(html, "$('dock-tiles').addEventListener('click'", '\n});');
  assert.match(click, /dockTermClose\(true\); dockTipHide\(\); dockSel = x\.key; dockDraw\(\);\n\s*dockFocusTerminal\(x\);$/, 'my session: switchTo at once');
  assert.doesNotMatch(click, /setTimeout/, 'no delay');
  assert.match(click, /if \(x\.delegated && dockTermKey\(\) !== x\.key\) dockTermFor\(x\)/);
  assert.match(between(html, 'async function dockFocusTerminal(', '\n}\n'), /await api\.switchTo\(h\)/);
  assert.match(open, /if \(!st\.alive\) return;[^\n]*\n\s*const now = cur\(\); if \(!now\.hh\) return;\n\s*const r = await window\.orca\.terminalInterrupt\(now\.hh\)/, 'looked up again after the confirm');
  const keys = between(html, "$('dock-tiles').addEventListener('keydown'", '\n});');
  assert.match(keys, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)[\s\S]*dockFocusTerminal\(x\)/, '⌘Enter: the terminal');
  assert.match(keys, /if \(e\.key === 'Enter'\) \{[\s\S]*dockTermFor\(x\)/, 'Enter: the terminal window');
  assert.match(html, /if \(\$\('peer-term'\) \|\| \$\('dock-term'\)\) \{[^\n]*peerRemoteTermClose\(\);[^\n]*dockTermClose\(\); dockTileFocus\(k\)/, 'Esc closes either window, focus back on the tile');
  assert.match(html, /if \(dockOn && dockTipKey\) \{ const k = dockTipKey; dockTipHide\(\); dockTileFocus\(k\)/, 'Esc closes the hover card');
  // the bar has no input line of its own: the terminal window's line (and the bubbles) take the input and the answers
  for (const id of ['dock-input', 'dock-send', 'dock-chip', 'dock-quick', 'dock-hint', 'dock-go']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id}: gone`);
  assert.doesNotMatch(html, /function dockQuickDraw|function dockSend\(\)/);
  assert.match(between(html, 'function dockPermShow(r)', '\n}\n'), /const box = \$\('pt-perm'\); if \(!box\) return;/, '[허용][거부] only in the terminal window');
  assert.match(between(html, 'function dockPermSync()', '\n}\n'), /if \(perm && !dockAskOn\(x\.key\)\) dockPermShow\(perm\);/, 'a request in a bubble is answered there');
  // the name under every character; 40 px tiles drop it
  assert.match(between(html, 'function dockTileHtml(x)', '\n}\n'), /<span class="dock-name" aria-hidden="true">\$\{esc\(x\.name\)\}<\/span>/);
  assert.match(html, /\.dock-tiles\.s40 \.dock-name \{ display: none; \}/);
  assert.match(html, /\.dock-tile \{ position: relative; width: 56px; height: 56px;/);
  // the screen wraps instead of scrolling sideways; a row of box-drawing rules is one thin line
  assert.match(html, /\.peer-term \.pt-screen \{ white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; \}/);
  assert.match(between(html, 'function termScreenHtml(lines)', '\n}\n'), /TERM_RULE_RE\.test\(l\) \? '<span class="pt-rule"><\/span>' : esc\(l\) \+ '\\n'/);
  assert.match(html, /const TERM_RULE_RE = \/\^\\s\*\[╭┌╰└├┬┴\]\?\[─━═┄┅┈┉╌╍\]\{4,\}\[╮┐╯┘┤┬┴\]\?\\s\*\$\/;/);
  for (const row of ['────────', '╭──────╮', '╰──────╯', '  ┌────┐  ']) assert.match(row, /^\s*[╭┌╰└├┬┴]?[─━═┄┅┈┉╌╍]{4,}[╮┐╯┘┤┬┴]?\s*$/, row);
  for (const row of ['│ hello │', '─── Title ───', '---']) assert.doesNotMatch(row, /^\s*[╭┌╰└├┬┴]?[─━═┄┅┈┉╌╍]{4,}[╮┐╯┘┤┬┴]?\s*$/, row);
  // results the user must see: the pill over the tiles (errors 5 s, the rest 3 s); plain hints are dropped
  assert.match(between(html, 'function dockHint(text, cls, hard)', '\n}\n'), /if \(!dockOn \|\| !text \|\| \(cls !== 'err' && !hard\)\) return;/);
  // main: the bar's own rectangle inside a wider window
  assert.match(between(main, 'function dockStripRect(', '\n}'), /cur\.x \+ \(last\.stripX \|\| 0\)/);
  assert.match(between(main, 'function dockShape(', '\n}'), /x: b\.stripX \|\| 0/);
  assert.match(between(main, 'function dockApply(', '\n}\n'), /popWidth: dockNum\(r\.popWidth, 0, 4000\)/);
});

// ── choice bubbles / tiles at work: layout, activity, tool marks, frames ──
test('bubbleLayout: centred on their tiles, pushed apart, kept inside, the oldest dropped first', () => {
  const L = D.bubbleLayout;
  const one = L([{ key: 'a', anchor: 500, since: 1 }], { winWidth: 1000 });
  assert.deepEqual(one, { placed: [{ key: 'a', x: 380, width: 240, tail: 120 }], dropped: [] });
  // two tiles 50 px apart: side by side, no overlap, tails still on their tiles
  const two = L([{ key: 'a', anchor: 300, since: 1 }, { key: 'b', anchor: 350, since: 2 }], { winWidth: 1000 });
  const [a, b] = two.placed;
  assert.ok(a.x + a.width + 6 <= b.x, 'no overlap'); assert.equal(two.dropped.length, 0);
  assert.equal(a.x + a.tail, 300); assert.ok(b.tail >= 14 && b.tail <= 226);
  // edges: clamped inside the window (6 px margin)
  const edge = L([{ key: 'a', anchor: 5, since: 1 }, { key: 'b', anchor: 995, since: 2 }], { winWidth: 1000 });
  assert.equal(edge.placed[0].x, 6); assert.equal(edge.placed[1].x + edge.placed[1].width, 994);
  // three in 500 px: only two fit, the oldest goes
  const many = L([{ key: 'new', anchor: 100, since: 30 }, { key: 'old', anchor: 120, since: 10 }, { key: 'mid', anchor: 140, since: 20 }], { winWidth: 500 });
  assert.deepEqual(many.dropped, ['old']); assert.deepEqual(many.placed.map(x => x.key), ['new', 'mid']);
  for (const p of many.placed) assert.ok(p.x >= 6 && p.x + p.width <= 494);
  // a wider (hovered) bubble among normal ones
  const mixed = L([{ key: 'a', anchor: 200, since: 1, width: 340 }, { key: 'b', anchor: 220, since: 2 }], { winWidth: 900 });
  assert.equal(mixed.placed[0].width, 340); assert.ok(mixed.placed[0].x + 340 + 6 <= mixed.placed[1].x);
  assert.deepEqual(L(null, { winWidth: 500 }), { placed: [], dropped: [] });
  // one bubble wider than the window: narrowed to it, not dropped (a window under 352 px still shows a grown bubble)
  assert.deepEqual(L([{ key: 'a', anchor: 50, width: 340 }], { winWidth: 300 }).placed.map(p => [p.x, p.width]), [[6, 288]]);
  assert.deepEqual(L([{ key: 'a', anchor: 10 }], { winWidth: 100 }).placed.map(p => p.width), [88]);
  assert.equal(L([{ key: 'a', anchor: 5 }], { winWidth: 12 }).dropped.length, 1, 'no room at all');
  const pair = L([{ key: 'a', anchor: 50, since: 1, width: 340 }, { key: 'b', anchor: 60, since: 2 }], { winWidth: 300 });
  assert.deepEqual([pair.dropped, pair.placed.map(p => [p.key, p.width])], [['a'], [['b', 240]]], 'several: the oldest still goes');
  assert.equal(D.popExtra('bubbles'), D.POP.bubbleH + D.POP.tail + 2 * D.POP.gap);
  assert.ok(D.popExtra('bubblesBig') > D.popExtra('bubbles'));
});

test('promptContext: the prompt box above a numbered choice (the command a permission prompt asks about)', () => {
  const box = ['earlier output', '╭────────╮', '│ Bash command             │', '│                          │', '│   rm -rf ~/              │', '│   Remove the home folder │', '│                          │', '│ Do you want to proceed?  │', '│ ❯ 1. Yes                 │', "│   2. Yes, and don't ask  │", '│   3. No                  │', '╰────────╯'];
  assert.equal(D.promptContext(box), 'Bash command\n\nrm -rf ~/\nRemove the home folder\n\nDo you want to proceed?');
  const ask = ['old', '────────────', '☐ 범위', '', '어디까지?', '', '❯ 1. 결제만', '     설명', '  2. 둘 다', 'Enter to select'];
  assert.equal(D.promptContext(ask), '☐ 범위\n\n어디까지?', 'stops at a rule; option descriptions are not context');
  assert.equal(D.promptContext(['  2. x', '❯ 3. y']), ''); assert.equal(D.promptContext(['plain']), ''); assert.equal(D.promptContext(null), '');
  assert.equal(D.promptContext(Array.from({ length: 30 }, (_, i) => 'line ' + i).concat(['❯ 1. ok'])).split('\n').length, 14, 'at most 14 rows');
});

test('activityLevels / toolGlyph / workFrame: the working tile', () => {
  assert.deepEqual(D.activityLevels([1000, 2000, 55000, 59000], 60000), [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(D.activityLevels([59000, 59500, 50000], 60000), [0, 0, 0, 0, 0.5, 1]);
  assert.deepEqual(D.activityLevels([], 60000), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(D.activityLevels([70000, -5, 'x', null], 60000), [0, 0, 0, 0, 0, 0], 'future / junk times ignored');
  assert.equal(D.activityLevels([1], 2, { buckets: 3 }).length, 3);
  assert.equal(D.toolGlyph('Bash'), '$'); assert.equal(D.toolGlyph('Edit'), '✎'); assert.equal(D.toolGlyph('Read'), '≡');
  assert.equal(D.toolGlyph('Grep(pattern)'), '⌕'); assert.equal(D.toolGlyph('mcp__slack__post'), '⚙');
  assert.equal(D.toolGlyph('Skill'), 'Sk'); assert.equal(D.toolGlyph(''), ''); assert.equal(D.toolGlyph(null), '');
  assert.deepEqual([0, 1, 2, 3].map(s => D.workFrame(s)), [3, 4, 3, 4], 'typing: 3 ↔ 4 every frame');
  assert.deepEqual([0, 1, 2, 3].map(s => D.workFrame(s, true)), [5, 5, 6, 6], 'reading: 5 ↔ 6 every other frame');
});

test('widget dock: choice bubbles reuse the popover parser, the shared answer path, the permission line and the guard', () => {
  assert.match(html, /<script src="core\/guard\.js"><\/script>/);
  const sync = between(html, 'function dockAskSync()', '\n}\n');
  assert.match(sync, /x\.state !== 'ask'/); assert.match(sync, /dockAskDrop\(k\)/, 'a session that stopped waiting loses its bubble');
  const scan = between(html, 'function dockAskScan(lines)', '\n}\n');
  for (const re of [/officeParseChoice\(lines\)/, /AgentDeskDock\.promptContext\(lines\)/, /AgentDeskDock\.promptBox\(lines, 200\)/, /AgentDeskDock\.permPrompt\(lines, parsed\.options\)/]) assert.match(scan, re);
  assert.match(between(html, 'async function dockAskRead(', '\n}\n'), /const s = dockAskScan\(c\.lines\);/);
  const fill = between(html, 'function dockAskFill(a)', '\n}\n');
  assert.match(fill, /el\.appendChild\(dockPermLine\(a\.perm\)\)/, 'permission requests: the bar\'s permission line');
  // H1 / M2: the guardrail reads the whole box with wraps undone; Claude Code's permission prompts follow the bar's
  // [허용] rule; "don't ask again" never
  const read = between(html, 'async function dockAskRead(', '\n}\n');
  assert.match(read, /\.\.\.AgentDeskDock\.guardTexts\(s\.box\)/);
  assert.match(read, /a\.userGuard = null;[^\n]*\n[\s\S]*const sig = s\.sig, ug = await dockGuardUser\(a\.texts\);/, 'the user rules: through main');
  assert.match(fill, /const local = p \? dockGuardLocal\(a\.texts \|\| \[\]\)/);
  assert.match(fill, /a\.userGuard \|\| \{ blocked: true, pending: true/, 'not answered yet = a hit');
  assert.match(fill, /lockYes = danger\.blocked \|\| \(pa\.perm && !pa\.allowable\)/);
  assert.match(fill, /never = AgentDeskDock\.PERM_NEVER_RE\.test\(o\.label\) \|\| !\(n >= 1 && n <= 9\)/, 'L4: one key, 1 … 9');
  assert.match(fill, /const role = never \? 'never' : lockYes && !\(pa\.perm && DOCK_NO_RE\.test\(o\.label\)\) \? 'allow' : 'opt';/, 'L5: "No" only on permission prompts');
  assert.match(fill, /el\.dataset\.truncated = lockYes \? '1' : '0'/);
  assert.match(between(html, 'function permArm(el)', '\n}'), /b\.dataset\.perm === 'never' \|\| \(b\.dataset\.perm === 'allow' && el\.dataset\.truncated === '1'\)/, '"never" stays off after arming');
  assert.match(html, /const dockAskLocked = \(el, b\) => b\.dataset\.perm === 'never' \|\| \(b\.dataset\.perm === 'allow' && el\.dataset\.truncated === '1'\);/);
  assert.match(between(html, 'function dockAskWire(a)', '\n}\n'), /if \(b && !b\.disabled && !dockAskLocked\(el, b\)\)/, 'checked again on click');
  assert.match(fill, /permArm\(el\)/, 'armed like a permission panel');
  assert.match(fill, /qLines\.slice\(0, max\)/); assert.match(fill, /data-more="1"/);
  for (const v of ['esc(a.name || \'\')', 'esc(q)', 'esc(o.label)', 'esc(o.desc)', 'esc(a.sent)', 'esc(a.err)']) assert.ok(fill.includes(v), v);
  assert.match(between(html, 'async function dockAskAnswer(', '\n}\n'), /await choiceSend\(a\.handle, n,/);
  assert.match(between(html, 'async function officeAnswer(', '\n}\n'), /await choiceSend\(a\.handle, n,/, 'the popover uses the same path');
  // M1: the prompt is read again before the first key (and before the Enter); a changed one sends nothing
  assert.match(between(html, 'async function choiceSend(', '\n}\n'), /if \(!await stillUp\(\)\) \{[^\n]*e\.changed = true; throw e; \}\n\s*const r1 = await window\.orca\.terminalSend\(handle, String\(n\), false, 0\)[\s\S]*if \(await stillUp\(\)\) await window\.orca\.terminalSend\(handle, String\(n\), true, 5\)/);
  const answer = between(html, 'async function dockAskAnswer(', '\n}\n');
  assert.match(answer, /const c = await dockScreenRead\(a\.handle, true\), x = dockTileOf\(a\.key\);\n\s*return !!\(c\.lines && x && x\.state === 'ask'\) && dockAskScan\(c\.lines\)\.sig === sig;/);
  assert.match(answer, /if \(err && err\.changed\) \{ a\.err = err\.message; a\.armedSig = ''; a\.readAt = 0; \}/, 'read again, armed again');
  assert.match(between(html, 'async function officeAnswer(', '\n}\n'), /if \(e\.changed && officeAsk === a\) \{ a\.lastSig = ''; officeAskRefresh\(\); \}/);
  assert.match(between(html, 'function dockAskPlace()', '\n}\n'), /AgentDeskDock\.bubbleLayout\(items/);
  assert.match(between(html, 'function dockHover(key)', '\nfunction dockHoverLeave'), /if \(dockAskOn\(key\)\) \{ dockAskGrowAt\(key, tileSel\); return; \}/, 'a bubble\'s tile grows it instead of opening the window');
  assert.match(between(html, 'async function dockAskGrowAt(', '\n}\n'), /const gen = \+\+dockAskGrowGen;\n\s*if \(await dockPointerOn\(sel\) === false \|\| gen !== dockAskGrowGen\) return;/, 'grown only where the pointer really is, by the latest hover');
  assert.match(between(html, 'function dockPopKind()', '\n}\n'), /if \(dockTermBg\(\)\) return 'term';\n\s*if \(dockAskVisible\(\)\)/, 'the window wins over the bubbles');
});

test('widget dock: one animation loop, stopped when hidden, off by the setting or reduced motion', () => {
  const tick = between(html, 'function dockAnimTick()', '\n}\n');
  assert.match(tick, /AgentDeskDock\.workFrame\(dockAnimStep/); assert.match(tick, /dockAnimNext\(\);/);
  assert.doesNotMatch(tick, /requestAnimationFrame/, 'no frame request per frame: one timer per animation step');
  assert.match(html, /function dockAnimNext\(\) \{ dockAnimT = setTimeout\(\(\) => \{ dockAnimT = 0; dockAnimRaf = requestAnimationFrame\(dockAnimTick\); \}, DOCK_FRAME_MS\); \}/);
  assert.match(html, /\.st-run \.dock-act\.breathe \{ animation: dockActBreath/, 'the breathing bar: CSS');
  assert.match(html, /const dockAnimAllowed = \(\) => dockOn && dockCfg\.anim && !dockReduced\.matches && !document\.hidden;/);
  assert.match(html, /const DOCK_FRAME_MS = 200;/);
  assert.equal((html.match(/requestAnimationFrame\(dockAnimTick\)/g) || []).length, 1, 'one place asks for a frame');
  assert.match(html, /#page-dock\.dock-still \*, #page-dock\.dock-still \*::after \{ animation: none !important; \}/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{\n\s*#page-dock \*, #page-dock \*::after, \.dock-bubble \{ animation: none !important; transition: none !important; \}/);
  assert.match(between(html, 'function dockTileDeco()', '\n}\n'), /AgentDeskDock\.activityLevels\(\(s\.recentTools \|\| \[\]\)/);
});

// ── security review: Claude Code's permission prompts in a bubble, wrapped commands, the whole prompt box ──
await import('../core/guard.js');
const G = globalThis.AgentDeskGuard;
const flagged = rows => D.guardTexts(rows).some(s => G.isDangerous(s).blocked);
const bashPrompt = (body, width = 120) => ['─'.repeat(width), ' Bash command', '', ...body.map(b => '   ' + b), '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for this command", '   3. No, and tell Claude what to do differently (esc)'];
const OPTS = [{ label: 'Yes' }, { label: "Yes, and don't ask again for this command" }, { label: 'No, and tell Claude what to do differently (esc)' }];

test('guardTexts / promptBox: a command the terminal wrapped is still caught; the whole box, not 14 rows', () => {
  assert.equal(flagged(D.promptBox(bashPrompt(['rm -r', 'f ~/', 'Remove the home folder']))), true, 'rm -r / f ~/');
  assert.equal(flagged(D.promptBox(bashPrompt(['git push --for', 'ce origin main', 'Push']))), true, 'git push --for / ce origin main');
  assert.equal(G.isDangerous('rm -r f ~/').blocked, false, 'joined with a space it slips past (why both forms)');
  // the dangerous command 20 rows above the options: outside promptContext's 14, inside promptBox's 60
  const tall = ['─'.repeat(100), ' Bash command', '', '   rm -rf ~/', ...Array.from({ length: 20 }, (_, i) => '   # note ' + i), '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
  assert.equal(D.promptContext(tall).includes('rm -rf'), false);
  assert.equal(flagged(D.promptBox(tall)), true);
  assert.equal(D.promptBox(Array.from({ length: 100 }, (_, i) => 'r' + i).concat(['❯ 1. ok'])).length, 60, 'at most 60 rows');
  // a bordered box: only its own rows (output above the box is not part of it)
  const boxed = ['rm -rf ~/ was discussed earlier', '╭──────╮', '│ Bash command │', '│   ls │', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', '│   2. No │', '╰──────╯'];
  assert.deepEqual(D.promptBox(boxed), ['Bash command', 'ls', 'Do you want to proceed?']);
  assert.equal(flagged(D.promptBox(boxed)), false);
  assert.equal(flagged(D.promptBox(bashPrompt(['npm test', 'Run the tests']))), false, 'a harmless command stays harmless');
  assert.deepEqual(D.guardTexts(['a', 'b', '', 'c']), ['a b c', 'ab c', 'ab']);
  assert.deepEqual(D.promptBox(['plain']), []);
});

test('permPrompt: Claude Code permission prompts, and when the bar may say yes (its [허용] rule)', () => {
  const ok = D.permPrompt(bashPrompt(['npm test', 'Run the tests']), OPTS);
  assert.deepEqual(ok, { perm: true, kind: 'bash', allowable: true, command: 'npm test' });
  assert.equal(D.permPrompt(bashPrompt(['npm test']), OPTS).allowable, true, 'no description');
  assert.equal(D.permPrompt(bashPrompt(['npm test &&', 'npm run build', 'Build']), OPTS).allowable, false, 'several rows');
  assert.equal(D.permPrompt(bashPrompt(['x'.repeat(81)]), OPTS).allowable, false, 'longer than PERM_LINE_MAX');
  assert.equal(D.permPrompt(bashPrompt(['x'.repeat(80)]), OPTS).allowable, true);
  assert.equal(D.permPrompt(bashPrompt(['npm run test -- --watch…']), OPTS).allowable, false, 'cut');
  assert.equal(D.permPrompt(bashPrompt(['npm test |']), OPTS).allowable, false, 'continued');
  assert.equal(D.permPrompt(bashPrompt(['npm test', 'Run the tests'], 60), OPTS).allowable, false, 'a narrow terminal: the 2nd row may be a wrap');
  const edit = D.permPrompt([' Edit file', ' src/a.js', ' Do you want to make this edit to a.js?', ' ❯ 1. Yes', "   2. Yes, and don't ask again this session", '   3. No'], [{ label: 'Yes' }, { label: "Yes, and don't ask again this session" }, { label: 'No' }]);
  assert.deepEqual([edit.perm, edit.kind, edit.allowable], [true, 'edit', false], 'file edits: never from the bar');
  const write = D.permPrompt([' Write file', ' Do you want to create notes.md?', ' ❯ 1. Yes', '   2. No'], [{ label: 'Yes' }, { label: 'No' }]);
  assert.deepEqual([write.perm, write.kind, write.allowable], [true, 'edit', false]);
  const fetchp = D.permPrompt([' Fetch', ' https://example.com', ' Do you want to allow Claude to fetch this content?', ' ❯ 1. Yes', '   2. No'], [{ label: 'Yes' }, { label: 'No' }]);
  assert.deepEqual([fetchp.perm, fetchp.kind, fetchp.allowable], [true, 'other', false]);
  assert.equal(D.permPrompt(['Pick one', '❯ 1. a', '  2. b'], [{ label: 'a' }, { label: "b, don't ask again" }]).perm, true, 'a "don\'t ask again" option alone marks it');
  const q = D.permPrompt(['☐ 범위', '어디까지?', '❯ 1. 결제만', '  2. 둘 다'], [{ label: '결제만' }, { label: '둘 다' }]);
  assert.deepEqual([q.perm, q.allowable], [false, true], 'an AskUserQuestion is not a permission prompt');
  for (const l of ["Yes, and don't ask again", 'Yes, and don’t ask again for git', 'yes, DONT ASK AGAIN']) assert.match(l, D.PERM_NEVER_RE);
  assert.doesNotMatch('Yes', D.PERM_NEVER_RE);
});

test('widget dock: security review lows — fail-closed guard, setting, re-arming, key range, "No", cursor IPC', () => {
  // L3: built-in rules here, user rules in main (guardTest); failed / timed out / cut / too long = a hit
  const user = between(html, 'async function dockGuardUser(texts)', '\n}\n');
  assert.match(user, /window\.orca\.guardTest\('Bash', all, 'warn'\)/);
  assert.match(user, /if \(all\.length > DOCK_GUARD_MAX\) return \{ blocked: true/);
  assert.match(user, /if \(!r \|\| r\.ok === false\) return \{ blocked: true/);
  assert.match(user, /if \(r\.timedOut \|\| r\.cut \|\| \(Array\.isArray\(r\.slow\) && r\.slow\.length\)\) return \{ blocked: true/);
  assert.match(user, /catch \{ return \{ blocked: true/);
  assert.doesNotMatch(html, /window\.orca\.guardConfig\(\)[^\n]*dockGuard/, 'the rules never come to the page for this');
  // L1
  assert.match(html, /dockCfg\.ask = \['on', 'options', 'off'\]\.includes\(c\.ask\) \? c\.ask : 'on';/);
  assert.match(between(html, 'function dockAskSync()', '\n}\n'), /if \(dockCfg\.ask === 'off'\) \{/);
  assert.match(between(html, 'function dockAskFill(a)', '\n}\n'), /q && dockCfg\.ask !== 'options'/);
  // L2
  assert.match(between(html, 'function dockAskPlace()', '\n}\n'), /if \(a\.x != null && a\.x !== g\.x\) dockAskArm\(a\);/);
  assert.match(between(html, 'function dockAskArm(a)', '\n}\n'), /permArm\(line \|\| a\.el\)/);
  // L4
  assert.match(between(html, 'async function dockAskAnswer(', '\n}\n'), /!\(Number\.isInteger\(n\) && n >= 1 && n <= 9\)/);
  // L5
  const NO = new RegExp(html.match(/const DOCK_NO_RE = \/(.+?)\/i;/)[1], 'i');
  for (const l of ['No', 'No, and tell Claude what to do differently (esc)', 'No and stop', 'no']) assert.match(l, NO, l);
  for (const l of ['Nothing', 'Notify the team', 'Node 20', '아니오 말고 예', 'Cancel everything']) assert.doesNotMatch(l, NO, l);
  // L6
  const cur = between(main, '  if (r.cursor === true) {', '\n  }\n');
  assert.match(cur, /if \(_e\.sender !== mainWindow\.webContents\) return null;/);
  assert.match(cur, /now - dockCursor\.at > 50/);
});

test('widget dock: code review — card exclusion, free text, mute, forced reads, timers, narrow bar, cursor zoom', () => {
  // M2: only a tile's own bubble keeps its card away
  assert.match(between(html, 'function dockTipShow(key)', '\n}\n'), /dockTermBg\(\) \|\| dockAskOn\(key\)\)/);
  // M4: a free-text option → its digit, then the terminal window with a usable input line; [전체 보기] always
  const answer = between(html, 'async function dockAskAnswer(', '\n}\n');
  assert.match(answer, /if \(DOCK_FREE_RE\.test\(label\)\) \{[\s\S]*if \(!await same\(\)\)[\s\S]*terminalSend\(a\.handle, String\(n\), false, 0\)[\s\S]*dockTerm\.freeText = true/);
  assert.match(between(html, 'function dockAskFill(a)', '\n}\n'), /\+ `<button class="bb-more" data-more="1">/);
  for (const l of ['Type something.', 'Other', '직접 입력', '기타']) assert.match(l, new RegExp(html.match(/const DOCK_FREE_RE = \/(.+?)\/i;/)[1], 'i'), l);
  // L5: the answered prompt stays away 5 s and comes back armed
  assert.match(answer, /dockAskSentSig\.set\(a\.key, \{ sig, at: Date\.now\(\) \}\)/);
  const place = between(html, 'function dockAskPlace()', '\n}\n');
  assert.match(place, /if \(dockAskMuted\(a\)\) \{ a\.el\.hidden = true; a\.muted = true; continue; \}/);
  assert.match(place, /if \(a\.muted\) \{ a\.muted = false; dockAskArm\(a\); \}/);
  // L6
  assert.match(between(html, 'async function dockScreenRead(h, force)', '\n}\n'), /while \(c && c\.busy\) \{[^}]*if \(!force\) return c;\n\s*try \{ await c\.p; \} catch \{\}/);
  // L7
  assert.match(between(html, 'function dockHoverLeave()', '\n}\n'), /if \(!dockOn\) \{ if \(t === dockLeaveT\) dockLeaveT = 0; return; \}/);
  // L9: by the bar's width
  assert.doesNotMatch(html, /@media \(max-width: 420px\) \{   \/\* the narrowest bar/);
  assert.match(between(html, 'function dockWinSet(b)', '\n}\n'), /classList\.toggle\('dock-narrow', \(b\.stripWidth \|\| b\.width\) <= DOCK_NARROW\)/);
  // L10
  assert.match(between(html, 'function dockAskSync()', '\n}\n'), /seen2 && \(!a\.el \|\| a\.placed \|\| !a\.sig \|\| a\.muted\)\) dockAskRead\(a\)/);
  // L11
  assert.match(between(html, 'function dockAskRender()', '\n}\n'), /dockPermSync\(\);/);
  // L12
  assert.match(between(main, '  if (r.cursor === true) {', '\n  }\n'), /getZoomFactor\(\)[\s\S]*\(p\.x - c\.x\) \/ z/);
  // L13
  assert.match(between(html, "$('dock-tiles').addEventListener('keydown'", '\n});'), /else dockHint\(t\(x\.delegated \? '팀원 세션의 터미널로는 갈 수 없습니다/);
});

test('permPrompt / PERM_NEVER_RE: the plan prompt and every standing-permission option', () => {
  const lines = ['─'.repeat(100), ' Ready to code?', '', " Here is Claude's plan:", ' 1. edit a.js', ' 2. run tests', '', ' Would you like to proceed?', '', ' ❯ 1. Yes, and auto-accept edits', '   2. Yes, and manually approve edits', '   3. No, keep planning'];
  const opts = [{ n: 1, label: 'Yes, and auto-accept edits' }, { n: 2, label: 'Yes, and manually approve edits' }, { n: 3, label: 'No, keep planning' }];
  const p = D.permPrompt(lines, opts);
  assert.deepEqual([p.perm, p.allowable], [true, false], 'a permission prompt the bar cannot say yes to');
  // the bubble's roles (dockAskFill): never / allow (locked: not allowable) / opt
  const NO = new RegExp(html.match(/const DOCK_NO_RE = \/(.+?)\/i;/)[1], 'i');
  const role = o => (D.PERM_NEVER_RE.test(o.label) || !(o.n >= 1 && o.n <= 9)) ? 'never' : (p.perm && !p.allowable) && !(p.perm && NO.test(o.label)) ? 'allow' : 'opt';
  assert.deepEqual(opts.map(role), ['never', 'allow', 'opt'], 'only "No, keep planning" can be pressed');
  const bypass = D.permPrompt([' Would you like to proceed?', ' ❯ 1. Yes, and bypass permissions', '   2. No, keep planning'], [{ n: 1, label: 'Yes, and bypass permissions' }, { n: 2, label: 'No, keep planning' }]);
  assert.equal(bypass.perm, true);
  for (const l of ["Yes, and don't ask again", 'Yes, do not ask again for git', 'Yes, never ask again', "Yes, allow all edits during this session", 'Yes, and auto-accept edits', 'Yes, and bypass permissions', 'Always allow']) assert.match(l, D.PERM_NEVER_RE, l);
  for (const l of ['Yes', 'Yes, and manually approve edits', 'No, keep planning', 'Allow once']) assert.doesNotMatch(l, D.PERM_NEVER_RE, l);
  // L-b / L-c (source)
  assert.match(between(html, 'async function officeAnswer(', '\n}\n'), /!!\(live && live\.needsInput\) && JSON\.stringify\(still\) === a\.lastSig/);
  const user = between(html, 'async function dockGuardUser(texts)', '\n}\n');
  assert.match(user, /window\.orca\.guardTest\('Bash', all, 'warn'\)/, 'judged even with the guardrail off');
  assert.match(user, /\(Array\.isArray\(r\.slow\) && r\.slow\.length\)\) return \{ blocked: true/);
});

test('optionRun: only the prompt\'s own numbered run (a plan\'s numbered steps above it are not options)', () => {
  const o = (n, label) => ({ n, label });
  assert.deepEqual(D.optionRun([o(1, 'edit a.js'), o(2, 'run tests'), o(1, 'Yes, and auto-accept edits'), o(2, 'Yes, and manually approve edits'), o(3, 'No, keep planning')]).map(x => x.label),
    ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning']);
  assert.deepEqual(D.optionRun([o(1, 'a'), o(2, 'b'), o(3, 'c')]).map(x => x.n), [1, 2, 3]);
  assert.deepEqual(D.optionRun([o(1, 'a'), o(3, 'c')]).map(x => x.n), [3], 'a gap ends the run');
  assert.deepEqual(D.optionRun(null), []); assert.deepEqual(D.optionRun([null, o('x', 'y')]), []);
  assert.match(between(html, 'function officeParseChoice(lines)', '\n}\n'), /const options = AgentDeskDock\.optionRun\(all\);/, 'the shared parser (dashboard, office, dock)');
});

// ── the shared choice parser (dashboard / office popover and the dock's bubbles), run as it is in the page ──
const officeParseChoice = new Function('AgentDeskDock', between(html, 'function officeParseChoice(lines)', '\nlet officeAsk') + '\nreturn officeParseChoice;')(D);

test('officeParseChoice: a plan\'s numbered steps above the question stay in the question, not in the options', () => {
  const plan = ['⏺ Ready to code?', '', " Here is Claude's plan:", ' 1. edit a.js', ' 2. run the tests', '', ' Would you like to proceed?', '', ' ❯ 1. Yes, and auto-accept edits', '   2. Yes, and manually approve edits', '   3. No, keep planning'];
  const p = officeParseChoice(plan);
  assert.deepEqual(p.options.map(o => [o.n, o.label, o.selected]), [[1, 'Yes, and auto-accept edits', true], [2, 'Yes, and manually approve edits', false], [3, 'No, keep planning', false]]);
  assert.equal(p.question, 'Would you like to proceed?');
  // the steps right above the question (no blank row between): still not options, and part of the question
  const tight = ['Steps:', ' 1. edit a.js', ' 2. run the tests', 'Proceed?', ' ❯ 1. Yes', '   2. No'];
  const q = officeParseChoice(tight);
  assert.deepEqual(q.options.map(o => o.label), ['Yes', 'No']);
  assert.match(q.question, /Proceed\?/);
});

test('officeParseChoice: prompts it already read stay the same; a list without the ❯ cursor is not a prompt', () => {
  const ask = ['⏺ 범위를 정해야 합니다.', '', '어디까지?', '', '❯ 1. 결제만', '     정산은 그대로', '  2. 둘 다', '  3. Type something.', '', 'Enter to select'];
  const p = officeParseChoice(ask);
  assert.deepEqual(p.options.map(o => [o.n, o.label, o.desc]), [[1, '결제만', '정산은 그대로'], [2, '둘 다', ''], [3, 'Type something.', '']]);
  assert.equal(p.question, '어디까지?');
  const box = ['╭────╮', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', "│   2. Yes, and don't ask again │", '│   3. No │', '╰────╯'];
  assert.deepEqual(officeParseChoice(box).options.map(o => o.n), [1, 2, 3]);
  assert.equal(officeParseChoice(['1. a', '2. b', '3. c']), null);
  assert.equal(officeParseChoice([]), null);
});
