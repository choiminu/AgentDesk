// AgentDesk core: dock mode — a thin bar on the bottom edge of the screen that shows one tile per session. Pure
// functions only (no DOM, no timers, no storage); the renderer draws the tiles, main places the window.
//
//   dockModel({ sessions, peers, inbox, selectedId, maxTiles, width }) →
//     { size: 56|40, mine: [tile], peers: [tile], selected: tile|null, hidden: n, total: n }
//     sessions: [{ id, name, status, needsInput, hasPerm, subs, handle }]   my sessions, in the order to show them
//     peers:    [{ peer, id, name, status, needsInput, delegated, subs }]         teammate sessions (the caller passes [] when
//                                                                           team sharing is off)
//     inbox:    buildInbox() items — the per-tile badge counts the items whose target points at that session
//     selectedId: a tile key ('me:<id>' / 'peer:<owner>/<id>'); that tile is never folded into a "+N" pile
//                (unless the pile is the only slot left)
//     width:    pixels available for tiles (both groups and the separator between them); missing = no limit
//     maxTiles: optional cap on the number of tiles (piles included)
//     size:     'sm' | 'md' | 'lg' (TILE_SIZES; default 'md'): sm = 40 px tiles only, lg = 64 px tiles (40 px to fit)
//     groupPeers: true / false; missing = automatic: more than PEER_GROUP_AT teammate tiles → one tile per teammate
//                with two or more sessions (a teammate with one session keeps its tile); a session delegated to me
//                and the selected one always keep their own tiles (only the rest, two or more, fold)
//   group: { key: 'group:<owner>', bundle: true, group: true, peer, owner, name: '@owner', count, keys, state, badge,
//     subs, delegated: false }  (a teammate's sessions as one tile: the most urgent state, badges and subagents summed)
//   dockHitPlan({ hidden, popKind, extra }) → { hit, sendWithBounds } who takes the pointer: hit = whether the bar
//     takes clicks (false while auto-hidden: they pass through; true as soon as it comes back, panels or not — the
//     pointer handler narrows it to the panels afterwards); sendWithBounds = the bounds request carries hidden: true,
//     so a request with no room (extra 0), which otherwise makes the whole window clickable, keeps the click-through
//   dockEdge(tiles) → the colour of a hidden bar's visible edge: 'ask' > 'err' > 'run' among the tiles, else ''
//   orderSessions(list, order, pinned) → list sorted for the bar: ids in order (the user's drag order) first, in that
//     order; then pinned ones; then the latest activity (time) first; ties keep the list's order
//   moveInOrder(order, id, beforeId) → a new order with id taken out and put right before beforeId (at the end when
//     beforeId is missing / not in it / id itself)
//   dropOrder(visibleIds, id, beforeId) → the order to save after a drag: the visible row with id moved, kept up to
//     and including id (the tiles right of it stay in activity order)
//   worktreeNameOf(raw) → a new session's worktree name: whitespace removed, at most 64 characters, '' when it is not
//     a name Orca takes (letters, digits, - _ . ; starting with a letter or digit)
//   dropAccepts(tile, { hasPerm }) → may something dropped on this tile be sent to it: one of my sessions waiting for
//     input with a terminal (canInput), no permission request pending; never a teammate's, a pile, run / ask
//   dropPayload({ paths, uris, text }, { max }) → { ok, kind: 'files'|'url'|'text', text, cut, error }: what a drop sends
//     (paths: file paths — never their contents — one per line, quoted when they hold a space; uris: text/uri-list;
//     text: plain text), masked by AgentDeskMask.maskForSend and cut to max (2000) characters (cut: it was longer)
//   dropSafeText(text) → { ok, reason }: dropped text / a URL that Claude Code would not read as a prompt — empty
//     ('empty') or starting with / (a slash command), ! (bash mode) or # (memory) ('command') is refused
//   dragStep(state, ev) → { state, action } a tile drag as a state machine (state: null or { key, id, x, y, on, long }):
//     down { key, id, x, y, movable } → 'arm' (not movable: 'none'); long (the hold timer) → 'menu' unless dragging;
//     move { x, y, buttons } → 'start' once DRAG_PX away, then 'mark'; dragging with no button down (the release was
//     lost) → 'cancel'; up → 'drop' (dragging) / 'eat' (after the menu) / 'click'; cancel (pointercancel, lost
//     capture) → 'cancel'. Only 'drop' changes the order.
//   tile: { key, id, peer, owner, name, state, badge, subs, delegated, canInput, selected, bundle: false }
//     id / peer are exact (lookup keys); owner (the teammate's name) and name are cut and cleaned (display)
//   pile: { key: 'more:me'|'more:peer', bundle: true, count, keys, state, badge }  ("+N" — what did not fit)
//     state: 'ask' (approval needed) > 'err' > 'input' (waiting for input) > 'run' > 'done' — the pile shows the most
//     urgent state among what it holds.
//   Fit: 56 px tiles when everything fits, else 40 px, else 40 px with a "+N" pile; teammates at most MAX_PEERS (+N).
//   Folding keeps the most urgent tiles (and the selected one) and keeps their original order.
//
//   stripHeight(size) → the bar's height for a size (STRIP_HEIGHTS)
//   dockPickDisplay({ displays: [{ id, workArea }], barId, hereId, primaryId, remembered }) → { id, workArea, rem }
//     which display the bar goes on and the remembered spot there. remembered: { [displayId]: { cx, y, at } } (an old
//     single { cx, y } counts for the display it lies on). barId (the display the bar is on now, once placed) keeps
//     it there; otherwise the display the window is on when a spot is saved for it, else the display saved last that
//     still exists, else — spots saved but none of their displays left — the primary display's default place; with
//     nothing saved, the window's display. rem = that display's spot or null (the default place).
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
//   popWidth(kind, workWidth) → panel width: 'term' (terminal window, opened by a hover) min(720, 90 % of the work
//     area), 'tipSmall' (the compact hover card) 260; both cut to the work area
//   popExtra(kind) → room the window needs for that panel (its height plus a gap on both sides); 'bubbles' /
//     'bubblesBig' = the choice bubbles (one hovered bubble grows); 'bubblesDone' = only completion bubbles;
//     'usage' = the plan-limit card (the compact card's size); 'menu' = a tile's menu (the same); 'add' = the new-session
//     panel and 'drop' = the confirm panel for something dropped on a tile (twice the card's height, 280 wide). height (bubble kinds): the tallest bubble shown
//     (bubbleHeight) instead of the default
//   bubbleHeight(optionCount, big) → a choice bubble's height for that many options: head, the question (3 rows, big:
//     6), one button row each, a message row and the padding — at least bubbleH / bubbleBigH, at most bubbleMaxH /
//     bubbleBigMaxH (past that the options scroll inside the bubble)
//   bubbleLayout(items, { winWidth, gap }) → { placed: [{ key, x, width, tail }], dropped: [key] }
//     items [{ key, anchor, since, width }]: one choice bubble per tile, centred on its tile (anchor) and pushed
//     sideways so none overlap, inside the window (POP.margin); when they do not all fit the oldest (smallest since) go
//     first, and the last one is narrowed to the window rather than dropped. tail = the tile's x inside the bubble (for its little pointer), kept off the rounded corners.
//   activityLevels(times, now, { buckets, span }) → [0 … 1] per bucket, oldest first: tool calls (timestamps) in the
//     last span ms (default 6 buckets of 10 s), scaled to the busiest bucket
//   promptContext(lines, max) → the text of the prompt box a numbered choice sits in: the rows above its options (box
//     borders stripped) up to the box's top, a rule or max (14) rows — for a permission prompt that is the command it
//     asks about, which the choice parser's question (the paragraph right above the options) leaves out
//   promptBox(lines, max) → [row] the whole prompt box above a numbered choice (borders stripped): up to the box's top,
//     the first row outside a bordered box, or a rule; at most max (60) rows — what the guardrail looks at
//   guardTexts(rows) → texts for the guardrail: all rows joined with spaces; each paragraph (rows between blank rows)
//     joined with nothing, paragraphs with spaces; and every two neighbouring rows joined with nothing — a command
//     the terminal wrapped mid-word ("rm -r" / "f ~/") reads whole in the latter forms. Any of them flagged = flagged.
//   permPrompt(lines, options) → { perm, kind: 'bash' | 'edit' | 'other' | '', allowable, command }
//     perm: Claude Code's own permission prompt ("Do you want to proceed / make this edit / create / allow", the plan
//     mode's "Would you like to proceed?", a
//     "don't ask again" option, a "Bash command" / "Edit file" / "Write file" header). allowable: the bar's [허용]
//     rule — a one-row Bash command of at most PERM_LINE_MAX characters, not cut, not wrapped (with at most its
//     one-row description); file edits and other permission prompts never. PERM_NEVER_RE: options that grant a
//     standing permission ("don't ask again", "during this session", "auto-accept edits", "bypass permissions",
//     "always allow") — never offered by the dock.
//   optionRun(options) → the options of the prompt itself: the last run numbered n-1, n, … up to the last one (a numbered
//     list above the question — a plan's steps — is not one of its options: its digits would answer the prompt)
//   toolGlyph(tool) → a 1–2 character mark for a tool name (Bash $, Edit ✎, Read ≡ …); '' for none
//   workFrame(step, reading) → the sprite sheet column of a working character (office frames): typing 3 ↔ 4 every
//     step, reading 5 ↔ 6 every other step
//   popRect({ winWidth, width, anchor, dir, stripHeight, height, room }) → { x, width, height, top, bottom }
//     x centred on anchor (a tile's centre, or the bar's) and clamped inside the window; top (dir 'down') or bottom
//     (dir 'up') = the bar's height plus the gap; height cut to the room left (room = dockBounds extra)
//   numberedTiles(mine) → [{ key, n }] the first nine of my tiles (piles skipped), n = 1 … 9 left to right (⌘1 … ⌘9)
//   digitOf(e) → 1 … 9 for a keydown of the digit keys 1 … 9 (e.code DigitN / NumpadN, else e.key), else 0
//   bubbleKeyTarget(list) → the key of the choice bubble the digit keys answer: [{ key, shown, big }] — the only one
//     shown, else the shown one that is big (hovered); '' when several are shown and none is big
//   bubbleKeyAllowed({ target, prevTarget, since, now, repeat, armMs }) → may a digit key answer the target bubble now:
//     not a held key's repeat, not when the target is not the one recorded (prevTarget, since = when it became the
//     target), not within armMs (800) of that — a digit meant for one bubble never lands on the next
//   stateClock(clock, tiles, now) → [{ key, from, to, ms }] the state changes since the last call (ms: how long the
//     previous state lasted); clock: Map key →
//     { state, since } (updated in place: new keys start at seed when it is a past time, else now; keys not in tiles
//     go); tiles [{ key, state, seed }]
//   ageLabel(ms) → how long a state has lasted: '' under a minute, '3m' … '59m', then '1h', '2h' … (whole hours)
//   ageWarn(state, ms) → true when that is long: waiting for input ≥ 10 min, working ≥ 30 min
//   usageRows(claude) → [{ k: 's'|'w', pct, resetsAt }] the plan-limit windows that have a percentage (session,
//     weekly); pct 0 … 100 rounded, resetsAt ms or 0
//   screenLines(lines, { mask, maxLines, lineMax, maxBytes }) → a terminal screen made safe to show: ANSI sequences and
//     format characters removed, masked (mask(rows) → rows, e.g. AgentDeskMask.maskRows), control characters
//     blanked, at most maxLines (200) lines of lineMax (400) characters and maxBytes (24 KB) of UTF-8 — the newest kept
(function (root) {
'use strict';
const STATES = ['ask', 'err', 'input', 'run', 'done'];
const RANK = { ask: 0, err: 1, input: 2, run: 3, done: 4 };
const TILE = { big: 56, small: 40, gap: 4, sep: 9 };   // big: the character with its name beneath; small: the character only
// tile sizes per dock size (the "도크 크기" setting): sm has no named tiles, lg starts at 64 px
const TILE_SIZES = { sm: { big: 40, small: 40 }, md: { big: TILE.big, small: TILE.small }, lg: { big: 64, small: 40 } };
const STRIP_HEIGHTS = { sm: 60, md: 72, lg: 84 };
const MAX_PEERS = 8, PEER_GROUP_AT = 6;
const STRIP_MIN = 56, STRIP_MAX = STRIP_HEIGHTS.lg + 2, STRIP_DEFAULT = 72;
const stripHeight = size => STRIP_HEIGHTS[size] || STRIP_HEIGHTS.md;
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
  // many teammate sessions: one tile per teammate; then at most MAX_PEERS tiles (the selected one, delegated ones and
  // urgent ones first), the rest in a "+N" pile
  const grouped = i.groupPeers === true || (i.groupPeers !== false && peersAll.length > PEER_GROUP_AT) ? groupByPeer(peersAll, sel) : peersAll;
  const peerTiles = grouped.length > MAX_PEERS ? foldPeers(grouped, MAX_PEERS + 1, sel) : grouped;
  const T = TILE_SIZES[i.size] || TILE_SIZES.md;

  const width = i.width == null || !Number.isFinite(Number(i.width)) ? Infinity : Math.max(0, Number(i.width));
  const maxTiles = Number.isInteger(i.maxTiles) && i.maxTiles >= 0 ? i.maxTiles : Infinity;
  const nMine = mineAll.length, nPeer = peerTiles.length, total = nMine + nPeer;
  const sep = nMine && nPeer ? TILE.sep + TILE.gap : 0;
  let size = T.big, mine = mineAll, peers = peerTiles;
  if (total > maxTiles || need(total, T.big) + sep > width) {
    size = T.small;
    if (total > maxTiles || need(total, T.small) + sep > width) {
      // how many 40 px tiles fit; mine come first, teammates get about a third (at least one, and what mine leave
      // over). Fewer than two slots after the separator: no teammate group (and no separator) at all.
      const slots = w => { const c = Math.floor((w + TILE.gap) / (T.small + TILE.gap)); return Math.max(0, Math.min(Number.isFinite(c) ? c : total, maxTiles)); };
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

// a teammate's sessions as one tile (two or more of them), in the order the teammates first appear
function groupByPeer(list, sel) {
  const by = new Map();
  for (const x of list) { if (!by.has(x.peer)) by.set(x.peer, []); by.get(x.peer).push(x); }
  const out = [];
  const loose = x => x.delegated || x.key === sel;   // delegated to me / selected: always a tile of its own
  for (const [peer, all] of by) {
    out.push(...all.filter(loose));
    const xs = all.filter(x => !loose(x));
    if (xs.length < 2) { out.push(...xs); continue; }
    const state = xs.reduce((s, x) => (RANK[x.state] < RANK[s] ? x.state : s), 'done');
    out.push({ key: `group:${peer}`, bundle: true, group: true, id: '', peer, owner: xs[0].owner, name: clip(`@${peer}`, NAME_MAX), count: xs.length,
      keys: xs.map(x => x.key), state, badge: xs.reduce((n, x) => n + x.badge, 0), subs: Math.min(99, xs.reduce((n, x) => n + x.subs, 0)),
      delegated: false, canInput: false, selected: false });
  }
  return out;
}
function dockHitPlan(input) {
  const hidden = !!(input && typeof input === 'object' && input.hidden === true);
  return { hit: !hidden, sendWithBounds: hidden };
}
function dockEdge(tiles) {
  let best = '';
  for (const x of Array.isArray(tiles) ? tiles : []) {
    const st = x && x.state;
    if ((st === 'ask' || st === 'err' || st === 'run') && (!best || RANK[st] < RANK[best])) best = st;
  }
  return best;
}
function orderSessions(list, order, pinned) {
  const ord = new Map();
  for (const id of Array.isArray(order) ? order : []) if (!ord.has(String(id))) ord.set(String(id), ord.size);
  const pin = pinned instanceof Set ? pinned : new Set(Array.isArray(pinned) ? pinned : []);
  return (Array.isArray(list) ? list : []).filter(x => x && x.id != null)
    .map((x, i) => ({ x, i, o: ord.has(String(x.id)) ? ord.get(String(x.id)) : Infinity, p: pin.has(x.id) ? 0 : 1 }))
    .sort((a, b) => (a.o === b.o ? 0 : a.o - b.o) || a.p - b.p || num(b.x.time) - num(a.x.time) || a.i - b.i)
    .map(e => e.x);
}
function moveInOrder(order, id, beforeId) {
  const k = String(id), out = (Array.isArray(order) ? order : []).map(String).filter(v => v !== k);
  const at = beforeId == null || String(beforeId) === k ? -1 : out.indexOf(String(beforeId));
  if (at < 0) out.push(k); else out.splice(at, 0, k);
  return out;
}
function dropOrder(visibleIds, id, beforeId) {
  const out = moveInOrder(visibleIds, id, beforeId);
  return out.slice(0, out.indexOf(String(id)) + 1);
}
function worktreeNameOf(raw) {
  const v = [...String(raw == null ? '' : raw).replace(/\s+/g, '')].slice(0, 64).join('');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : '';
}
function dropAccepts(tile, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return !!(tile && typeof tile === 'object' && !tile.bundle && !tile.peer && String(tile.key || '').startsWith('me:')
    && tile.state === 'input' && tile.canInput === true && o.hasPerm !== true);
}
function dropPayload(input, opts) {
  const i = input && typeof input === 'object' ? input : {}, o = opts && typeof opts === 'object' ? opts : {};
  const max = posInt(o.max, 2000);
  let kind = '', raw = '';
  const paths = (Array.isArray(i.paths) ? i.paths : []).map(p => String(p == null ? '' : p)).filter(Boolean);
  if (paths.length) { kind = 'files'; raw = paths.map(p => `"${p.replace(/"/g, '\\"')}"`).join('\n'); }   // always quoted: a bare /path would read as a slash command
  else {
    const uris = String(i.uris == null ? '' : i.uris).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (uris.length) { kind = 'url'; raw = uris.join('\n'); }
    else { kind = 'text'; raw = String(i.text == null ? '' : i.text); }
  }
  const M = root.AgentDeskMask;
  if (!M || typeof M.maskForSend !== 'function') return { ok: false, kind, text: '', cut: false, error: 'no masker' };   // never unmasked
  const r = M.maskForSend(raw, { max: 100000, hardMax: 100000 });
  if (!r.ok) return { ok: false, kind, text: '', cut: false, error: r.error };
  const all = [...r.text], cut = all.length > max;
  return { ok: true, kind, text: cut ? all.slice(0, max).join('') : r.text, cut };
}
function dropSafeText(text) {
  const v = String(text == null ? '' : text).trim();
  if (!v) return { ok: false, reason: 'empty' };
  if (/^[!/#]/.test(v)) return { ok: false, reason: 'command' };
  return { ok: true, reason: '' };
}
const DRAG_PX = 6;
function dragStep(state, ev) {
  const st = state && typeof state === 'object' ? state : null, e = ev && typeof ev === 'object' ? ev : {};
  const same = a => ({ state: st, action: a });
  switch (e.type) {
    case 'down':
      if (!e.movable || e.key == null) return { state: null, action: st ? 'cancel' : 'none' };
      return { state: { key: e.key, id: e.id, x: num(e.x), y: num(e.y), on: false, long: false }, action: 'arm' };
    case 'long':
      return st && !st.on && !st.long ? { state: { ...st, long: true }, action: 'menu' } : same('none');
    case 'move':
      if (!st || st.long) return same('none');
      if (st.on && num(e.buttons) === 0) return { state: null, action: 'cancel' };   // the release never reached us
      if (st.on) return same('mark');
      return Math.hypot(num(e.x) - st.x, num(e.y) - st.y) < DRAG_PX ? same('none') : { state: { ...st, on: true }, action: 'start' };
    case 'up':
      if (!st) return same('none');
      return { state: null, action: st.on ? 'drop' : st.long ? 'eat' : 'click' };
    case 'cancel':
      return { state: null, action: st ? 'cancel' : 'none' };
    default:
      return same('none');
  }
}
// re-fold the teammate group (which may already end in a pile, and may hold teammate groups) into `cap` slots
function foldPeers(tiles, cap, sel) {
  const singles = [], pile = tiles.find(x => x.key === 'more:peer');
  for (const x of tiles) if (x !== pile) singles.push(x);
  if (cap <= 0) return [];
  const keep = Math.max(0, cap - 1);
  const ranked = singles.map((x, idx) => ({ x, idx })).sort((a, b) =>
    (b.x.key === sel) - (a.x.key === sel) || (b.x.delegated - a.x.delegated) || RANK[a.x.state] - RANK[b.x.state] || a.idx - b.idx);
  const kept = new Set(ranked.slice(0, keep).map(r => r.idx));
  const shown = singles.filter((_, k) => kept.has(k)), rest = singles.filter((_, k) => !kept.has(k));
  const count = rest.reduce((n, x) => n + (x.group ? x.count : 1), 0) + (pile ? pile.count : 0);
  if (!count) return shown;
  const restStates = rest.map(x => x.state).concat(pile ? [pile.state] : []);
  const state = restStates.reduce((s, v) => (RANK[v] < RANK[s] ? v : s), 'done');
  shown.push({ key: 'more:peer', bundle: true, count, keys: rest.flatMap(x => (x.group ? x.keys : [x.key])).concat(pile ? pile.keys : []), state,
    badge: rest.reduce((n, x) => n + x.badge, 0) + (pile ? pile.badge : 0) });
  return shown;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// remembered spots: [{ id, cx, y, at }] ('legacy' = the old single { cx, y }); at most 16, junk dropped
function posEntries(rem) {
  if (!rem || typeof rem !== 'object' || Array.isArray(rem)) return [];
  const fin = v => v != null && v !== '' && Number.isFinite(Number(v));
  if (fin(rem.cx) && fin(rem.y)) return [{ id: 'legacy', cx: Number(rem.cx), y: Number(rem.y), at: 0 }];
  return Object.keys(rem).slice(0, 16).map(id => [id, rem[id]]).filter(([, p]) => p && typeof p === 'object' && fin(p.cx) && fin(p.y))
    .map(([id, p]) => ({ id: String(id), cx: Number(p.cx), y: Number(p.y), at: num(p.at) }));
}
function dockPickDisplay(input) {
  const i = input && typeof input === 'object' ? input : {};
  const ds = (Array.isArray(i.displays) ? i.displays : []).filter(d => d && d.id != null && d.workArea && typeof d.workArea === 'object');
  if (!ds.length) return null;
  const byId = id => (id == null ? null : ds.find(d => String(d.id) === String(id)) || null);
  const inside = (wa, p) => p.cx >= num(wa.x) && p.cx <= num(wa.x) + num(wa.width) && p.y >= num(wa.y) && p.y < num(wa.y) + num(wa.height);
  const entries = posEntries(i.remembered);
  const dispOf = e => (e.id === 'legacy' ? ds.find(d => inside(d.workArea, e)) || null : byId(e.id));
  const spotOn = d => { const e = entries.find(x => dispOf(x) === d); return e ? { cx: e.cx, y: e.y } : null; };
  const out = d => ({ id: String(d.id), workArea: d.workArea, rem: spotOn(d) });
  const bar = byId(i.barId);
  if (bar) return out(bar);   // placed already: it stays on its display
  const here = byId(i.hereId);
  if (here && spotOn(here)) return out(here);
  const saved = entries.filter(dispOf).sort((a, b) => b.at - a.at)[0];
  if (saved) return out(dispOf(saved));
  const d = entries.length ? byId(i.primaryId) || ds[0] : here || byId(i.primaryId) || ds[0];
  return { id: String(d.id), workArea: d.workArea, rem: null };
}

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
const POP = { gap: 6, margin: 6, tipSmallW: 260, tipSmallH: 120, termW: 720, termFrac: 0.9, termH: 420, bubbleW: 320, bubbleBigW: 440, bubbleH: 300, bubbleBigH: 420, bubbleMaxH: 560, bubbleBigMaxH: 680, doneW: 220, addW: 280, tail: 6 };
const BUBBLE_ROWS = { head: 30, q: 66, qBig: 132, opt: 54, msg: 20, pad: 18 };   // larger type (13 px): the bubble is read from across the room
function popWidth(kind, workWidth) {
  const ww = Math.max(0, Math.floor(num(workWidth))), room = Math.max(0, ww - 2 * POP.margin);
  if (kind === 'term') return Math.min(POP.termW, Math.floor(ww * POP.termFrac), room);
  if (kind === 'tipSmall' || kind === 'usage' || kind === 'menu') return Math.min(room, POP.tipSmallW);
  if (kind === 'add' || kind === 'drop') return Math.min(room, POP.addW);
  return 0;
}
function popExtra(kind, height) {
  const tall = (kind === 'bubbles' || kind === 'bubblesBig' || kind === 'bubblesDone') && Number.isFinite(Number(height)) && Number(height) > 0;
  if (tall) return Math.round(Number(height)) + POP.tail + 2 * POP.gap;
  const h = kind === 'term' ? POP.termH : kind === 'add' || kind === 'drop' ? 2 * POP.tipSmallH : kind === 'tipSmall' || kind === 'usage' || kind === 'menu' || kind === 'bubblesDone' ? POP.tipSmallH : kind === 'bubbles' ? POP.bubbleH + POP.tail : kind === 'bubblesBig' ? POP.bubbleBigH + POP.tail : 0;
  return h ? h + 2 * POP.gap : 0;
}
function bubbleHeight(optionCount, big) {
  const n = Math.max(0, Math.floor(num(optionCount))), R = BUBBLE_ROWS;
  const h = R.head + (big ? R.qBig : R.q) + n * R.opt + R.msg + R.pad;
  return big ? clamp(h, POP.bubbleBigH, POP.bubbleBigMaxH) : clamp(h, POP.bubbleH, POP.bubbleMaxH);
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

function bubbleLayout(items, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const W = Math.max(0, num(o.winWidth)), m = POP.margin, gap = o.gap == null ? POP.gap : Math.max(0, num(o.gap));
  let list = (Array.isArray(items) ? items : []).filter(x => x && x.key != null)
    .map((x, i) => ({ key: x.key, anchor: num(x.anchor), since: num(x.since), width: Math.max(1, Math.round(num(x.width) || POP.bubbleW)), i }));
  const dropped = [];
  const need = l => l.reduce((n, x) => n + x.width, 0) + Math.max(0, l.length - 1) * gap;
  while (list.length > 1 && need(list) > W - 2 * m) {   // the oldest goes first (ties: the one listed first)
    const old = list.reduce((a, b) => (b.since < a.since ? b : a));
    dropped.push(old.key); list = list.filter(x => x !== old);
  }
  // the last one is narrowed to the window instead (nothing left at all only when there is no room)
  if (list.length === 1 && list[0].width > W - 2 * m) {
    if (W - 2 * m >= 1) list[0].width = Math.floor(W - 2 * m); else { dropped.push(list[0].key); list = []; }
  }
  list.sort((a, b) => a.anchor - b.anchor || a.i - b.i);
  const xs = list.map(x => Math.max(m, Math.round(x.anchor - x.width / 2)));
  for (let k = 1; k < list.length; k++) xs[k] = Math.max(xs[k], xs[k - 1] + list[k - 1].width + gap);   // push right
  for (let k = list.length - 1; k >= 0; k--) {   // then back inside the right edge
    const lim = k === list.length - 1 ? W - m - list[k].width : xs[k + 1] - gap - list[k].width;
    xs[k] = Math.min(xs[k], lim);
  }
  const placed = list.map((x, k) => {
    const lo = Math.min(14, x.width / 2), tail = Math.round(clamp(x.anchor - xs[k], lo, x.width - lo));
    return { key: x.key, x: xs[k], width: x.width, tail };
  });
  return { placed, dropped };
}
function activityLevels(times, now, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const n = posInt(o.buckets, 6), span = num(o.span) > 0 ? num(o.span) : 60000, t = num(now), size = span / n;
  const counts = new Array(n).fill(0);
  for (const v of Array.isArray(times) ? times : []) {
    const age = t - num(v);
    if (!(age >= 0 && age < span)) continue;
    counts[n - 1 - Math.floor(age / size)]++;
  }
  const top = Math.max(...counts);
  return counts.map(c => (top ? c / top : 0));
}
const OPT_RE = /^\s*❯?\s*\d+\.\s+\S/;
const unbox = l => String(l == null ? '' : l).replace(/^\s*[│┃]\s?/, '').replace(/\s?[│┃]\s*$/, '').replace(/\s+$/, '');
// index of the first option of the last option block that has a ❯ cursor (-1: none)
function optionTop(rows) {
  let i = -1;
  for (let k = rows.length - 1; k >= 0; k--) if (/^\s*❯\s*\d+\.\s+\S/.test(rows[k])) { i = k; break; }
  if (i < 0) return -1;
  while (i > 0 && OPT_RE.test(rows[i - 1]) || (i > 0 && /^\s{3,}\S/.test(rows[i - 1]) && i > 1 && OPT_RE.test(rows[i - 2]))) i--;   // up to the first option
  return i;
}
const trimBlank = out => { while (out.length && !out[0]) out.shift(); while (out.length && !out[out.length - 1]) out.pop(); return out; };
function promptContext(lines, max) {
  const raw = Array.isArray(lines) ? lines : [], rows = raw.map(unbox), i = optionTop(rows);
  if (i < 0) return '';
  const out = [], cap = posInt(max, 14);
  for (let k = i - 1; k >= 0 && out.length < cap; k--) {
    const r = String(raw[k] == null ? '' : raw[k]).trim();
    if (/^[╭┌]/.test(r) || /^[─━]{8,}$/.test(r)) break;   // the box's top / a rule
    out.unshift(rows[k].trim());
  }
  return trimBlank(out).join('\n').replace(/\n{3,}/g, '\n\n');
}
function promptBox(lines, max) {
  const raw = (Array.isArray(lines) ? lines : []).map(l => String(l == null ? '' : l)), rows = raw.map(unbox), i = optionTop(rows);
  if (i < 0) return [];
  const boxed = /^\s*[│┃]/.test(raw[i]), out = [], cap = posInt(max, 60);
  for (let k = i - 1; k >= 0 && out.length < cap; k--) {
    const r = raw[k].trim();
    if (/^[╭┌]/.test(r) || /^[─━]{8,}$/.test(r) || (boxed && !/^[│┃]/.test(r))) break;
    out.unshift(rows[k].trim());
  }
  return trimBlank(out);
}
function guardTexts(rows) {
  const v = (Array.isArray(rows) ? rows : []).map(r => String(r == null ? '' : r).trim());
  const blocks = [[]];
  for (const r of v) { if (r) blocks[blocks.length - 1].push(r); else if (blocks[blocks.length - 1].length) blocks.push([]); }
  const out = [v.filter(Boolean).join(' '), blocks.filter(b => b.length).map(b => b.join('')).join(' ')];
  for (let i = 0; i + 1 < v.length; i++) if (v[i] && v[i + 1]) out.push(v[i] + v[i + 1]);   // each wrap point on its own
  return out;
}
const PERM_Q_RE = /do you want to (proceed|make this edit|create|allow)|would you like to proceed/i;
// a standing permission (this and later requests, this session, every edit, no prompts at all): never from the dock
const PERM_NEVER_RE = /(?:don['’]?t|do not|never) ask again|during this session|auto-accept|bypass permissions|always allow/i;
const HEAD_BASH_RE = /^bash command\b/i, HEAD_EDIT_RE = /^(edit|write|create|update|overwrite)\s+(file|notebook)\b/i;
function permPrompt(lines, options) {
  const box = promptBox(lines), opts = Array.isArray(options) ? options : [], head = box.find(Boolean) || '';
  const perm = PERM_Q_RE.test(box.join('\n')) || opts.some(o => o && PERM_NEVER_RE.test(String(o.label || ''))) || HEAD_BASH_RE.test(head) || HEAD_EDIT_RE.test(head);
  if (!perm) return { perm: false, kind: '', allowable: true, command: '' };
  const kind = HEAD_BASH_RE.test(head) ? 'bash' : HEAD_EDIT_RE.test(head) ? 'edit' : 'other';
  if (kind !== 'bash') return { perm, kind, allowable: false, command: '' };
  // between the header and the question: the command, then maybe its one-row description
  const qi = box.findIndex(r => PERM_Q_RE.test(r));
  const body = box.slice(box.indexOf(head) + 1, qi < 0 ? box.length : qi).filter(Boolean);
  const command = body[0] || '', len = [...command].length;
  // a narrow terminal may have wrapped the command onto the row we would take for its description
  const width = Math.max(0, ...(Array.isArray(lines) ? lines : []).map(l => [...String(l == null ? '' : l)].length));
  const allowable = !!command && qi >= 0 && body.length <= 2 && len <= PERM_LINE_MAX && !/(…|\.\.\.)$/.test(command)
    && !/[\\|&;]$/.test(command) && !(body.length === 2 && width <= PERM_LINE_MAX + 4);
  return { perm, kind, allowable, command };
}
function optionRun(options) {
  const list = Array.isArray(options) ? options.filter(o => o && Number.isInteger(Number(o.n))) : [];
  let i = list.length - 1;
  while (i > 0 && Number(list[i - 1].n) === Number(list[i].n) - 1) i--;
  return list.slice(Math.max(0, i));
}
const TOOL_GLYPHS = { Bash: '$', BashOutput: '$', KillShell: '$', Edit: '✎', MultiEdit: '✎', Write: '✎', NotebookEdit: '✎', Read: '≡', NotebookRead: '≡',
  Grep: '⌕', Glob: '⌕', LS: '⌕', WebFetch: '⊕', WebSearch: '⊕', Task: '◎', Agent: '◎', TodoWrite: '☑' };
function toolGlyph(tool) {
  const base = String(tool == null ? '' : tool).split(/[\s:(]/)[0].replace(CTRL_RE, '');
  if (!base) return '';
  if (TOOL_GLYPHS[base]) return TOOL_GLYPHS[base];
  if (/^mcp__/.test(base)) return '⚙';
  return [...base].slice(0, 2).join('');
}
function workFrame(step, reading) {
  const s = Math.max(0, Math.floor(num(step)));
  return reading ? 5 + (Math.floor(s / 2) % 2) : 3 + (s % 2);
}

// ── keys, how long a state has lasted, the plan-limit card ──
function numberedTiles(mine) {
  const out = [];
  for (const x of Array.isArray(mine) ? mine : []) {
    if (!x || x.bundle || x.key == null) continue;
    out.push({ key: x.key, n: out.length + 1 });
    if (out.length >= 9) break;
  }
  return out;
}
function digitOf(e) {
  if (!e || typeof e !== 'object') return 0;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(String(e.code || '')) || /^([1-9])$/.exec(String(e.key || ''));
  return m ? Number(m[1]) : 0;
}
function bubbleKeyTarget(list) {
  const shown = (Array.isArray(list) ? list : []).filter(x => x && x.shown && x.key != null);
  if (shown.length === 1) return shown[0].key;
  const big = shown.filter(x => x.big);
  return big.length === 1 ? big[0].key : '';
}
function bubbleKeyAllowed(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.repeat === true || i.target == null || i.target === '' || i.target !== i.prevTarget) return false;
  const arm = Number.isFinite(Number(i.armMs)) && Number(i.armMs) >= 0 ? Number(i.armMs) : 800;
  const since = Number(i.since), now = Number(i.now);
  return Number.isFinite(since) && Number.isFinite(now) && now - since >= arm;
}
function stateClock(clock, tiles, now) {
  const t = num(now), changes = [], seen = new Set();
  if (!clock || typeof clock.get !== 'function') return changes;
  for (const x of Array.isArray(tiles) ? tiles : []) {
    if (!x || x.key == null || seen.has(x.key)) continue;
    seen.add(x.key);
    const c = clock.get(x.key);
    if (!c) { const s = num(x.seed); clock.set(x.key, { state: x.state, since: s > 0 && s <= t ? s : t }); continue; }
    if (c.state !== x.state) { changes.push({ key: x.key, from: c.state, to: x.state, ms: Math.max(0, t - c.since) }); clock.set(x.key, { state: x.state, since: t }); }
  }
  for (const k of [...clock.keys()]) if (!seen.has(k)) clock.delete(k);
  return changes;
}
function ageLabel(ms) {
  const m = Math.floor(num(ms) / 60000);
  if (!(m >= 1)) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
function ageWarn(state, ms) {
  const v = num(ms);
  return (state === 'input' && v >= 10 * 60000) || (state === 'run' && v >= 30 * 60000);
}
function usageRows(claude) {
  const c = claude && typeof claude === 'object' ? claude : {}, out = [];
  for (const [k, w] of [['s', c.session], ['w', c.weekly]]) {
    if (!w || typeof w !== 'object' || w.usedPercent == null || !Number.isFinite(Number(w.usedPercent))) continue;
    const at = Number(w.resetsAt);
    out.push({ k, pct: Math.max(0, Math.min(100, Math.round(Number(w.usedPercent)))), resetsAt: Number.isFinite(at) && at > 0 ? at : 0 });
  }
  return out;
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

const AgentDeskDock = { dropSafeText, dragStep, DRAG_PX, orderSessions, moveInOrder, dropOrder, worktreeNameOf, dropAccepts, dropPayload, dockHitPlan, dockEdge, TILE_SIZES, STRIP_HEIGHTS, PEER_GROUP_AT, stripHeight, dockPickDisplay, posEntries, EDIT_TOOLS, PERM_LINE_MAX, permLine, permAllowable, STATES, TILE, MAX_PEERS, STRIP_MIN, STRIP_MAX, STRIP_DEFAULT, MIN_WIDTH, MAX_FRAC, MARGIN, stateOf, badgeCounts, dockModel, dockBounds, tilesWidth, clip,
  POP, SCREEN, popWidth, popExtra, bubbleHeight, popRect, screenLines, bubbleLayout, activityLevels, promptContext, promptBox, guardTexts, permPrompt, optionRun, PERM_NEVER_RE, toolGlyph, workFrame,
  numberedTiles, digitOf, bubbleKeyTarget, bubbleKeyAllowed, stateClock, ageLabel, ageWarn, usageRows };
root.AgentDeskDock = AgentDeskDock;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
