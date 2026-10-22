// AgentDesk core: dock mode — a thin bar on the bottom edge of the screen that shows one tile per session. Pure
// functions only (no DOM, no timers, no storage); the renderer draws the tiles, main places the window.
//
//   dockModel({ sessions, peers, inbox, selectedId, maxTiles, width }) →
//     { size: 48|40, mine: [tile], peers: [tile], selected: tile|null, hidden: n, total: n }
//     sessions: [{ id, name, status, needsInput, hasPerm, subs, handle }]   my sessions, in the order to show them
//     peers:    [{ peer, id, name, status, needsInput, delegated, subs }]         teammate sessions (the caller passes [] when
//                                                                           team sharing is off)
//     inbox:    buildInbox() items — the per-tile badge counts the items whose target points at that session
//     selectedId: a tile key ('me:<id>' / 'peer:<owner>/<id>'); that tile is never folded into a "+N" pile
//                (unless the pile is the only slot left)
//     width:    pixels available for tiles (both groups and the separator between them); missing = no limit
//     maxTiles: optional cap on the number of tiles (piles included)
//   tile: { key, id, peer, owner, name, state, badge, subs, delegated, canInput, selected, bundle: false }
//     id / peer are exact (lookup keys); owner (the teammate's name) and name are cut and cleaned (display)
//   pile: { key: 'more:me'|'more:peer', bundle: true, count, keys, state, badge }  ("+N" — what did not fit)
//     state: 'ask' (approval needed) > 'err' > 'input' (waiting for input) > 'run' > 'done' — the pile shows the most
//     urgent state among what it holds.
//   Fit: 48 px tiles when everything fits, else 40 px, else 40 px with a "+N" pile; teammates at most MAX_PEERS (+N).
//   Folding keeps the most urgent tiles (and the selected one) and keeps their original order.
//
//   dockBounds({ workArea, contentWidth, height, extra, remembered }) → { x, y, width, height, stripY, stripHeight, extra, dir }
//     The bar sits at the bottom centre of the work area (MARGIN above its bottom edge), STRIP_MIN–STRIP_MAX high,
//     MIN_WIDTH … MAX_FRAC × work-area width wide. remembered { cx, y } (the bar's centre x and top y after a drag)
//     is used only when that point lies inside this work area; the bar is then clamped inside it. extra = room above
//     the bar (hover card, review queue) — the window grows upward by that much (dir 'up'); when the bar sits too high
//     for that it grows downward instead (dir 'down', the room is under the bar); never past the work area.
//
//     popWidth (with extra > 0): the width of the panel shown in that room; when it is wider than the bar the window
//     grows sideways around the bar (the bar itself does not move): stripX = the bar's left edge inside the window,
//     stripWidth = the bar's width, workWidth = the work area's width (for popWidth()).
//
//   permAllowable(summary) → may the bar offer [허용] for this permission request (see below)
//
//   Panels in the room above / below the bar (the renderer draws them; the window is asked for popExtra() of room):
//   popWidth(kind, workWidth) → panel width: 'tip' (hover history) 420 cut to the work area (300 when that is what
//     fits), 'term' (terminal window) min(720, 90 % of the work area), 'tipSmall' (the compact card) 260
//   popExtra(kind) → room the window needs for that panel (its height plus a gap on both sides)
//   popRect({ winWidth, width, anchor, dir, stripHeight, height, room }) → { x, width, height, top, bottom }
//     x centred on anchor (a tile's centre, or the bar's) and clamped inside the window; top (dir 'down') or bottom
//     (dir 'up') = the bar's height plus the gap; height cut to the room left (room = dockBounds extra)
//   screenLines(lines, { mask, maxLines, lineMax, maxBytes }) → a terminal screen made safe to show: ANSI sequences and
//     format characters removed, masked (mask(rows) → rows, e.g. AgentDeskMask.maskLines), control characters
//     blanked, at most maxLines (200) lines of lineMax (400) characters and maxBytes (24 KB) of UTF-8 — the newest kept
//   screenTurns(lines) → [{ role: 'user' | 'agent', text }] read from a Claude Code screen (screenLines output):
//     "❯ text" rows are prompts (not a choice menu's "❯ 1. …" / indented ❯), "⏺" rows start an answer; the banner above the first turn, spinner / rule rows and
//     the input box at the bottom are left out
//   recentTurns(entries, { maxTurns, maxLines, lineMax }) → the last maxTurns (4) non-empty turns
//     [{ role, lines, cut }], each at most maxLines (6) lines (cut: true, the last line ends in "…")
(function (root) {
'use strict';
const STATES = ['ask', 'err', 'input', 'run', 'done'];
const RANK = { ask: 0, err: 1, input: 2, run: 3, done: 4 };
const TILE = { big: 48, small: 40, gap: 4, sep: 9 };
const MAX_PEERS = 8;
const STRIP_MIN = 64, STRIP_MAX = 76, STRIP_DEFAULT = 72;
const MIN_WIDTH = 320, MAX_FRAC = 0.9, MARGIN = 6;
const NAME_MAX = 40;
// C0 / DEL / C1 controls, bidi marks, embeddings, overrides and isolates, BOM (as core/inbox.js)
const CTRL_RE = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩﻿]/g;

function clip(s, n) {
  const v = String(s == null ? '' : s).replace(CTRL_RE, '').replace(/\s+/g, ' ').trim();
  const a = [...v];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : v;
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rawId = v => String(v == null ? '' : v);

// a session's status (renderer words: running / waiting / error / done) → tile state. A pending widget permission
// request wins over everything (the owner must act on it); an agent asking for a choice wins over all but an error.
function stateOf(s) {
  if (!s || typeof s !== 'object') return 'done';
  if (s.hasPerm === true) return 'ask';
  if (s.status === 'error') return 'err';
  if (s.needsInput === true && s.status !== 'done') return 'ask';
  if (s.status === 'running') return 'run';
  if (s.status === 'waiting') return 'input';
  return 'done';
}

// subagents: a list (mine) or a running count (a teammate's) → 0 … 99
const subsOf = v => Math.max(0, Math.min(99, Math.floor(num(Array.isArray(v) ? v.length : v))));
const meKey = id => `me:${id}`;
const peerKey = (peer, id) => `peer:${peer}/${id}`;

// review-queue items per tile key: items that point at one of my sessions (target.sessionId on a non-team page) or at
// a teammate session (target.peer + target.sessionId on the team page)
function badgeCounts(inbox) {
  const out = new Map();
  for (const x of Array.isArray(inbox) ? inbox : []) {
    const tg = x && x.target; if (!tg || !tg.sessionId) continue;
    const k = tg.page === 'team' ? (tg.peer ? peerKey(rawId(tg.peer), rawId(tg.sessionId)) : '') : meKey(rawId(tg.sessionId));
    if (k) out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

const need = (n, size) => (n > 0 ? n * size + (n - 1) * TILE.gap : 0);
// pixel width of a model's tiles (both groups, the separator between them when both have tiles)
function tilesWidth(m) {
  if (!m) return 0;
  const a = (m.mine || []).length, b = (m.peers || []).length;
  return need(a + b, m.size || TILE.big) + (a && b ? TILE.sep + TILE.gap : 0);
}

// keep `cap` of `list` (most urgent first, the selected one always), in their original order; the rest → a pile
function fold(list, cap, selectedKey, pileKey) {
  if (list.length <= cap) return list;
  const keep = Math.max(0, cap - 1);   // one slot for the pile
  const order = list.map((x, i) => ({ x, i })).sort((a, b) =>
    (b.x.key === selectedKey) - (a.x.key === selectedKey) || RANK[a.x.state] - RANK[b.x.state] || a.i - b.i);
  const kept = new Set(order.slice(0, keep).map(o => o.i));
  const shown = list.filter((_, i) => kept.has(i)), rest = list.filter((_, i) => !kept.has(i));
  if (!rest.length) return shown;
  if (cap <= 0) return [];
  const state = rest.reduce((s, x) => (RANK[x.state] < RANK[s] ? x.state : s), 'done');
  shown.push({ key: pileKey, bundle: true, count: rest.length, keys: rest.map(x => x.key), state, badge: rest.reduce((n, x) => n + x.badge, 0) });
  return shown;
}

function dockModel(input) {
  const i = input && typeof input === 'object' ? input : {};
  const badges = badgeCounts(i.inbox);
  const sel = typeof i.selectedId === 'string' ? i.selectedId : '';
  const seen = new Set();
  const mineAll = [];
  for (const s of Array.isArray(i.sessions) ? i.sessions : []) {
    if (!s || !s.id) continue;
    const id = rawId(s.id), key = meKey(id);
    if (seen.has(key)) continue; seen.add(key);
    const state = stateOf(s);
    mineAll.push({ key, id, peer: '', name: clip(s.name || id, NAME_MAX), state, badge: badges.get(key) || 0,
      subs: subsOf(s.subs), delegated: false,
      canInput: state === 'input' && !!s.handle, selected: key === sel, bundle: false });
  }
  const peersAll = [];
  for (const s of Array.isArray(i.peers) ? i.peers : []) {
    if (!s || !s.id || !s.peer || s.ended === true) continue;
    const id = rawId(s.id), peer = rawId(s.peer), key = peerKey(peer, id);
    if (seen.has(key)) continue; seen.add(key);
    // a teammate's own report: only the known words count, anything else is "done"
    const st = { status: ['running', 'waiting', 'error', 'done'].includes(s.status) ? s.status : 'done', needsInput: s.needsInput === true };
    const state = stateOf(st);
    peersAll.push({ key, id, peer, owner: clip(peer, NAME_MAX), name: clip(s.name || id, NAME_MAX), state, badge: badges.get(key) || 0,
      subs: subsOf(s.subs), delegated: s.delegated === true, canInput: false, selected: key === sel, bundle: false });
  }
  // teammates: at most MAX_PEERS tiles (the selected one, delegated ones and urgent ones first), the rest in a "+N" pile
  const peerTiles = peersAll.length > MAX_PEERS ? foldPeers(peersAll, MAX_PEERS + 1, sel) : peersAll;

  const width = i.width == null || !Number.isFinite(Number(i.width)) ? Infinity : Math.max(0, Number(i.width));
  const maxTiles = Number.isInteger(i.maxTiles) && i.maxTiles >= 0 ? i.maxTiles : Infinity;
  const nMine = mineAll.length, nPeer = peerTiles.length, total = nMine + nPeer;
  const sep = nMine && nPeer ? TILE.sep + TILE.gap : 0;
  let size = TILE.big, mine = mineAll, peers = peerTiles;
  if (total > maxTiles || need(total, TILE.big) + sep > width) {
    size = TILE.small;
    if (total > maxTiles || need(total, TILE.small) + sep > width) {
      // how many 40 px tiles fit; mine come first, teammates get about a third (at least one, and what mine leave
      // over). Fewer than two slots after the separator: no teammate group (and no separator) at all.
      const slots = w => { const c = Math.floor((w + TILE.gap) / (TILE.small + TILE.gap)); return Math.max(0, Math.min(Number.isFinite(c) ? c : total, maxTiles)); };
      const both = nMine && nPeer && slots(width - sep) >= 2;
      const cap = both ? slots(width - sep) : slots(width);
      let peerCap = !nPeer ? 0 : !nMine ? Math.min(nPeer, cap) : both ? Math.min(nPeer, Math.max(1, Math.floor(cap / 3))) : 0;
      let mineCap = cap - peerCap;
      if (nMine < mineCap) { mineCap = nMine; peerCap = Math.min(nPeer, cap - nMine); }
      mine = fold(mineAll, mineCap, sel, 'more:me');
      peers = nPeer <= peerCap ? peerTiles : foldPeers(peerTiles, peerCap, sel);
    }
  }
  const all = [...mineAll, ...peersAll];
  const selected = all.find(x => x.key === sel) || null;
  const visible = mine.filter(x => !x.bundle).length + peers.filter(x => !x.bundle).length;
  return { size, mine, peers, selected, hidden: mineAll.length + peersAll.length - visible, total: mineAll.length + peersAll.length };
}

// re-fold the teammate group (which may already end in a pile) into `cap` slots
function foldPeers(tiles, cap, sel) {
  const singles = [], pile = tiles.find(x => x.bundle);
  for (const x of tiles) if (!x.bundle) singles.push(x);
  if (cap <= 0) return [];
  const keep = Math.max(0, cap - 1);
  const ranked = singles.map((x, idx) => ({ x, idx })).sort((a, b) =>
    (b.x.key === sel) - (a.x.key === sel) || (b.x.delegated - a.x.delegated) || RANK[a.x.state] - RANK[b.x.state] || a.idx - b.idx);
  const kept = new Set(ranked.slice(0, keep).map(r => r.idx));
  const shown = singles.filter((_, k) => kept.has(k)), rest = singles.filter((_, k) => !kept.has(k));
  const count = rest.length + (pile ? pile.count : 0);
  if (!count) return shown;
  const restStates = rest.map(x => x.state).concat(pile ? [pile.state] : []);
  const state = restStates.reduce((s, v) => (RANK[v] < RANK[s] ? v : s), 'done');
  shown.push({ key: 'more:peer', bundle: true, count, keys: rest.map(x => x.key).concat(pile ? pile.keys : []), state,
    badge: rest.reduce((n, x) => n + x.badge, 0) + (pile ? pile.badge : 0) });
  return shown;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function dockBounds(input) {
  const i = input && typeof input === 'object' ? input : {};
  const w0 = i.workArea || {};
  const wa = { x: num(w0.x), y: num(w0.y), width: Math.max(0, num(w0.width)), height: Math.max(0, num(w0.height)) };
  if (!wa.width || !wa.height) return null;
  const minW = Math.min(MIN_WIDTH, wa.width);
  const maxW = Math.max(minW, Math.floor(wa.width * MAX_FRAC));
  const width = Math.round(clamp(num(i.contentWidth) || MIN_WIDTH, minW, maxW));
  const stripHeight = Math.min(Math.round(clamp(num(i.height) || STRIP_DEFAULT, STRIP_MIN, STRIP_MAX)), wa.height);
  let cx = wa.x + wa.width / 2;
  let stripY = wa.y + wa.height - stripHeight - MARGIN;
  const r = i.remembered;
  if (r && Number.isFinite(Number(r.cx)) && Number.isFinite(Number(r.y))) {
    const rx = Number(r.cx), ry = Number(r.y);
    if (rx >= wa.x && rx <= wa.x + wa.width && ry >= wa.y && ry < wa.y + wa.height) { cx = rx; stripY = ry; }
  }
  const x = Math.round(clamp(cx - width / 2, wa.x, wa.x + wa.width - width));
  stripY = Math.round(clamp(stripY, wa.y, wa.y + wa.height - stripHeight));
  // room for the hover card / review queue: above the bar when it fits, else below it (a bar dragged to the top),
  // else on the roomier side, cut to what is there
  const want = Math.round(Math.max(0, num(i.extra)));
  const above = stripY - wa.y, below = wa.y + wa.height - (stripY + stripHeight);
  const dir = want <= above || above >= below ? 'up' : 'down';
  const extra = Math.min(want, dir === 'up' ? above : below);
  // a panel wider than the bar: the window grows sideways around the bar's centre, inside the work area
  const popW = extra > 0 ? Math.round(Math.max(0, num(i.popWidth))) : 0;
  const winW = Math.round(Math.min(wa.width, Math.max(width, popW ? popW + 2 * MARGIN : 0)));
  const winX = Math.round(clamp(x + width / 2 - winW / 2, wa.x, wa.x + wa.width - winW));
  return { x: winX, y: dir === 'up' ? stripY - extra : stripY, width: winW, height: stripHeight + extra, stripX: x - winX, stripWidth: width,
    stripY, stripHeight, extra, dir, workWidth: wa.width };
}

// ── panels in the room above / below the bar ──
const POP = { gap: 6, margin: 6, tipW: 420, tipMinW: 300, tipH: 320, tipSmallW: 260, tipSmallH: 120, termW: 720, termFrac: 0.9, termH: 420 };
function popWidth(kind, workWidth) {
  const ww = Math.max(0, Math.floor(num(workWidth))), room = Math.max(0, ww - 2 * POP.margin);
  if (kind === 'term') return Math.min(POP.termW, Math.floor(ww * POP.termFrac), room);
  if (kind === 'tip') return Math.min(room, Math.max(POP.tipMinW, Math.min(POP.tipW, room)));
  if (kind === 'tipSmall') return Math.min(room, POP.tipSmallW);
  return 0;
}
function popExtra(kind) {
  const h = kind === 'term' ? POP.termH : kind === 'tip' ? POP.tipH : kind === 'tipSmall' ? POP.tipSmallH : 0;
  return h ? h + 2 * POP.gap : 0;
}
function popRect(input) {
  const i = input && typeof input === 'object' ? input : {};
  const W = Math.max(0, Math.round(num(i.winWidth))), m = POP.margin;
  const width = Math.max(0, Math.min(Math.round(num(i.width)), W - 2 * m));
  const anchor = i.anchor != null && Number.isFinite(Number(i.anchor)) ? Number(i.anchor) : W / 2;
  const x = Math.round(clamp(anchor - width / 2, m, Math.max(m, W - m - width)));
  const off = Math.round(Math.max(0, num(i.stripHeight))) + POP.gap;
  let height = Math.round(Math.max(0, num(i.height)));
  if (i.room != null && Number.isFinite(Number(i.room))) height = Math.min(height, Math.max(0, Math.round(Number(i.room)) - 2 * POP.gap));
  const down = i.dir === 'down';
  return { x, width, height, top: down ? off : null, bottom: down ? null : off };
}

// ── terminal screen text (the remote terminal view's rules, team/peer.mjs screenLines) ──
const SCREEN = { lines: 200, lineMax: 400, bytes: 24 * 1024 };
const FORMAT_RE = /\p{Cf}/gu;
// ANSI sequences: core/mask.js ANSI_RE (the remote terminal view's), loaded before this file / imported by the caller
const ansiRe = () => (root.AgentDeskMask && root.AgentDeskMask.ANSI_RE) || /\u001b\[[0-9;:?<=>]*[ -/]*[@-~]|\u001b[@-_]/g;
const SCREEN_CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
function utf8Len(s) {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
function screenLines(lines, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxLines = posInt(o.maxLines, SCREEN.lines), lineMax = posInt(o.lineMax, SCREEN.lineMax), maxBytes = posInt(o.maxBytes, SCREEN.bytes);
  const src = (Array.isArray(lines) ? lines : []).slice(-maxLines * 2)
    .map(l => String(l == null ? '' : l).slice(0, lineMax * 4).replace(ansiRe(), '').replace(FORMAT_RE, '').replace(/[\r\n]/g, ' '));
  if (!src.length) return [];
  let rows = src;
  if (typeof o.mask === 'function') {
    rows = o.mask(src);
    if (!Array.isArray(rows) || rows.length !== src.length) return [];   // a masker that does not answer row for row: show nothing
  }
  const out = []; let size = 0;
  for (let i = rows.length - 1; i >= 0 && out.length < maxLines; i--) {
    const l = [...String(rows[i] == null ? '' : rows[i]).replace(SCREEN_CTRL_RE, ' ').replace(/\s+$/, '')].slice(0, lineMax).join('');
    size += utf8Len(l) + 1; if (size > maxBytes) break;
    out.push(l);
  }
  return out.reverse();
}

// ── conversation turns (hover history panel) ──
const RULE_RE = /^[─━]{8,}/;
const SPIN_RE = /^(?:[✻✶✳✢✽]\s|[·*]\s.*(?:…|esc to interrupt))/;
function screenTurns(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map(l => String(l == null ? '' : l).replace(/\s+$/, ''));
  // the input box at the bottom (a rule, then the ❯ line): it and what follows it are not the conversation
  let end = rows.length;
  for (let i = rows.length - 2; i >= 0; i--) if (RULE_RE.test(rows[i].trim()) && /^[❯>]/.test(rows[i + 1].trim())) { end = i; break; }
  const out = []; let cur = null;
  for (let i = 0; i < end; i++) {
    const t = rows[i].trim();
    // a prompt: "❯ text" at the row's start — not a choice menu's cursor ("❯ 1. Yes", or an indented ❯)
    if (/^❯\s*\S/.test(t) && !/^\s/.test(rows[i]) && !/^❯\s*\d+\.\s/.test(t)) { cur = { role: 'user', lines: [t.replace(/^❯\s*/, '')], open: true }; out.push(cur); continue; }
    if (t.startsWith('⏺')) {
      if (!cur || cur.role !== 'agent') { cur = { role: 'agent', lines: [] }; out.push(cur); }
      cur.lines.push(t.replace(/^⏺\s*/, '')); continue;
    }
    if (!cur || RULE_RE.test(t) || SPIN_RE.test(t)) continue;   // the banner above the first turn, rules, spinners
    if (cur.role === 'user') {
      if (!t) { cur.open = false; continue; }
      if (cur.open) { cur.lines.push(t); continue; }
      cur = { role: 'agent', lines: [] }; out.push(cur);   // output after the prompt (hook / tool lines) belongs to the answer
    }
    cur.lines.push(rows[i].replace(/^\s{1,2}/, ''));
  }
  return out.map(x => ({ role: x.role, text: x.lines.join('\n') })).filter(x => x.text.trim());
}
function recentTurns(entries, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxTurns = posInt(o.maxTurns, 4), maxLines = posInt(o.maxLines, 6), lineMax = posInt(o.lineMax, 300);
  const list = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const rows = [];
    for (const l of String(e.text == null ? '' : e.text).replace(/\r\n?/g, '\n').split('\n')) {
      const v = l.replace(/\t/g, '  ').replace(CTRL_RE, '').replace(/\s+$/, '');
      if (!v.trim() && (!rows.length || !rows[rows.length - 1].trim())) continue;   // no leading blank rows, no runs of them
      rows.push(v);
    }
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    if (rows.length) list.push({ role: e.role === 'user' ? 'user' : 'agent', rows });
  }
  return list.slice(-maxTurns).map(({ role, rows }) => {
    const cut = rows.length > maxLines;
    const lines = rows.slice(0, maxLines).map(l => { const a = [...l]; return a.length > lineMax ? a.slice(0, lineMax - 1).join('') + '…' : l; });
    if (cut) lines[lines.length - 1] = lines[lines.length - 1].replace(/…?$/, '…');
    return { role, lines, cut };
  });
}

// [허용] in the bar: only what one short line shows in full — a one-line Bash command or a one-line other request,
// at most PERM_LINE_MAX characters, not cut by the hook. File edits (Edit / Write / MultiEdit / NotebookEdit — the panel
// shows their diff), anything cut, empty or multi-line → answered in the panel ([거부] works for every request).
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const PERM_LINE_MAX = 80;
function permLine(sm) { return String((sm && (sm.kind === 'bash' ? sm.command : sm.kind === 'edit' ? sm.filePath : sm.text)) ?? ''); }
function permAllowable(sm) {
  if (!sm || typeof sm !== 'object' || sm.truncated === true) return false;
  if (sm.kind === 'edit' || EDIT_TOOLS.includes(String(sm.tool || ''))) return false;
  if (sm.kind !== 'bash' && sm.kind !== 'json') return false;
  const v = permLine(sm);
  return !!v.trim() && !/[\r\n]/.test(v) && [...v].length <= PERM_LINE_MAX;
}

const AgentDeskDock = { EDIT_TOOLS, PERM_LINE_MAX, permLine, permAllowable, STATES, TILE, MAX_PEERS, STRIP_MIN, STRIP_MAX, STRIP_DEFAULT, MIN_WIDTH, MAX_FRAC, MARGIN, stateOf, badgeCounts, dockModel, dockBounds, tilesWidth, clip,
  POP, SCREEN, popWidth, popExtra, popRect, screenLines, screenTurns, recentTurns };
root.AgentDeskDock = AgentDeskDock;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
