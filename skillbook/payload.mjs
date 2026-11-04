// Skillbook IPC payload: inventory items + usage counts + the actions each item supports. Pure (no fs, no electron).
//   skillbookPayload({ inventory: scanInventory(), store: createUsageStore(), removed: listRemoved(), now })
//   → { ok: true, items: [{ ...item, uses, can }], sources, removed: [{ ...row, can }], backfill: 'running'|'done' }
// Usage is read per item by its usageKey only, so stray keys in the store (e.g. "Users" from a prompt that starts
// with "/Users/...") never reach the renderer. Items carry the scan's non-secret fields only (see scan.mjs).
import { basename, dirname } from 'node:path';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook

const { mastery, weekCount } = globalThis.AgentDeskSkillbook;
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const UNCOUNTED = ['codex', 'gemini']; // no hook / transcript feed for these agents' skill or MCP use

// uses over the last `days` local days including today
function daysCount(byDay, now, days) {
  let sum = 0;
  const base = new Date(now);
  for (let i = 0; i < days; i++) sum += (byDay && byDay[dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i))]) || 0;
  return sum;
}

function usesOf(item, store, now) {
  const agents = Array.isArray(item.agents) ? item.agents : [];
  const counted = agents.some(a => !UNCOUNTED.includes(a));
  const e = counted && store && typeof item.usageKey === 'string' && item.usageKey ? store.get(item.usageKey) : null;
  if (!e) return { week: 0, month: 0, total: 0, mastery: 0, counted };
  const month = daysCount(e.byDay, now, 30);
  const out = { week: weekCount(e.byDay, now), month, total: e.total || 0, mastery: mastery(month), counted };
  if (e.lastAt) out.lastAt = e.lastAt;
  if (e.lastRepo) out.lastRepo = e.lastRepo;
  if (e.byAgent && Object.keys(e.byAgent).length) out.byAgent = { ...e.byAgent };
  return out;
}

// which actions actOn (and the reveal IPC) can do for this item; mirrors the checks in actions.mjs
function canOf(item) {
  const path = typeof item.path === 'string' && item.path ? item.path : '';
  const can = { off: false, on: false, remove: false, restore: false, reveal: !!path };
  if (item.kind === 'skill') {
    if (item.plugin || !path) return can;
    const parent = basename(dirname(path));
    const root = basename(dirname(dirname(path)));
    const home = (item.source === 'user' || item.source === 'shared') && (root === '.claude' || root === '.agents');
    can.off = home && parent === 'skills' && item.on !== false;
    can.on = home && parent === 'skills-disabled' && item.on === false;
    can.remove = parent === 'skills' || parent === 'skills-disabled';
  } else if (item.kind === 'plugin') {
    if (item.source === 'extension' || !(item.agents || []).includes('claude')) return can;
    can.off = item.on !== false;
    can.on = item.on === false;
    can.remove = true;
  } else if (item.kind === 'mcp') {
    can.off = item.on !== false;
    can.on = item.on === false;
    can.remove = true;
  }
  return can;
}

export function skillbookPayload({ inventory, store, removed, now = Date.now() } = {}) {
  const inv = inventory && typeof inventory === 'object' ? inventory : {};
  const items = (Array.isArray(inv.items) ? inv.items : []).map(it => ({ ...it, uses: usesOf(it, store, now), can: canOf(it) }));
  // actOn restores MCP entries (written back) and plugins (claude plugin install); trashed skills come back from the OS trash
  const rows = (Array.isArray(removed) ? removed : []).map(r => ({ ...r, can: { restore: r.kind === 'mcp' || r.kind === 'plugin' } }));
  return {
    ok: true,
    items,
    sources: Array.isArray(inv.sources) ? inv.sources : [],
    removed: rows,
    backfill: store && typeof store.backfillDone === 'function' && store.backfillDone() ? 'done' : 'running',
  };
}
