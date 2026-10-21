// AgentDesk core: session-alert decisions shared by the renderer (classic <script>) and the tests (CommonJS).
// Pure functions only — no DOM, no timers; the caller passes `now`. A tracker remembers, per session key, the last
// state seen and when it last alerted, so a state that stays put never alerts twice and a long wait re-alerts on a
// schedule.
//
//   stateOf(s, { now, stuckMs })      → 'error' | 'done' | 'ask' | 'stuck' | 'input' | 'running' | 'idle'
//                                       ask = needs the owner's approval/choice; input = waiting for a prompt
//   createTracker()                   → { entries: Map, peerUp: Map }
//   observe(tr, key, state, now, opts) → null | { kind, repeat }
//       (opts: baseline, remindMs, maxPerHour = reminders an hour (2), maxTransitionsPerHour (6))
//       first sight of a key, or opts.baseline → remembered silently
//       state changed into an alert state      → { kind: state, repeat: false } once, at most maxTransitionsPerHour
//                                                an hour per key (sliding) so a flapping session cannot flood
//       ask / stuck held for remindMs          → { kind: state, repeat: true }, at most maxPerHour reminders an hour
//                                                (input: the transition alert only, no reminders)
//   prune(tr, keepKeys)               → forgets every key not in keepKeys (seen again later = new baseline)
//   peerAlerts(tr, peers, now, opts)  → [{ owner, id, name, kind, repeat }] for teammate sessions delegated to me
//       a teammate that is not connected is skipped and its sessions forgotten; its first snapshot after it
//       (re)connects is a baseline; a session whose delegation ended is forgotten (no alert for that moment).
//       At most PEER_TICK_MAX alerts per teammate per call: past that, the first PEER_TICK_MAX - 1 plus one
//       { owner, kind: 'more', count, id: '', name: '' } summary. owner / name are cleanText'ed.
//       And at most opts.maxPerPeerHour (30) items per teammate per sliding hour, whatever the session ids: past
//       that the rest is dropped and one { owner, kind: 'capped' } item is sent (once an hour). This history
//       survives prune (new session ids / re-delegation) and goes only when the teammate leaves the list.
//   cooldownOk(tr, key, now, ms)      → true at most once per `ms` per key (the desktop notification per teammate)
//   cleanText(s)                      → s without bidi controls (U+202A–202E, U+2066–2069) — names reach OS alerts
(function (root) {
'use strict';
const HOUR = 3600000;
const REMIND_STATES = new Set(['ask', 'stuck']);   // a plain wait for input alerts once, never again
const ACTIVE = new Set(['running', 'input', 'ask', 'stuck']);
const PEER_TICK_MAX = 3;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
function cleanText(s) { return String(s == null ? '' : s).replace(BIDI_RE, ''); }

function stateOf(s, opts) {
  if (!s || typeof s !== 'object') return 'idle';
  const o = opts || {};
  if (s.status === 'error') return 'error';
  if (s.status === 'done') return 'done';
  if (s.needsInput === true && s.ended !== true) return 'ask';
  if (s.status === 'running') {
    const since = Number(s.stuckSince) || 0;
    const stuck = o.stuckMs > 0 && since > 0 ? (Number(o.now) || 0) - since > o.stuckMs : s.stuck === true;
    return stuck ? 'stuck' : 'running';
  }
  if (s.status === 'waiting' && s.ended !== true) return 'input';
  return 'idle';
}

// which state changes deserve an alert (from → to)
function transitionAlerts(prev, next) {
  if (prev === next) return false;
  if (next === 'input') return prev === 'running' || prev === 'stuck';
  if (next === 'stuck') return prev === 'running';
  if (next === 'ask') return true;
  if (next === 'done' || next === 'error') return ACTIVE.has(prev);
  return false;
}

function createTracker() { return { entries: new Map(), peerUp: new Map(), cooldown: new Map(), peerHist: new Map(), peerCapped: new Map() }; }

function observe(tr, key, state, now, opts) {
  const o = opts || {};
  const e = tr.entries.get(key);
  if (!e || o.baseline) {
    tr.entries.set(key, { state, lastAt: now, reminds: e ? e.reminds : [], alerts: e ? e.alerts : [] });
    return null;
  }
  if (e.state !== state) {
    const prev = e.state;
    e.state = state; e.lastAt = now;   // the reminder clock restarts whenever the state changes
    if (!transitionAlerts(prev, state)) return null;
    const maxT = o.maxTransitionsPerHour == null ? 6 : Number(o.maxTransitionsPerHour);
    e.alerts = e.alerts.filter(t => now - t < HOUR);
    if (e.alerts.length >= maxT) return null;
    e.alerts.push(now);
    return { kind: state, repeat: false };
  }
  const remindMs = Number(o.remindMs) || 0;
  if (!REMIND_STATES.has(state) || remindMs <= 0 || now - e.lastAt < remindMs) return null;
  const max = o.maxPerHour == null ? 2 : Number(o.maxPerHour);
  e.reminds = e.reminds.filter(t => now - t < HOUR);
  if (e.reminds.length >= max) return null;
  e.reminds.push(now); e.lastAt = now;
  return { kind: state, repeat: true };
}

function prune(tr, keepKeys) {
  for (const k of [...tr.entries.keys()]) if (!keepKeys.has(k)) tr.entries.delete(k);
}

function peerAlerts(tr, peers, now, opts) {
  const o = opts || {};
  const list = Array.isArray(peers) ? peers : Object.values(peers || {});
  const keep = new Set(), names = new Set(), out = [];
  for (const p of list) {
    if (!p || typeof p.name !== 'string') continue;
    names.add(p.name);
    if (!p.ok) { tr.peerUp.set(p.name, false); continue; }
    const reconnect = tr.peerUp.get(p.name) !== true;
    tr.peerUp.set(p.name, true);
    const mine = new Set((p.delegatedToMe || []).map(d => d && d.sessionId).filter(Boolean)), evs = [];
    const owner = cleanText(p.name);
    for (const s of p.sessions || []) {
      if (!s || !mine.has(s.id)) continue;
      const key = `${p.name}\u0000${s.id}`;
      keep.add(key);
      const ev = observe(tr, key, stateOf(s, { now, stuckMs: o.stuckMs }), now, { baseline: reconnect, remindMs: o.remindMs, maxPerHour: o.maxPerHour, maxTransitionsPerHour: o.maxTransitionsPerHour });
      if (ev) evs.push({ owner, id: s.id, name: cleanText(typeof s.name === 'string' && s.name ? s.name : s.id), kind: ev.kind, repeat: ev.repeat });
    }
    const items = evs.length <= PEER_TICK_MAX ? evs : [...evs.slice(0, PEER_TICK_MAX - 1), { owner, id: '', name: '', kind: 'more', count: evs.length - (PEER_TICK_MAX - 1), repeat: false }];
    if (!items.length) continue;
    const maxH = o.maxPerPeerHour == null ? 30 : Number(o.maxPerPeerHour);
    const hist = (tr.peerHist.get(p.name) || []).filter(t => now - t < HOUR);
    tr.peerHist.set(p.name, hist);
    for (const it of items) {
      if (hist.length < maxH) { hist.push(now); out.push(it); continue; }
      const capAt = tr.peerCapped.get(p.name);
      if (capAt == null || now - capAt >= HOUR) { tr.peerCapped.set(p.name, now); out.push({ owner, id: '', name: '', kind: 'capped', repeat: false }); }
      break;
    }
  }
  prune(tr, keep);
  for (const n of [...tr.peerUp.keys()]) if (!names.has(n)) tr.peerUp.delete(n);
  for (const m of [tr.peerHist, tr.peerCapped]) for (const n of [...m.keys()]) if (!names.has(n)) m.delete(n);
  return out;
}

function cooldownOk(tr, key, now, ms) {
  const last = tr.cooldown.get(key);
  if (last != null && now - last < ms) return false;
  tr.cooldown.set(key, now);
  return true;
}

const AgentDeskNotify = { cleanText, cooldownOk, PEER_TICK_MAX, stateOf, transitionAlerts, createTracker, observe, prune, peerAlerts, REMIND_STATES };
// the widget loads this as a classic <script> (one global); tests `import()` it and read globalThis.AgentDeskNotify
root.AgentDeskNotify = AgentDeskNotify;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskNotify;
})(typeof globalThis !== 'undefined' ? globalThis : this);
