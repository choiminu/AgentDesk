// AgentDesk core: per-session timeline built from hook records (~/.roca/events.jsonl). Pure, no DOM, no Electron, no I/O.
// Loaded as a classic <script> (global AgentDeskTimeline) or imported for its side effect. Uses core/mask.js when it
// is loaded first (globalThis.AgentDeskMask); the main process always loads it, so every detail leaves it masked.
//
//   entryFromRecord(rec)          → compact, masked entry { at, e, tool?, tuid?, sub?, detail?, label?, err? } or null
//                                   (unknown events, no session id, no timestamp → null)
//   toolSummary(tool, input)      → one-line summary of a tool input (≤ 120, masked), like core/perm.js summarize
//   createIndex({ max, sessions }) → per-session ring of entries: add(rec) / get(sid) / clear() / size()
//   buildModel(entries, opts)     → { events, span, truncated, noEarlier, subs, waits, stats }
//     events: [{ at, kind, label, detail?, dur?, ok?, open?, sub?, state? }] sorted by time
//       kind: prompt | tool | permission | subagent | stop | stop-failure | compact | task | session
//     subs:  [{ sub, label, start, end, open, row }]      subagent intervals, packed into rows
//     waits: [{ kind: 'user'|'perm', start, end, i }]      user waits (Stop → next prompt) and approval waits
//     stats: { turns, toolCalls, toolFails, subagents, userWaitMs, permWaitMs, permAsks, byTool, slowest }
(function (root) {
'use strict';
const MAX_EVENTS = 2000;
const DETAIL_MAX = 120;
const PAIR_SKEW_MS = 2000;   // a PostToolUse logged before its PreToolUse (async hooks) still pairs within this
const GEMINI_EVENTS = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PostCompact' };
const KNOWN = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'TaskCreated', 'TaskCompleted', 'SessionStart', 'SessionEnd']);
const str = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? '' : String(v));
const maskFn = s => (root.AgentDeskMask && root.AgentDeskMask.mask ? root.AgentDeskMask.mask(s) : String(s));
// cut generously first (masking regexes are bounded anyway), flatten whitespace and control / bidi characters, mask,
// then cut to the shown length: a token split by the first cut sits far beyond what is shown
function clip(s, n) {
  const max = n || DETAIL_MAX;
  let x = str(s); if (x.length > max * 4) x = x.slice(0, max * 4);
  x = x.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim();
  x = maskFn(x);
  return x.length > max ? x.slice(0, max - 1) + '…' : x;
}
const lines = s => { const x = str(s); return x ? x.split('\n').length : 0; };

function toolSummary(tool, input) {
  const t = str(tool), i = input && typeof input === 'object' ? input : {};
  if (t === 'Bash') { const d = str(i.description), c = str(i.command); return clip(d && c ? `${d} · ${c}` : d || c); }
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit') {
    const p = str(i.file_path || i.notebook_path);
    let a = 0, r = 0;
    if (t === 'Write') a = lines(i.content);
    else if (t === 'NotebookEdit') a = lines(i.new_source);
    else for (const e of (t === 'MultiEdit' ? (Array.isArray(i.edits) ? i.edits : []) : [i])) { if (e && typeof e === 'object') { r += lines(e.old_string); a += lines(e.new_string); } }
    return clip(`${p} (+${a} -${r})`);
  }
  if (t === 'Read') return clip(i.file_path);
  if (t === 'Grep' || t === 'Glob') return clip(str(i.pattern) + (i.path ? ` · ${str(i.path)}` : ''));
  if (t === 'WebFetch') return clip(i.url);
  if (t === 'WebSearch') return clip(i.query);
  if (t === 'Task' || t === 'Agent') return clip(str(i.description) || str(i.subagent_type));
  let json = ''; try { json = JSON.stringify(i); } catch { json = ''; }
  return clip(json === '{}' ? '' : json);
}

function entryFromRecord(rec) {
  const ev = rec && rec.ev && typeof rec.ev === 'object' ? rec.ev : null;
  if (!ev || typeof ev.session_id !== 'string' || !ev.session_id) return null;
  const e = GEMINI_EVENTS[ev.hook_event_name] || ev.hook_event_name;
  if (!KNOWN.has(e)) return null;
  const at = Number(rec.ts) * 1000;
  if (!Number.isFinite(at) || at <= 0) return null;
  const x = { at, e };
  if (ev.agent_id) x.sub = str(ev.agent_id).slice(0, 80);
  switch (e) {
    case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionRequest': case 'PermissionDenied':
      x.tool = str(ev.tool_name).slice(0, 80) || '?';
      if (ev.tool_use_id) x.tuid = str(ev.tool_use_id).slice(0, 120);
      x.detail = toolSummary(ev.tool_name, ev.tool_input);
      if (e === 'PostToolUseFailure') x.err = clip(ev.error || ev.error_message || '');
      if (e === 'PermissionDenied') x.err = clip(ev.reason || '');
      break;
    case 'UserPromptSubmit': x.detail = clip(ev.prompt); break;
    case 'SubagentStart': case 'SubagentStop': x.label = clip(ev.agent_type || 'agent', 60); break;
    case 'StopFailure': x.detail = clip(ev.error_details || ev.error || ev.last_assistant_message || 'unknown'); break;
    case 'TaskCreated': case 'TaskCompleted': x.label = clip(ev.task_id, 40); x.detail = clip(ev.task_subject || ev.task_description || ''); break;
    case 'PreCompact': x.label = ev.trigger === 'auto' ? 'auto' : 'manual'; break;
    case 'SessionStart': x.detail = clip(ev.source || '', 40); break;
    case 'SessionEnd': x.detail = clip(ev.reason || '', 40); break;
  }
  return x;
}

// per-session ring (newest `max` entries), least recently updated session evicted past `sessions`
function createIndex(opts) {
  const max = (opts && opts.max) || MAX_EVENTS, maxSessions = (opts && opts.sessions) || 100;
  const map = new Map();   // sid → { list, dropped }
  return {
    add(rec) {
      const x = entryFromRecord(rec); if (!x) return false;
      const sid = rec.ev.session_id;
      let s = map.get(sid);
      if (s) map.delete(sid);
      else { s = { list: [], dropped: false }; if (map.size >= maxSessions) map.delete(map.keys().next().value); }
      map.set(sid, s);   // re-insert: Map order = least recently updated first
      s.list.push(x);
      if (s.list.length > max) { s.list.splice(0, s.list.length - max); s.dropped = true; }
      return true;
    },
    get(sid) { const s = map.get(sid); return s ? { entries: s.list.slice(), truncated: s.dropped } : null; },
    clear() { map.clear(); },
    size() { return map.size; },
  };
}

function buildModel(entries, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(MAX_EVENTS, o.limit || MAX_EVENTS));
  let list = (Array.isArray(entries) ? entries : []).filter(x => x && Number.isFinite(x.at) && KNOWN.has(x.e));
  list = list.map((x, i) => [x, i]).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(p => p[0]);   // stable: file order within a second
  let truncated = !!o.truncated;
  if (list.length > limit) { list = list.slice(list.length - limit); truncated = true; }
  const events = [], subs = [], waits = [];
  const key = x => x.sub || '';
  const pending = [];    // { x, ev } PreToolUse without a Post yet
  const orphans = [];    // Post without a Pre yet (logged out of order)
  const subOpen = new Map(), permOpen = new Map();
  let waitFrom = null;
  const finish = (ev, post) => {
    ev.dur = Math.max(0, post.at - ev.at); ev.ok = post.e !== 'PostToolUseFailure';
    if (!ev.ok && post.err) ev.err = post.err;
    if (!ev.detail && post.detail) ev.detail = post.detail;
    delete ev.open;
  };
  const sameCall = (a, b) => (a.tuid && b.tuid) ? a.tuid === b.tuid : key(a) === key(b) && a.tool === b.tool;
  const closePerm = (k, at, state) => {
    const p = permOpen.get(k); if (!p) return;
    permOpen.delete(k);
    p.ev.state = state; p.ev.dur = Math.max(0, at - p.ev.at);
    waits.push({ kind: 'perm', start: p.ev.at, end: at, ev: p.ev });
  };
  for (const x of list) {
    const k = key(x);
    switch (x.e) {
      case 'PreToolUse': {
        if (permOpen.has(k) && x.at > permOpen.get(k).ev.at) closePerm(k, x.at, 'allowed');
        const ev = { at: x.at, kind: 'tool', label: x.tool, detail: x.detail || '', open: true };
        if (x.sub) ev.sub = x.sub;
        events.push(ev);
        const j = orphans.findIndex(p => sameCall(p, x) && Math.abs(p.at - x.at) <= PAIR_SKEW_MS);
        if (j >= 0) { finish(ev, orphans[j]); orphans.splice(j, 1); }
        else pending.push({ x, ev });
        break;
      }
      case 'PostToolUse': case 'PostToolUseFailure': {
        if (permOpen.has(k)) closePerm(k, x.at, 'allowed');
        let j = -1;
        if (x.tuid) j = pending.findIndex(p => p.x.tuid === x.tuid);
        if (j < 0) for (let n = pending.length - 1; n >= 0; n--) { const p = pending[n]; if ((!p.x.tuid || !x.tuid) && key(p.x) === k && p.x.tool === x.tool) { j = n; break; } }
        if (j >= 0) { finish(pending[j].ev, x); pending.splice(j, 1); }
        else orphans.push(x);
        break;
      }
      case 'PermissionRequest': {
        if (permOpen.has(k)) closePerm(k, x.at, 'ask');
        const ev = { at: x.at, kind: 'permission', label: x.tool, detail: x.detail || '', state: 'ask' };
        if (x.sub) ev.sub = x.sub;
        events.push(ev); permOpen.set(k, { ev });
        break;
      }
      case 'PermissionDenied': {
        if (permOpen.has(k)) { const p = permOpen.get(k); closePerm(k, x.at, 'denied'); if (x.err) p.ev.err = x.err; break; }
        const ev = { at: x.at, kind: 'permission', label: x.tool, detail: x.detail || '', state: 'denied' };
        if (x.err) ev.err = x.err; if (x.sub) ev.sub = x.sub;
        events.push(ev);
        break;
      }
      case 'UserPromptSubmit':
        if (waitFrom != null) { waits.push({ kind: 'user', start: waitFrom, end: x.at }); waitFrom = null; }
        for (const kk of [...permOpen.keys()]) closePerm(kk, x.at, 'ask');
        events.push({ at: x.at, kind: 'prompt', label: '', detail: x.detail || '' });
        break;
      case 'Stop': case 'StopFailure':
        if (permOpen.has('')) closePerm('', x.at, 'ask');
        if (waitFrom == null) waitFrom = x.at;
        events.push(x.e === 'Stop' ? { at: x.at, kind: 'stop', label: '' } : { at: x.at, kind: 'stop-failure', label: '', detail: x.detail || '' });
        break;
      case 'SubagentStart': {
        const id = x.sub || ''; const ev = { at: x.at, kind: 'subagent', label: x.label || 'agent', state: 'start' };
        if (id) { ev.sub = id; subOpen.set(id, { start: x.at, label: ev.label }); }
        events.push(ev);
        break;
      }
      case 'SubagentStop': {
        const id = x.sub || ''; const o2 = subOpen.get(id);
        const ev = { at: x.at, kind: 'subagent', label: (o2 && o2.label) || x.label || 'agent', state: 'stop' };
        if (id) ev.sub = id;
        if (o2) { subOpen.delete(id); ev.dur = Math.max(0, x.at - o2.start); subs.push({ sub: id, label: o2.label, start: o2.start, end: x.at, open: false }); }
        if (permOpen.has(id)) closePerm(id, x.at, 'ask');
        events.push(ev);
        break;
      }
      case 'PreCompact': events.push({ at: x.at, kind: 'compact', label: x.label || 'manual', state: 'start' }); break;
      case 'PostCompact': events.push({ at: x.at, kind: 'compact', label: '', state: 'done' }); break;
      case 'TaskCreated': case 'TaskCompleted':
        events.push({ at: x.at, kind: 'task', label: x.label || '', detail: x.detail || '', state: x.e === 'TaskCreated' ? 'created' : 'completed' }); break;
      case 'SessionStart': events.push({ at: x.at, kind: 'session', label: '', detail: x.detail || '', state: 'start' }); break;
      case 'SessionEnd':
        waitFrom = null;
        for (const kk of [...permOpen.keys()]) closePerm(kk, x.at, 'ask');
        events.push({ at: x.at, kind: 'session', label: '', detail: x.detail || '', state: 'end' });
        break;
    }
  }
  // a Post whose Pre never came (rotated away or not logged): shown at its own time, length unknown
  for (const x of orphans) {
    const ev = { at: x.at, kind: 'tool', label: x.tool, detail: x.detail || '', ok: x.e !== 'PostToolUseFailure', orphan: true };
    if (x.err && !ev.ok) ev.err = x.err; if (x.sub) ev.sub = x.sub;
    events.push(ev);
  }
  events.sort((a, b) => a.at - b.at);   // stable: orphans go after events of the same second
  const span = list.length ? { start: list[0].at, end: list[list.length - 1].at } : { start: 0, end: 0 };
  for (const [id, s] of subOpen) subs.push({ sub: id, label: s.label, start: s.start, end: span.end, open: true });
  subs.sort((a, b) => a.start - b.start);
  const rowEnds = [];
  for (const s of subs) {
    let r = rowEnds.findIndex(e => e <= s.start);
    if (r < 0) { r = rowEnds.length; rowEnds.push(s.end); } else rowEnds[r] = s.end;
    s.row = r;
  }
  const index = new Map(events.map((e, i) => [e, i]));
  for (const w of waits) { if (w.ev) { w.i = index.get(w.ev); delete w.ev; } }
  waits.sort((a, b) => a.start - b.start);
  // stats
  const byTool = new Map(); let toolCalls = 0, toolFails = 0, turns = 0;
  const subIds = new Set();
  for (const e of events) {
    if (e.kind === 'prompt') turns++;
    if (e.kind === 'subagent' && e.state === 'start') subIds.add(e.sub || `#${e.at}`);
    if (e.kind !== 'tool') continue;
    toolCalls++;
    const t = byTool.get(e.label) || { tool: e.label, n: 0, ms: 0, fail: 0 };
    t.n++; t.ms += e.dur || 0; if (e.ok === false) { t.fail++; toolFails++; }
    byTool.set(e.label, t);
  }
  const userWaitMs = waits.filter(w => w.kind === 'user').reduce((a, w) => a + (w.end - w.start), 0);
  const permW = waits.filter(w => w.kind === 'perm');
  const slowest = events.map((e, i) => [e, i]).filter(([e]) => e.kind === 'tool' && e.dur > 0).sort((a, b) => b[0].dur - a[0].dur).slice(0, 5).map(([, i]) => i);
  const stats = {
    turns, toolCalls, toolFails, subagents: subIds.size, userWaitMs, permWaitMs: permW.reduce((a, w) => a + (w.end - w.start), 0), permAsks: events.filter(e => e.kind === 'permission' && e.state !== 'denied').length,
    byTool: [...byTool.values()].sort((a, b) => b.n - a.n || b.ms - a.ms), slowest,
  };
  // the log does not reach back to the session's start: rotated away, cut by the ring, or the session began earlier
  const noEarlier = truncated || !list.length || list[0].e !== 'SessionStart';
  return { events, span, truncated, noEarlier, subs, waits, stats };
}

const AgentDeskTimeline = { MAX_EVENTS, DETAIL_MAX, KNOWN, clip, toolSummary, entryFromRecord, createIndex, buildModel };
root.AgentDeskTimeline = AgentDeskTimeline;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskTimeline;
})(typeof globalThis !== 'undefined' ? globalThis : this);
