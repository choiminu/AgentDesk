// AgentDesk core: day-by-day numbers from the hook event log, and what is read off them. No DOM, no Electron, no I/O.
// Loaded as a classic <script> (global AgentDeskDaily) or required from main / tests.
//
// The hook log is short-lived (the hook trims it to a few thousand lines), so anything that spans days needs its own
// store: daily/store.mjs keeps one small object per day, built here. Numbers and command families only — never a
// prompt, a path, an argument or an error text.
//
//   dayKey(ms)                         → 'YYYY-MM-DD' (local time)
//   createFolder()                     → fold(rec): fold one hook record ({ ts, ev }) into days; days(): the day map
//        a day: { sessions, prompts, tools, fails, edits, testPass, testFail, fixes, compacts,
//                 waitMs, waitN, permMs, permN, perm: { family: { ask, allow, deny } } }
//        waitMs: Stop → the next prompt, when the user came back within WAIT_CAP_MS (a longer gap is a break, not a wait)
//        permMs: a permission request → the tool going ahead / being denied
//        fixes:  a failing test run followed by a passing one in the same session
//   family(tool, input)                → 'Bash(npm test:*)' | 'Edit' | 'mcp__server__tool' | ''   what a permission is for
//   mergeDay(a, b)                     → a with b's numbers added (a is changed and returned)
//   calendar(days, now, weeks)         → [[{ day, n, level 0..4, future }] × 7] × weeks   (columns = weeks, oldest first)
//   totals(days, fromDay, toDay)       → one summed day object over the range (inclusive)
//   streak(days, now)                  → consecutive days with activity, ending today or yesterday
//   ruleSuggestions(days, now, opts)   → [{ rule, family, allow, days }]   families allowed often and never denied
//   achievements(days)                 → [{ id, done, have, need }]   outcomes only (never volume of tool calls)
//   bottleneck(sessions, now)          → { waitingMs, top: [{ id, name, ms, ask }] }   who waits for me right now
(function (root) {
'use strict';

const WAIT_CAP_MS = 10 * 60000;
const PERM_CAP_MS = 30 * 60000;
const PERM_FAMILIES_MAX = 60;
const pad = n => String(n).padStart(2, '0');
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const FIELDS = ['sessions', 'prompts', 'tools', 'fails', 'edits', 'testPass', 'testFail', 'fixes', 'compacts', 'waitMs', 'waitN', 'permMs', 'permN'];
function emptyDay() { const d = { perm: Object.create(null) }; for (const f of FIELDS) d[f] = 0; return d; }

// what a permission request is for, without its arguments: a shell command's first word (and its subcommand for the
// tools that have them), a file tool's name, an MCP tool's full name
const SUBCMD = /^(git|npm|pnpm|yarn|bun|npx|cargo|go|docker|kubectl|gh|pip|pip3|uv|poetry|make|brew|dotnet|mvn|gradle|\.\/gradlew|deno|node|python|python3|terraform|aws|gcloud)$/;
const WORD = /^[\w.@/+-]{1,40}$/;
function family(tool, input) {
  const t = typeof tool === 'string' ? tool : '';
  if (!t || t.length > 120) return '';
  if (t !== 'Bash') return /^[\w.-]+$/.test(t) ? t : '';
  const c = input && typeof input.command === 'string' ? input.command.trim() : '';
  if (!c || c.length > 4000 || /[;&|`$<>(){}\n]/.test(c)) return '';   // a compound command has no single family
  const w = c.split(/\s+/);
  if (!WORD.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0])) return '';
  const sub = SUBCMD.test(w[0]) && w[1] && WORD.test(w[1]) && !w[1].startsWith('-') ? ` ${w[1]}` : '';
  return `Bash(${w[0]}${sub}:*)`;
}
// families never offered as an allow rule: they delete, publish, escalate, or run what they download
const RISKY = /^Bash\((rm|sudo|su|chmod|chown|dd|mkfs|kill|killall|pkill|shutdown|reboot|curl|wget|ssh|scp|rsync|nc|eval|exec|sh|bash|zsh|git (push|reset|clean|rebase|checkout|restore)|npm (publish|unpublish)|docker (rm|rmi|system)|kubectl (delete|apply)|terraform (apply|destroy)|gh (repo|release|secret)|aws|gcloud|brew|pip|pip3)\b/;

const TEST_RE_SAFE = c => (root.AgentDeskPlay && root.AgentDeskPlay.isTestCmd ? root.AgentDeskPlay.isTestCmd(c) : false);
const failCount = s => (root.AgentDeskPlay && root.AgentDeskPlay.failCount ? root.AgentDeskPlay.failCount(s) : 0);

function createFolder(seed) {
  const days = Object.create(null);
  if (seed && typeof seed === 'object') for (const [k, v] of Object.entries(seed)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && typeof v === 'object') days[k] = mergeDay(emptyDay(), v);
  const open = new Map();   // sid → { stopAt, permAt, permFam, failing, seenDay }
  const dayOf = at => { const k = dayKey(at); return days[k] || (days[k] = emptyDay()); };
  const st = sid => { let s = open.get(sid); if (!s) { if (open.size > 500) open.delete(open.keys().next().value); s = { stopAt: 0, permAt: 0, permFam: '', failing: false, seenDay: '' }; open.set(sid, s); } return s; };
  const permNote = (d, fam, k) => {
    if (!fam) return;
    let e = d.perm[fam];
    if (!e) { if (Object.keys(d.perm).length >= PERM_FAMILIES_MAX) return; e = d.perm[fam] = { ask: 0, allow: 0, deny: 0 }; }
    e[k]++;
  };
  function fold(rec) {
    const ev = rec && rec.ev; if (!ev || typeof ev !== 'object') return false;
    const sid = typeof ev.session_id === 'string' ? ev.session_id : ''; if (!sid) return false;
    const at = Number(rec.ts) * 1000; if (!Number.isFinite(at) || at <= 0) return false;
    const name = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PostCompact' }[ev.hook_event_name] || ev.hook_event_name;
    const d = dayOf(at), s = st(sid), sub = !!ev.agent_id, tool = typeof ev.tool_name === 'string' ? ev.tool_name : '', input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
    const k = dayKey(at);
    if (s.seenDay !== k) { s.seenDay = k; d.sessions++; }
    const permEnd = how => {
      if (!s.permAt) return;
      const ms = at - s.permAt;
      if (ms >= 0 && ms <= PERM_CAP_MS) { d.permMs += ms; d.permN++; }
      permNote(d, s.permFam, how);
      s.permAt = 0; s.permFam = '';
    };
    switch (name) {
      case 'UserPromptSubmit':
        d.prompts++;
        if (s.stopAt) { const ms = at - s.stopAt; if (ms >= 0 && ms <= WAIT_CAP_MS) { d.waitMs += ms; d.waitN++; } s.stopAt = 0; }
        s.permAt = 0;
        break;
      case 'PreToolUse': if (!sub) d.tools++; break;
      case 'PostToolUse':
        if (sub) break;
        if (s.permAt) permEnd('allow');
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) d.edits++;
        if (tool === 'Bash' && TEST_RE_SAFE(input.command)) {
          const r = ev.tool_response, out = r && typeof r === 'object' ? `${r.stdout || ''}\n${r.stderr || ''}` : String(r || '');
          if (failCount(out)) { d.testFail++; s.failing = true; }
          else { d.testPass++; if (s.failing) { d.fixes++; s.failing = false; } }
        }
        break;
      case 'PostToolUseFailure':
        if (sub) break;
        d.fails++;
        if (s.permAt) permEnd('allow');   // it was let through, then failed
        if (tool === 'Bash' && TEST_RE_SAFE(input.command) && !ev.is_interrupt) { d.testFail++; s.failing = true; }
        break;
      case 'PermissionRequest':
        if (sub) break;
        s.permAt = at; s.permFam = family(tool, input);
        permNote(d, s.permFam, 'ask');
        break;
      case 'PermissionDenied': if (!sub) permEnd('deny'); break;
      case 'Stop': case 'Interrupt': s.stopAt = at; s.permAt = 0; break;
      case 'PostCompact': d.compacts++; break;
      case 'SessionEnd': open.delete(sid); break;
    }
    return true;
  }
  return { fold, days: () => days, prune(minDay) { for (const k of Object.keys(days)) if (k < minDay) delete days[k]; } };
}

function mergeDay(a, b) {
  for (const f of FIELDS) a[f] = num(a[f]) + num(b && b[f]);
  if (!a.perm) a.perm = Object.create(null);
  const p = b && b.perm && typeof b.perm === 'object' ? b.perm : {};
  for (const [fam, e] of Object.entries(p)) {
    if (typeof fam !== 'string' || fam.length > 120 || !e || typeof e !== 'object') continue;
    const t = a.perm[fam] || (a.perm[fam] = { ask: 0, allow: 0, deny: 0 });
    t.ask += num(e.ask); t.allow += num(e.allow); t.deny += num(e.deny);
  }
  return a;
}
function totals(days, fromDay, toDay) {
  const out = emptyDay();
  for (const [k, v] of Object.entries(days || {})) if (k >= fromDay && k <= toDay) mergeDay(out, v);
  return out;
}
const active = d => num(d && d.prompts) + num(d && d.tools) > 0;

// 12 weeks as columns of 7 days (Sunday first), the last column holding today; level by tool calls against the busiest day
function calendar(days, now, weeks) {
  const W = Math.max(1, Math.min(53, Number(weeks) || 12)), end = new Date(now); end.setHours(12, 0, 0, 0);
  const start = new Date(end); start.setDate(end.getDate() - end.getDay() - (W - 1) * 7);
  const cells = [], today = dayKey(now);
  let max = 0;
  for (let i = 0; i < W * 7; i++) {
    const dt = new Date(start); dt.setDate(start.getDate() + i);
    const day = dayKey(dt.getTime()), v = (days || {})[day], n = v ? num(v.tools) + num(v.prompts) : 0;
    if (n > max) max = n;
    cells.push({ day, n, future: day > today });
  }
  for (const c of cells) c.level = !c.n ? 0 : Math.min(4, 1 + Math.floor(c.n / max * 3.999));
  const cols = [];
  for (let w = 0; w < W; w++) cols.push(cells.slice(w * 7, w * 7 + 7));
  return cols;
}
function streak(days, now) {
  let n = 0;
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  if (!active((days || {})[dayKey(d.getTime())])) d.setDate(d.getDate() - 1);   // today not started yet: yesterday still counts
  while (active((days || {})[dayKey(d.getTime())])) { n++; d.setDate(d.getDate() - 1); if (n > 400) break; }
  return n;
}

// allow rules worth adding to the agent's own settings: allowed at least `min` times over the last `span` days, never
// denied, not a risky family. AgentDesk never stores or applies a rule: this is text for the user to copy.
function ruleSuggestions(days, now, opts) {
  const o = opts || {}, min = o.min || 5, span = o.span || 7;
  const from = dayKey(now - (span - 1) * 86400000), to = dayKey(now), sum = Object.create(null);
  for (const [k, v] of Object.entries(days || {})) {
    if (k < from || k > to || !v || !v.perm) continue;
    for (const [fam, e] of Object.entries(v.perm)) {
      const t = sum[fam] || (sum[fam] = { allow: 0, deny: 0, days: 0 });
      t.allow += num(e.allow); t.deny += num(e.deny); if (num(e.allow)) t.days++;
    }
  }
  return Object.entries(sum).filter(([fam, t]) => t.allow >= min && !t.deny && !RISKY.test(fam) && fam !== 'Bash')
    .map(([fam, t]) => ({ rule: fam, family: fam, allow: t.allow, days: t.days })).sort((a, b) => b.allow - a.allow).slice(0, 8);
}

// outcomes, not volume: tests turned green, days in a row, answering quickly — never "most tool calls"
const ACH = [
  { id: 'fix1', need: 1, of: t => t.fixes }, { id: 'fix10', need: 10, of: t => t.fixes }, { id: 'fix50', need: 50, of: t => t.fixes },
  { id: 'days5', need: 5, of: (t, n) => n.days }, { id: 'days30', need: 30, of: (t, n) => n.days },
  { id: 'streak5', need: 5, of: (t, n) => n.best }, { id: 'streak14', need: 14, of: (t, n) => n.best },
  { id: 'green20', need: 20, of: t => t.testPass },
];
function achievements(days) {
  const keys = Object.keys(days || {}).sort(), t = totals(days, '0000-00-00', '9999-99-99');
  let best = 0, run = 0, prev = 0, n = 0;
  for (const k of keys) {
    if (!active(days[k])) continue;
    n++;
    const at = new Date(`${k}T12:00:00`).getTime();
    run = prev && Math.round((at - prev) / 86400000) === 1 ? run + 1 : 1;
    prev = at; if (run > best) best = run;
  }
  return ACH.map(a => { const have = Math.max(0, Math.floor(num(a.of(t, { days: n, best })))); return { id: a.id, need: a.need, have: Math.min(have, a.need), done: have >= a.need }; });
}

// who is waiting for me now: sessions that need an answer (longest first), then those waiting for input
function bottleneck(sessions, now) {
  const rows = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.status === 'done' || s.status === 'error') continue;
    const ask = !!s.needsInput, since = ask ? num(s.askSince) || num(s.time) : s.status === 'waiting' ? num(s.time) : 0;
    if (!since) continue;
    const ms = Math.max(0, now - since);
    if (!ask && ms > WAIT_CAP_MS * 6) continue;   // waiting for an hour: parked, not a bottleneck
    rows.push({ id: s.id, name: String(s.name || ''), ms, ask });
  }
  rows.sort((a, b) => (b.ask - a.ask) || b.ms - a.ms);
  return { waitingMs: rows.reduce((n, r) => n + r.ms, 0), count: rows.length, top: rows.slice(0, 3) };
}

const AgentDeskDaily = { dayKey, createFolder, family, mergeDay, totals, calendar, streak, ruleSuggestions, achievements, bottleneck, emptyDay, FIELDS, WAIT_CAP_MS, RISKY };
root.AgentDeskDaily = AgentDeskDaily;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDaily;
})(typeof globalThis !== 'undefined' ? globalThis : this);
