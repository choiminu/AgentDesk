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

test('dockModel: 48 px when everything fits, 40 px when only that fits', () => {
  const four = ['a', 'b', 'c', 'd'].map(id => sess(id, 'running'));
  const w48 = 4 * 48 + 3 * TILE.gap, w40 = 4 * 40 + 3 * TILE.gap;
  assert.equal(dockModel({ sessions: four, width: w48 }).size, 48);
  const m = dockModel({ sessions: four, width: w48 - 1 });
  assert.equal(m.size, 40); assert.equal(m.mine.length, 4); assert.equal(m.hidden, 0);
  assert.equal(dockModel({ sessions: four, width: w40 }).mine.length, 4);
  assert.equal(dockModel({ sessions: four }).size, 48, 'no width = no limit');
  assert.equal(tilesWidth(dockModel({ sessions: four })), w48);
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

test('dockModel: zero room → no tiles at all (the quick input line keeps its width)', () => {
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
  const f = between(html, 'function dockPermShow(r)', '\nfunction ');
  assert.match(f, /AgentDeskDock\.permAllowable\(sm\)/);
  assert.match(f, /dataset\.truncated = cut \? '1' : '0'/);
  assert.match(f, /permArm\(el\)/);
  assert.match(f, /permDecide\(r\.id, b\.dataset\.perm, '', el\)/);
  assert.match(f, /inboxGo\(\{ kind: 'perm'/, '[패널에서 보기] goes to the request in the panel');
  assert.doesNotMatch(f, /window\.orca\.perm/, 'no permission IPC of its own');
  // permArm keeps [허용] off while data-truncated is 1 (the dock relies on it)
  assert.match(between(html, 'function permArm(el)', '\n}'), /b\.dataset\.perm === 'allow' && el\.dataset\.truncated === '1'/);
  // toasts reach the bar's hint line
  assert.match(between(html, 'function showInAppToast(', '\n}'), /if \(typeof dockOn !== 'undefined' && dockOn\) dockHint\(/);
  assert.doesNotMatch(html, /dockClickT/);
});

test('dockBounds: missing / empty work area → null; junk numbers fall back', () => {
  assert.equal(dockBounds({}), null);
  assert.equal(dockBounds({ workArea: { x: 0, y: 0, width: 0, height: 800 } }), null);
  assert.equal(dockBounds(null), null);
  const b = dockBounds({ workArea: WA, contentWidth: 'abc', height: NaN, remembered: { cx: 'x', y: null } });
  assert.equal(b.width, 320); assert.equal(b.stripHeight, 72); assert.equal(b.x, 560);
});

// ── hover history panel / terminal window: sizes, window growth, placement ──
const { popWidth, popExtra, popRect, screenLines, screenTurns, recentTurns, POP } = D;

test('popWidth / popExtra: hover panel 420 (300 when that is what fits), terminal min(720, 90 %), compact card as before', () => {
  assert.equal(popWidth('tip', 1440), 420);
  assert.equal(popWidth('tip', 400), 388, 'cut to the work area (6 px margins)');
  assert.equal(popWidth('tip', 300), 288, 'a work area narrower than 300 + margins: what fits');
  assert.equal(popWidth('term', 1440), 720);
  assert.equal(popWidth('term', 700), 630, '90 % of the work area');
  assert.equal(popWidth('term', 320), 288);
  assert.equal(popWidth('tipSmall', 1440), 260);
  assert.equal(popWidth('inbox', 1440), 0); assert.equal(popWidth('tip', 'x'), 0);
  assert.equal(popExtra('tip'), POP.tipH + 2 * POP.gap); assert.equal(POP.tipH, 320);
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

test('screenTurns + recentTurns: prompts and answers from a Claude Code screen, the last turns cut to 6 lines', () => {
  const screen = [
    '╭───────────────╮', '│ ✻ Welcome     │', '╰───────────────╯', '',
    '❯ 첫 질문', '', '⏺ 첫 답', '',
    '❯ fix the bug', '  in core/dock.js', '',
    '⏺ Reading the file.', '  ⎿  Read 222 lines', '', '⏺ Fixed:', '  1', '  2', '  3', '  4', '  5', '  6', '',
    '✻ Thinking… (esc to interrupt)', '',
    '────────────────────────────────', '❯ ', '────────────────────────────────', '  ⏵⏵ bypass permissions on',
  ];
  const turns = screenTurns(screen);
  assert.deepEqual(turns.map(x => x.role), ['user', 'agent', 'user', 'agent']);
  assert.equal(turns[2].text, 'fix the bug\nin core/dock.js');
  assert.ok(!turns.some(x => /Welcome|Thinking|bypass|────/.test(x.text)), 'banner, spinner, input box left out');
  const r = recentTurns(turns, { maxTurns: 3, maxLines: 6 });
  assert.equal(r.length, 3); assert.equal(r[0].role, 'agent'); assert.deepEqual(r[0].lines, ['첫 답']);
  const last = r[2];
  assert.equal(last.cut, true); assert.equal(last.lines.length, 6); assert.match(last.lines[5], /…$/);
  assert.equal(last.lines[0], 'Reading the file.');
  assert.deepEqual(screenTurns(['plain shell', '$ ls']), [], 'no prompt / answer markers: no turns');
  // a choice menu is not a prompt: "❯ 1. Yes" and indented ❯ rows belong to the answer
  const menu = screenTurns(['❯ deploy it', '', '⏺ Proceed?', '  ❯ 1. Yes', '    2. No', '❯ 2. No, and tell Claude', ' ❯ indented']);
  assert.deepEqual(menu.map(x => x.role), ['user', 'agent']);
  assert.match(menu[1].text, /1\. Yes/); assert.ok(!menu.some(x => x.role === 'user' && /Yes|No|indented/.test(x.text)));
  assert.deepEqual(screenTurns(null), []);
});

test('recentTurns: blank rows collapsed, empty turns dropped, long lines cut, junk ignored', () => {
  const r = recentTurns([null, 5, { role: 'user', text: '\n\n a \n\n\n b \n\n' }, { role: 'x', text: '   ' }, { text: 'y'.repeat(500) }]);
  assert.deepEqual(r.map(x => x.role), ['user', 'agent']);
  assert.deepEqual(r[0].lines, [' a', '', ' b']);
  assert.equal([...r[1].lines[0]].length, 300); assert.match(r[1].lines[0], /…$/);
  assert.equal(recentTurns(Array.from({ length: 9 }, (_, i) => ({ text: `t${i}` }))).length, 4, 'default: the last 4 turns');
  assert.deepEqual(recentTurns(undefined), []);
});

test('widget dock: hover panel and terminal window — data sources, masking, shared terminal view, click / Enter / Esc', () => {
  const read = between(html, 'async function dockScreenRead(', '\n}\n');
  assert.match(read, /window\.orca\.terminalRead\(h, true\)/);
  assert.match(read, /AgentDeskDock\.screenLines\(extractTail\(res\), \{ mask: rows => AgentDeskMask\.maskRows\(rows\) \}\)/, 'the remote view\'s row masking');
  assert.match(read, /Date\.now\(\) - c\.at < DOCK_SCREEN_MS/, 'one read per handle per second');
  const turns = between(html, 'function dockTipTurns(', '\n}\n');
  assert.match(turns, /AgentDeskDock\.recentTurns\(AgentDeskDock\.screenTurns\(c\.lines\)/);
  assert.match(turns, /AgentDeskMask\.mask\(/, 'the hook / report text is masked too');
  const tip = between(html, 'function dockTipHtml(', '\n}\n');
  assert.ok(tip.includes("${esc(x.peer ? `@${x.owner} / ${x.name}` : x.name)}"), 'the session name through esc()');
  assert.ok(tip.includes("${esc((v.role === 'user' ? '› ' : '') + v.lines.join("), 'the turns through esc()');
  assert.ok(tip.includes('${esc(clean(now, 160))}') && tip.includes('${esc(clean(msg, 200))}'), '지금 하는 일 / the last answer: masked, cut, escaped');
  assert.match(between(html, 'function dockTipPoll()', '\n}\n'), /setTimeout\(dockTipPoll, DOCK_SCREEN_MS\)/);
  assert.match(between(html, 'function dockTipHide()', '\n}\n'), /clearTimeout\(dockTipPollT\)/, 'polling stops when the panel goes');
  // the terminal window: the remote view's markup, local reads / send / interrupt, permission line from the bar
  const open = between(html, 'function dockTermOpen(x)', '\nfunction dockTermSchedule');
  assert.match(open, /termViewHtml\(/); assert.match(open, /dockSendTo\(ys, hh, text\)/);
  assert.match(open, /await teamConfirm\([\s\S]*window\.orca\.terminalInterrupt\(now\.hh\)/, 'interrupt after a confirm');
  assert.match(open, /dockFocusTerminal\(y\)/);
  assert.match(between(html, 'async function dockSendTo(', '\n}\n'), /window\.orca\.terminalSend\(handle, text, true, 15\)[\s\S]*accepted[\s\S]*turn_started/);
  assert.match(between(html, 'function dockTermSync()', '\n}\n'), /x\.canInput && !perm/);
  assert.match(between(html, 'function dockPermShow(r)', '\n}\n'), /\(dockTerm && \$\('pt-perm'\)\) \|\| \$\('dock-perm'\)/);
  assert.match(between(html, 'function peerRemoteTermOpen(', '\n}\n'), /termViewHtml\(/, 'the teammate view uses the same markup');
  const click = between(html, "$('dock-tiles').addEventListener('click'", '\n});');
  assert.match(click, /dockOpenT = setTimeout\(\(\) => \{[^\n]*dockTileOpen\(y\)[^\n]*\}, 250\)/, 'a click opens after 250 ms');
  assert.match(between(html, "$('dock-tiles').addEventListener('dblclick'", '\n});'), /clearTimeout\(dockOpenT\)/, 'a double-click cancels it');
  assert.match(open, /if \(!st\.alive\) return;[^\n]*\n\s*const now = cur\(\); if \(!now\.hh\) return;\n\s*const r = await window\.orca\.terminalInterrupt\(now\.hh\)/, 'looked up again after the confirm');
  assert.match(between(html, "$('dock-tiles').addEventListener('keydown'", '\n});'), /e\.key === 'Enter'[\s\S]*dockTileOpen\(x\)/);
  assert.match(html, /if \(\$\('peer-term'\) \|\| \$\('dock-term'\)\) \{[^\n]*peerRemoteTermClose\(\);[^\n]*dockTermClose\(\); dockTileFocus\(k\)/, 'Esc closes either window, focus back on the tile');
  assert.match(html, /if \(dockOn && dockTipKey\) \{ const k = dockTipKey; dockTipHide\(\); dockTileFocus\(k\)/, 'Esc closes the hover panel');
  assert.match(between(html, 'function dockQuickDraw(m)', '\n}\n'), /input\.hidden = send\.hidden = mode === 'perm' \|\| !!term/, 'one input line at a time');
  // main: the bar's own rectangle inside a wider window
  assert.match(between(main, 'function dockStripRect(', '\n}'), /cur\.x \+ \(last\.stripX \|\| 0\)/);
  assert.match(between(main, 'function dockShape(', '\n}'), /x: b\.stripX \|\| 0/);
  assert.match(between(main, 'function dockApply(', '\n}\n'), /popWidth: dockNum\(r\.popWidth, 0, 4000\)/);
});
