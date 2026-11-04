// Skillbook usage counts: a small JSON store fed by the hook feed (live) and a one-time transcript backfill.
import { existsSync, readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { writeJsonAtomic } from '../perm/settings.mjs';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook

const { usageFromRecord, usageFromTranscriptLine } = globalThis.AgentDeskSkillbook;
const KEEP_DAYS = 60;
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

const nullo = () => Object.create(null); // user-influenced names ("__proto__", "constructor") must stay plain data
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const minDayOf = now => dayKey(now - KEEP_DAYS * 86400e3);

function bump(keys, u, minDay) {
  let e = keys[u.key];
  if (!e) { e = keys[u.key] = { total: 0, byDay: nullo(), lastAt: 0, lastRepo: '', byAgent: nullo() }; }
  e.total++;
  const d = dayKey(u.at);
  if (d >= minDay) e.byDay[d] = (e.byDay[d] || 0) + 1;
  if (u.at >= e.lastAt) { e.lastAt = u.at; e.lastRepo = u.repo || ''; }
  const a = String(u.agent || 'claude');
  e.byAgent[a] = (e.byAgent[a] || 0) + 1;
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
  }
}
// repair one loaded entry; null when nothing usable is left
function sanitize(e) {
  if (!isObj(e)) return null;
  const out = { total: num(e.total), byDay: nullo(), lastAt: num(e.lastAt), lastRepo: typeof e.lastRepo === 'string' ? e.lastRepo : '', byAgent: nullo() };
  if (isObj(e.byDay)) for (const [d, n] of Object.entries(e.byDay)) if (DAY_RE.test(d) && num(n) > 0) out.byDay[d] = num(n);
  if (isObj(e.byAgent)) for (const [a, n] of Object.entries(e.byAgent)) if (num(n) > 0) out.byAgent[a] = num(n);
  return out.total > 0 ? out : null;
}

export function createUsageStore({ file, now = Date.now }) {
  let st = { v: 1, cutoff: null, backfilled: false, keys: nullo() };
  const store = {
    load() {
      st = { v: 1, cutoff: null, backfilled: false, keys: nullo() };
      if (!existsSync(file)) return;
      try {
        const o = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObj(o) || !isObj(o.keys)) return;
        const keys = nullo();
        for (const [k, e] of Object.entries(o.keys)) { const c = sanitize(e); if (c) keys[k] = c; }
        st = { v: 1, cutoff: Number.isFinite(o.cutoff) ? o.cutoff : null, backfilled: o.backfilled === true, keys };
      } catch { /* unreadable store: start empty */ }
    },
    add(u) { if (u && u.key) bump(st.keys, u, minDayOf(now())); },
    addRecord(rec) {
      const us = usageFromRecord(rec);
      if (!us.length) return;
      const minDay = minDayOf(now());
      for (const u of us) if (st.cutoff == null || u.at > st.cutoff) bump(st.keys, u, minDay);
    },
    save() { prune(st.keys, minDayOf(now())); writeJsonAtomic(file, st); },
    get(key) { return st.keys[key] || null; },
    cutoff: () => st.cutoff,
    backfillDone: () => st.backfilled === true,
    // internals for backfill()
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

async function runBackfill(store, { roots, cutoff, onProgress }) {
  store._begin(cutoff); // fresh keys + fixed cutoff; backfilled stays false until the end
  const fresh = nullo();
  const minDay = minDayOf(store._now());
  const files = roots.flatMap(jsonlFiles);
  let uses = 0, done = 0, skipped = 0;
  for (const f of files) {
    try {
      const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        for (const u of usageFromTranscriptLine(line)) if (u.at <= cutoff) { bump(fresh, u, minDay); uses++; }
      }
    } catch (e) { if (!e || e.code !== 'ENOENT') skipped++; } // vanished file is fine; anything else leaves the backfill unfinished
    done++;
    if (onProgress) { try { onProgress({ files: done, total: files.length, uses }); } catch {} }
    await new Promise(r => setImmediate(r)); // let the main thread breathe between files
  }
  store._finish(fresh, skipped === 0);
  return { files: files.length, uses, skipped };
}
