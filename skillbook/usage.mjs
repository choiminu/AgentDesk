// Skillbook usage counts: a small JSON store fed by the hook feed (live) and a one-time transcript backfill.
import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../perm/settings.mjs';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook

const { usageFromRecord, usageFromTranscriptLine } = globalThis.AgentDeskSkillbook;
const KEEP_DAYS = 60;
const REPO_KEEP_MS = 30 * 86400e3;  // repos: sessions seen in the last 30 days
const REPO_MAX = 500;
const FEED_WINDOW_MS = 120e3;       // hook records may be appended a little out of order: keys are kept this long behind the mark
const FEED_KEYS_MAX = 5000;
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

const nullo = () => Object.create(null); // user-influenced names ("__proto__", "constructor") must stay plain data
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const minDayOf = now => dayKey(now - KEEP_DAYS * 86400e3);
const TOOLS_MAX = 30;                 // MCP tool names kept per server (names only: what the skillbook shows as "사용한 도구")
const TOOL_RE = /^[\w.-]{1,128}$/;
function addTool(e, tool) {
  if (typeof tool !== 'string' || !TOOL_RE.test(tool)) return;
  if (!e.tools) e.tools = [];
  if (e.tools.length < TOOLS_MAX && !e.tools.includes(tool)) e.tools.push(tool);
}

function bump(keys, u, minDay) {
  let e = keys[u.key];
  if (!e) { e = keys[u.key] = { total: 0, byDay: nullo(), lastAt: 0, lastRepo: '', byAgent: nullo() }; }
  e.total++;
  const d = dayKey(u.at);
  if (d >= minDay) e.byDay[d] = (e.byDay[d] || 0) + 1;
  if (u.at >= e.lastAt) { e.lastAt = u.at; e.lastRepo = u.repo || ''; }
  const a = String(u.agent || 'claude');
  e.byAgent[a] = (e.byAgent[a] || 0) + 1;
  if (u.kind === 'mcp') addTool(e, u.tool);
}
function prune(keys, minDay) {
  for (const e of Object.values(keys)) for (const d of Object.keys(e.byDay)) if (d < minDay) delete e.byDay[d];
}
function merge(keys, add) {
  for (const [k, s] of Object.entries(add)) {
    const e = keys[k];
    if (!e) { keys[k] = s; continue; }
    e.total += s.total;
    for (const [d, n] of Object.entries(s.byDay)) e.byDay[d] = (e.byDay[d] || 0) + n;
    for (const [a, n] of Object.entries(s.byAgent)) e.byAgent[a] = (e.byAgent[a] || 0) + n;
    if (s.lastAt >= e.lastAt) { e.lastAt = s.lastAt; e.lastRepo = s.lastRepo; }
    for (const t of s.tools || []) addTool(e, t);
  }
}
// repair one loaded entry; null when nothing usable is left
// one hook record's identity: the same record read twice (re-read after the log was trimmed, or after a restart) has the same key
function recordKey(rec) {
  const ev = rec.ev;
  const sid = typeof ev.session_id === 'string' ? ev.session_id : '';
  const ext = typeof ev.tool_use_id === 'string' && ev.tool_use_id ? ev.tool_use_id
    : createHash('sha256').update(JSON.stringify([ev.tool_name ?? null, ev.tool_input ?? null, ev.prompt ?? null])).digest('hex').slice(0, 16);
  return `${rec.ts}|${String(rec.agent || 'claude')}|${sid}|${ev.hook_event_name}|${ext}`;
}
function emptyFed() { return { at: 0, keys: nullo() }; }
function sanitizeFed(f) {
  const out = emptyFed();
  if (!isObj(f)) return out;
  out.at = num(f.at);
  if (isObj(f.keys)) for (const [k, at] of Object.entries(f.keys)) if (num(at) > out.at - FEED_WINDOW_MS) out.keys[k] = num(at);
  return out;
}
function sanitizeRepos(r) {
  const out = nullo();
  if (isObj(r)) for (const [p, at] of Object.entries(r)) if (p && num(at) > 0) out[p] = num(at);
  return out;
}
function pruneRepos(repos, nowMs) {
  const live = Object.entries(repos).filter(([, at]) => at >= nowMs - REPO_KEEP_MS).sort((a, b) => b[1] - a[1]).slice(0, REPO_MAX);
  const out = nullo();
  for (const [p, at] of live) out[p] = at;
  return out;
}

function sanitize(e) {
  if (!isObj(e)) return null;
  const out = { total: num(e.total), byDay: nullo(), lastAt: num(e.lastAt), lastRepo: typeof e.lastRepo === 'string' ? e.lastRepo : '', byAgent: nullo() };
  if (isObj(e.byDay)) for (const [d, n] of Object.entries(e.byDay)) if (DAY_RE.test(d) && num(n) > 0) out.byDay[d] = num(n);
  if (isObj(e.byAgent)) for (const [a, n] of Object.entries(e.byAgent)) if (num(n) > 0) out.byAgent[a] = num(n);
  if (Array.isArray(e.tools)) for (const t of e.tools) addTool(out, t);
  return out.total > 0 ? out : null;
}

const freshState = () => ({ v: 1, cutoff: null, backfilled: false, keys: nullo(), fed: emptyFed(), repos: nullo() });

export function createUsageStore({ file, now = Date.now }) {
  let st = freshState();
  const store = {
    load() {
      st = freshState();
      if (!existsSync(file)) return;
      try {
        const o = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObj(o) || !isObj(o.keys)) return;
        const keys = nullo();
        for (const [k, e] of Object.entries(o.keys)) { const c = sanitize(e); if (c) keys[k] = c; }
        st = { v: 1, cutoff: Number.isFinite(o.cutoff) ? o.cutoff : null, backfilled: o.backfilled === true, keys, fed: sanitizeFed(o.fed), repos: sanitizeRepos(o.repos) };
      } catch { /* unreadable store: start empty */ }
    },
    add(u) { if (u && u.key) bump(st.keys, u, minDayOf(now())); },
    addRecord(rec) {
      const us = usageFromRecord(rec);
      if (!us.length) return;
      const minDay = minDayOf(now());
      for (const u of us) if (st.cutoff == null || u.at > st.cutoff) bump(st.keys, u, minDay);
    },
    // live hook feed, counted exactly once: a record is taken when it is newer than the newest fed record minus a short
    // window and its key was not fed before (keys inside the window are saved with the store). → true when counted
    feedRecord(rec) {
      const us = usageFromRecord(rec);
      if (!us.length) return false;
      const at = us[0].at, f = st.fed, key = recordKey(rec);
      if (at <= f.at - FEED_WINDOW_MS || f.keys[key] != null) return false;
      f.keys[key] = at;
      if (at > f.at) f.at = at;
      const keys = Object.keys(f.keys);
      if (at === f.at || keys.length > FEED_KEYS_MAX) for (const k of keys) if (f.keys[k] <= f.at - FEED_WINDOW_MS) delete f.keys[k];
      const minDay = minDayOf(now());
      for (const u of us) if (st.cutoff == null || u.at > st.cutoff) bump(st.keys, u, minDay);
      return true;
    },
    // repo folders of recent sessions (hook record cwds, transcript cwds); kept 30 days
    noteRepo(path, at) {
      if (typeof path !== 'string' || !path || path.length > 4096 || !(num(at) > 0)) return;
      if (!(st.repos[path] >= at)) st.repos[path] = at;
    },
    repos() { return Object.keys(pruneRepos(st.repos, now())).sort(); },
    save() { prune(st.keys, minDayOf(now())); st.repos = pruneRepos(st.repos, now()); writeJsonAtomic(file, st); },
    get(key) { return st.keys[key] || null; },
    keys() { return Object.keys(st.keys); },
    cutoff: () => st.cutoff,
    backfillDone: () => st.backfilled === true,
    // internals for backfill()
    // fed marks and repos stay: they are not counts
    _begin(cutoff) { st.keys = nullo(); st.cutoff = cutoff; st.backfilled = false; store.save(); },
    _finish(fresh, complete) { merge(st.keys, fresh); st.backfilled = complete; store.save(); },
    _now: now,
    _inflight: null,
  };
  return store;
}

function jsonlFiles(root) {
  const out = [];
  let dirs; try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs.sort()) {
    const dir = join(root, d);
    let names; try { if (!statSync(dir).isDirectory()) continue; names = readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) if (n.endsWith('.jsonl')) out.push(join(dir, n));
  }
  return out;
}

export function backfill(store, opts) {
  if (store._inflight) return store._inflight; // overlapping call: share the running one
  const p = runBackfill(store, opts).finally(() => { store._inflight = null; });
  store._inflight = p;
  return p;
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

async function runBackfill(store, { roots, cutoff, onProgress }) {
  store._begin(cutoff); // fresh keys + fixed cutoff; backfilled stays false until the end
  const fresh = nullo();
  const minDay = minDayOf(store._now());
  const files = roots.flatMap(jsonlFiles);
  let uses = 0, done = 0, skipped = 0;
  for (const f of files) {
    let cwd = '';
    try {
      const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        if (!cwd) { const m = CWD_RE.exec(line); if (m) { try { cwd = JSON.parse(`"${m[1]}"`); } catch { /* odd escape: try the next line */ } } }
        for (const u of usageFromTranscriptLine(line)) if (u.at <= cutoff) { bump(fresh, u, minDay); uses++; }
      }
      if (cwd) store.noteRepo(cwd, statSync(f).mtimeMs); // the session's folder, as of its last write
    } catch (e) { if (!e || e.code !== 'ENOENT') skipped++; } // vanished file is fine; anything else leaves the backfill unfinished
    done++;
    if (onProgress) { try { onProgress({ files: done, total: files.length, uses }); } catch {} }
    await new Promise(r => setImmediate(r)); // let the main thread breathe between files
  }
  store._finish(fresh, skipped === 0);
  return { files: files.length, uses, skipped };
}
