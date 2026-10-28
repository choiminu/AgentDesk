// AgentDesk core: plan-limit burn forecast and per-ticket cost roll-up, shared by the renderer (classic <script>)
// and the tests (CommonJS). Pure functions only — no DOM, no Electron, no LLM calls.
//
//   forecast(samples, limit, now, resetAt) → { ratePerHour, etaMs, confidence, resetAt, reason, used, samples }
//   thresholdCrossed(prevPct, curPct, levels, fired, opts) → { crossed: [level…], fired: [level…] }
//   ticketCosts(sessions, dispatchMap)    → { KEY: { cost, sessions: [id…], since, unknown } }
//   formatEta(ms, lang)                   → "약 1시간 40분 뒤" | "20분 뒤" | "리셋 전 도달 안 함"
//   fromStatusline(rec, now)              → { claude: { session, weekly, updatedAt } } | null — ~/.roca/usage.json
//                                           (written by the status line relay, statusline/relay.cjs) in the shape of
//                                           Orca's rateLimits; null once any window reset since it was written,
//                                           a window written longer ago than it lasts is dropped
(function (root) {
'use strict';
const WINDOW_MS = 30 * 60 * 1000;   // the burn rate is read from the last 30 minutes only
const RESET_DROP = 2;               // a drop of more than this many points means the window was reset

// samples: [{ at, used }] (epoch ms, percent). Linear regression over the recent window; samples before the last
// reset (a clear drop in `used`) are ignored. etaMs is null when there is no upward trend, too few samples, or the
// window resets before the limit would be reached (reason tells which).
function forecast(samples, limit, now, resetAt) {
  limit = Number(limit) > 0 ? Number(limit) : 100;
  now = Number(now) || Date.now();
  resetAt = Number(resetAt) > 0 ? Number(resetAt) : null;
  let pts = (Array.isArray(samples) ? samples : [])
    .filter(s => s && Number.isFinite(Number(s.at)) && Number.isFinite(Number(s.used)) && Number(s.at) <= now && now - Number(s.at) <= WINDOW_MS)
    .map(s => ({ at: Number(s.at), used: Number(s.used) }))
    .sort((a, b) => a.at - b.at);
  for (let i = pts.length - 1; i > 0; i--) if (pts[i - 1].used - pts[i].used > RESET_DROP) { pts = pts.slice(i); break; }
  const used = pts.length ? pts[pts.length - 1].used : null;
  const out = { ratePerHour: 0, etaMs: null, confidence: 'low', resetAt, reason: null, used, samples: pts.length };
  if (pts.length < 2) { out.reason = 'few-samples'; return out; }
  const n = pts.length, t0 = pts[0].at;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += (p.at - t0) / 3600000; sy += p.used; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = (p.at - t0) / 3600000 - mx, dy = p.used - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx <= 0) { out.reason = 'few-samples'; return out; }
  const slope = sxy / sxx;   // percent per hour
  out.ratePerHour = Math.round(slope * 100) / 100;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const spanMin = (pts[n - 1].at - t0) / 60000;
  out.confidence = n >= 10 && spanMin >= 10 && r2 >= 0.8 ? 'high' : n >= 5 && spanMin >= 5 && r2 >= 0.5 ? 'mid' : 'low';
  if (used >= limit) { out.etaMs = 0; return out; }
  if (!(slope > 0.01)) { out.reason = 'flat'; return out; }
  const eta = Math.round(((limit - used) / slope) * 3600000);
  if (resetAt && now + eta >= resetAt) { out.reason = 'after-reset'; return out; }
  out.etaMs = eta;
  return out;
}

// Upward crossings only. `fired` holds levels already announced in this window; a level re-arms once usage falls
// below it by `hysteresis` points or when the caller signals a window reset (opts.reset).
function thresholdCrossed(prevPct, curPct, levels, fired, opts) {
  levels = (Array.isArray(levels) && levels.length ? levels : [80, 95]).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const hysteresis = opts && Number.isFinite(opts.hysteresis) ? opts.hysteresis : 10;
  const cur = Number(curPct), prev = prevPct == null ? null : Number(prevPct);
  let set = new Set(opts && opts.reset ? [] : (fired || []).map(Number));
  if (!Number.isFinite(cur)) return { crossed: [], fired: [...set] };
  for (const l of [...set]) if (cur < l - hysteresis) set.delete(l);
  const crossed = [];
  for (const l of levels) {
    if (cur < l || set.has(l)) continue;
    set.add(l);
    if (prev != null && Number.isFinite(prev) && prev < l) crossed.push(l);   // no alert on the first reading (start-up)
  }
  return { crossed, fired: [...set].sort((a, b) => a - b) };
}

const normPath = p => String(p || '').replace(/\/+$/, '');

// sessions: [{ id, cost, cwd | projectWorktree, timeCreated, timeUpdated }] (Claude Code session-file summaries)
// dispatchMap: { KEY: { cwd | path, since | sentAt } } — which directory a ticket was sent to and when.
// A session counts toward the ticket dispatched to its directory most recently before the session's last activity;
// sessions without a positive cost are not summed but counted in `unknown`.
function ticketCosts(sessions, dispatchMap) {
  const out = {};
  const ds = Object.entries(dispatchMap || {})
    .map(([key, d]) => ({ key, cwd: normPath(d && (d.cwd || d.path)), since: Number(d && (d.since ?? d.sentAt)) || 0 }))
    .filter(d => d.cwd);
  for (const d of ds) out[d.key] = { cost: 0, sessions: [], since: d.since, unknown: 0 };
  for (const s of sessions || []) {
    if (!s) continue;
    const cwd = normPath(s.cwd || s.projectWorktree), last = Number(s.timeUpdated || s.timeCreated) || 0;
    if (!cwd) continue;
    let best = null;
    for (const d of ds) if (d.cwd === cwd && last >= d.since && (!best || d.since > best.since)) best = d;
    if (!best) continue;
    const t = out[best.key], c = Number(s.cost);
    if (Number.isFinite(c) && c > 0) { t.cost = Math.round((t.cost + c) * 10000) / 10000; t.sessions.push(String(s.id)); }
    else t.unknown++;
  }
  return out;
}

// Claude Code's status line input: rate_limits.five_hour / seven_day = { used_percentage 0-100, resets_at epoch s }
const SL_WINDOWS = [['five_hour', 'session', 300], ['seven_day', 'weekly', 7 * 24 * 60]];
function fromStatusline(rec, now) {
  now = Number(now) || Date.now();
  if (!rec || typeof rec !== 'object' || !rec.rate_limits || typeof rec.rate_limits !== 'object') return null;
  const at = Number(rec.writtenAt);
  if (!Number.isFinite(at) || at <= 0 || at > now + 60000) return null;
  const claude = {};
  for (const [k, name, minutes] of SL_WINDOWS) {
    const w = rec.rate_limits[k];
    if (!w || typeof w !== 'object' || w.used_percentage == null) continue;
    const pct = Number(w.used_percentage), resetsAt = Number(w.resets_at) * 1000;
    if (!Number.isFinite(pct) || !Number.isFinite(resetsAt)) continue;
    if (resetsAt <= now) return null;   // a window reset since the file was written: the whole reading is stale
    if (now - at > minutes * 60000) continue;   // written longer ago than the window lasts
    claude[name] = { usedPercent: Math.max(0, Math.min(100, Math.round(pct))), windowMinutes: minutes, resetsAt, resetDescription: '' };
  }
  if (!claude.session && !claude.weekly) return null;
  claude.updatedAt = at;
  return { claude };
}

function formatEta(ms, lang) {
  const en = lang === 'en';
  if (ms == null || !Number.isFinite(Number(ms))) return en ? 'not reached before reset' : '리셋 전 도달 안 함';
  ms = Number(ms);
  if (ms <= 0) return en ? 'limit reached' : '한도 도달';
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return en ? `in ${min} min` : `${min}분 뒤`;
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return en ? `in about ${d}d${h ? ` ${h}h` : ''}` : `약 ${d}일${h ? ` ${h}시간` : ''} 뒤`;
  return en ? `in about ${h}h${m ? ` ${m}m` : ''}` : `약 ${h}시간${m ? ` ${m}분` : ''} 뒤`;
}

const AgentDeskUsage = { WINDOW_MS, forecast, thresholdCrossed, ticketCosts, formatEta, fromStatusline };
root.AgentDeskUsage = AgentDeskUsage;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskUsage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
