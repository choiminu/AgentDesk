// Daily numbers: a small JSON store (~/.roca/daily.json) fed by the hook feed, one object per day (core/daily.js).
// Numbers and command families only. The events log is re-read from the start on every launch and after the hook
// trims it, so a record is counted once: newer than the newest fed record minus a short window, and its key not fed
// before (the same rule as skillbook/usage.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../perm/settings.mjs';
import '../core/play.js';    // isTestCmd / failCount, used by core/daily.js
import '../core/daily.js';   // classic script: sets globalThis.AgentDeskDaily

const { createFolder, dayKey } = globalThis.AgentDeskDaily;
const KEEP_DAYS = 400;
const FEED_WINDOW_MS = 120e3, FEED_KEYS_MAX = 5000;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function recordKey(rec) {
  const ev = rec.ev;
  const ext = typeof ev.tool_use_id === 'string' && ev.tool_use_id ? ev.tool_use_id
    : createHash('sha256').update(JSON.stringify([ev.tool_name ?? null, ev.tool_input ?? null, ev.prompt ?? null])).digest('hex').slice(0, 16);
  return `${rec.ts}|${String(rec.agent || 'claude')}|${typeof ev.session_id === 'string' ? ev.session_id : ''}|${ev.hook_event_name}|${ext}`;
}

export function createDailyStore({ file, now = Date.now }) {
  let folder = createFolder(), fed = { at: 0, keys: Object.create(null) };
  return {
    load() {
      folder = createFolder(); fed = { at: 0, keys: Object.create(null) };
      if (!existsSync(file)) return;
      try {
        const o = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObj(o)) return;
        folder = createFolder(isObj(o.days) ? o.days : {});
        if (isObj(o.fed)) { fed.at = num(o.fed.at); if (isObj(o.fed.keys)) for (const [k, at] of Object.entries(o.fed.keys)) if (num(at) > fed.at - FEED_WINDOW_MS) fed.keys[k] = num(at); }
      } catch { /* unreadable store: start empty */ }
    },
    // → true when the record was counted
    feed(rec) {
      const ev = rec && rec.ev, at = rec && typeof rec.ts === 'number' ? rec.ts * 1000 : NaN;
      if (!isObj(ev) || !Number.isFinite(at) || at <= 0) return false;
      const key = recordKey(rec);
      if (at <= fed.at - FEED_WINDOW_MS || fed.keys[key] != null) return false;
      fed.keys[key] = at;
      if (at > fed.at) fed.at = at;
      const keys = Object.keys(fed.keys);
      if (at === fed.at || keys.length > FEED_KEYS_MAX) for (const k of keys) if (fed.keys[k] <= fed.at - FEED_WINDOW_MS) delete fed.keys[k];
      return folder.fold(rec);
    },
    days() { return folder.days(); },
    save() { folder.prune(dayKey(now() - KEEP_DAYS * 86400e3)); writeJsonAtomic(file, { v: 1, days: folder.days(), fed }); },
  };
}
