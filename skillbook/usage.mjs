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

function bump(keys, u, now) {
  const e = keys[u.key] || (keys[u.key] = { total: 0, byDay: {}, lastAt: 0, lastRepo: '', byAgent: {} });
  e.total++;
  const d = dayKey(u.at);
  if (d >= dayKey(now - KEEP_DAYS * 86400e3)) e.byDay[d] = (e.byDay[d] || 0) + 1;
  if (u.at >= e.lastAt) { e.lastAt = u.at; e.lastRepo = u.repo || ''; }
  const a = u.agent || 'claude';
  e.byAgent[a] = (e.byAgent[a] || 0) + 1;
}
function prune(keys, now) {
  const min = dayKey(now - KEEP_DAYS * 86400e3);
  for (const e of Object.values(keys)) for (const d of Object.keys(e.byDay)) if (d < min) delete e.byDay[d];
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

export function createUsageStore({ file, now = Date.now }) {
  let st = { v: 1, cutoff: null, backfilled: false, keys: {} };
  const store = {
    load() {
      st = { v: 1, cutoff: null, backfilled: false, keys: {} };
      if (!existsSync(file)) return;
      try {
        const o = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObj(o) || !isObj(o.keys)) return;
        st = { v: 1, cutoff: Number.isFinite(o.cutoff) ? o.cutoff : null, backfilled: o.backfilled === true, keys: o.keys };
      } catch { /* unreadable store: start empty */ }
    },
    add(u) { if (u && u.key) bump(st.keys, u, now()); },
    addRecord(rec) {
      for (const u of usageFromRecord(rec)) if (st.cutoff == null || u.at > st.cutoff) store.add(u);
    },
    save() { prune(st.keys, now()); writeJsonAtomic(file, st); },
    get(key) { return Object.prototype.hasOwnProperty.call(st.keys, key) ? st.keys[key] : null; },
    cutoff: () => st.cutoff,
    backfillDone: () => st.backfilled === true,
    // internals for backfill()
    _begin(cutoff) { st.keys = {}; st.cutoff = cutoff; st.backfilled = false; store.save(); },
    _finish(fresh) { merge(st.keys, fresh); st.backfilled = true; store.save(); },
    _now: now,
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

export async function backfill(store, { roots, cutoff, onProgress }) {
  store._begin(cutoff); // fresh keys + fixed cutoff; backfilled stays false until the end
  const fresh = {};
  const files = roots.flatMap(jsonlFiles);
  let uses = 0, done = 0;
  for (const f of files) {
    try {
      const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        for (const u of usageFromTranscriptLine(line)) if (u.at <= cutoff) { bump(fresh, u, store._now()); uses++; }
      }
    } catch { /* unreadable transcript: skip */ }
    done++;
    if (onProgress) { try { onProgress({ files: done, total: files.length, uses }); } catch {} }
    await new Promise(r => setImmediate(r)); // let the main thread breathe between files
  }
  store._finish(fresh);
  return { files: files.length, uses };
}
