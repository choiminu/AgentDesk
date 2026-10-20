// AgentDesk core: session-status judgement shared by the renderer (classic <script>) and the tests (CommonJS).
// Pure functions only — no DOM, no Electron. Inputs are hook event records and terminal screen lines.
//
//   statusFromScreen(lines)          → 'running' | 'waiting' | 'waiting-untimed' | 'done' | null
//   applyHookEvent(rec, sessions)    → folds one hook record (Claude Code / Gemini CLI / Codex CLI) into the session map
//   hookStatusFor(st)                → status from a hook session state (waiting ages into done)
//   resolveStatus(base, screen, hk)  → final status: hooks win, then the screen, then the platform's own state
(function (root) {
'use strict';
// Claude Code TUI: [transcript…] [spinner | ✻ done] ─── ❯ ─── [status bar]. Anchor on the last prompt line.
const SPINNER_RE = /^[·•✢✳✶✻✽✦✧*⠁-⣿]\s*\S[^(]*…\s*(\(|$)/;

function statusFromScreen(lines) {
  if (!lines || !lines.length) return null;
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯/.test(lines[i].trim())) { p = i; break; }
  }
  if (p < 0) return null;
  const promptText = lines[p].trim().slice(1).trim();
  if (/^\d+\.\s/.test(promptText)) return 'waiting';          // numbered choice (permission / question)
  for (let i = p - 1; i >= 0; i--) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || /^─+/.test(t)) continue;
    if (/^\s/.test(raw) || /^[⎿※]/.test(t)) continue;         // continuation / tip / recap lines
    if (SPINNER_RE.test(t) || /esc to interrupt/i.test(t)) return 'running';
    if (/^✻/.test(t) && /\bdone\b/i.test(t)) return doneLineStatus(t);
    if (/^(Do you want|Allow|Would you like)/i.test(t)) return 'waiting';
    // a ⏺ block with no spinner below it means the turn already finished (Claude Code does not
    // always print a "✻ … done" line); freshness is decided by the caller from screen changes
    if (/^⏺/.test(t)) return 'waiting-untimed';
    return null;
  }
  return null;
}

// "✻ Worked for 22s · done 2:34 PM" → just finished → waiting for input.
// "✻ … done Thursday 10:28 AM" (a weekday means another day) or finished > 10 min ago → idle/done.
const DONE_FRESH_MS = 10 * 60 * 1000;

function doneLineStatus(t) {
  const after = t.replace(/^.*?\bdone\b/i, '').trim();
  const tm = after.match(/(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(오전|오후|AM|PM)?/i);
  if (!tm) return 'waiting';
  // anything besides the time itself (weekday/date in any language) means it finished on another day
  const rest = after.replace(tm[0], '').replace(/[·\s]/g, '');
  if (rest.length) return 'done';
  let h = parseInt(tm[2], 10); const min = parseInt(tm[3], 10);
  const ap = (tm[1] || tm[4] || '').toUpperCase();
  if (ap) { const pm = ap === 'PM' || ap === '오후'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0).getTime();
  const age = now.getTime() - at;
  if (age < -60 * 1000) return 'done';
  return age > DONE_FRESH_MS ? 'done' : 'waiting';
}

// A choice prompt renders numbered options with a ❯ marker on the selected one ("  ❯ 1. Yes").
// Plain numbered lists in the transcript never carry the marker.
function screenHasChoice(lines) {
  if (!lines) return false;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    if (/^\s*❯\s*\d+\.\s+\S/.test(lines[i])) return true;
  }
  return false;
}

// Agents panel under the status bar: "  ⏺ main" then one line per subagent:
//   "  ◯ name  description…      17s · ↓ 30.5k tokens"   (running)
//   "  ◯ name  description…      idle"                    (finished)
function parseAgentPanel(lines) {
  if (!lines) return [];
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*⏺\s+main\s*$/.test(lines[i])) { start = i; break; }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([◯●◉○◐◑◔◕])\s+(\S+)\s{2,}(.*?)\s*$/);
    if (!m) { if (out.length) break; else continue; }
    let rest = m[3];
    let state = 'running', elapsed = '', tokens = '';
    if (/\bidle\s*$/.test(rest)) { state = 'idle'; rest = rest.replace(/\s*idle\s*$/, ''); }
    const tm = rest.match(/\s{2,}((?:\d+m\s*)?\d+s|\d+m)\s*(?:·\s*↓\s*([\d.]+k?)\s*tokens)?\s*$/);
    if (tm) { elapsed = tm[1]; tokens = tm[2] || ''; rest = rest.slice(0, tm.index); }
    out.push({ name: m[2], desc: rest.trim().replace(/\.\.\.$|…$/, ''), state, elapsed, tokens });
  }
  return out;
}

// OMC status line carries "ctx:[#####-----]46%" (context window usage)
function parseCtxPct(lines) {
  if (!lines) return null;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = lines[i].match(/ctx:\s*\[[#\-\s]*\]\s*(\d{1,3})%/);
    if (m) return Math.min(100, parseInt(m[1], 10));
  }
  return null;
}

function hookToolInput(tool, input) {
  if (!input || typeof input !== 'object') return '';
  return input.file_path || input.path || input.notebook_path || input.command || input.pattern || input.url || input.description || input.prompt || '';
}

function applyHookEvent(rec, sessions) {
  sessions = sessions || (typeof hookSessions !== 'undefined' ? hookSessions : null);
  if (!sessions) return;
  const ev = rec.ev || {}; const ts = (rec.ts || 0) * 1000;
  const sid = ev.session_id; if (!sid) return;
  let st = sessions.get(sid);
  if (!st) { st = { sid, cwd: ev.cwd, transcript: ev.transcript_path || '', first: ts, status: 'waiting', tool: '', toolInput: '', needsInput: false, since: ts, last: ts, subagents: new Map(), ended: false, recentTools: [], runMs: 0, askAt: 0, askMs: 0, askN: 0 }; sessions.set(sid, st); }
  if (!st.recentTools) { st.recentTools = []; st.runMs = st.runMs || 0; st.askAt = st.askAt || 0; st.askMs = st.askMs || 0; st.askN = st.askN || 0; }
  if (!st.failures) { st.failures = []; st.failStreak = 0; }
  if (ev.cwd) st.cwd = ev.cwd;
  if (rec.term) st.term = rec.term;   // TERM_PROGRAM of the launching terminal (Orca, iTerm.app, tmux, Apple_Terminal)
  st.agent = rec.agent || st.agent || 'claude';   // which CLI emitted the event (claude / gemini / codex)
  if (ev.transcript_path) st.transcript = ev.transcript_path;
  // Claude Code reports its permission mode with every hook payload (default / acceptEdits / plan / bypassPermissions)
  if (typeof ev.permission_mode === 'string') st.permissionMode = ev.permission_mode.slice(0, 40);
  st.last = Math.max(st.last, ts);
  // runMs accumulates time spent in 'running'; askAt/askMs/askN measure how long needs-input prompts waited for the user
  const setStatus = (v) => { if (st.status !== v) { if (st.status === 'running' && ts > st.since) st.runMs += ts - st.since; st.status = v; st.since = ts; } };
  const setAsk = (v) => {
    if (v && !st.needsInput) st.askAt = ts;
    else if (!v && st.needsInput && st.askAt) { st.askMs += Math.max(0, ts - st.askAt); st.askN++; st.askAt = 0; }
    st.needsInput = v;
  };
  const sub = ev.agent_id ? st.subagents.get(ev.agent_id) : null;
  // Gemini CLI uses its own event names; Codex CLI shares Claude Code's. Normalize to the Claude Code set.
  const GEMINI_EVENTS = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PostCompact' };
  const evName = GEMINI_EVENTS[ev.hook_event_name] || ev.hook_event_name;
  switch (evName) {
    case 'SessionStart': st.ended = false; break;
    case 'UserPromptSubmit': setStatus('running'); st.tool = ''; st.toolInput = ''; setAsk(false); st.ended = false; st.failStreak = 0; st.failures = []; st.loopNotified = 0; st.compacting = false; break;   // the user stepped in: start the loop watch afresh
    case 'PreToolUse':
      if (!sub) st.compacting = false;
      if (sub) { sub.tool = ev.tool_name || ''; sub.toolInput = hookToolInput(ev.tool_name, ev.tool_input); sub.last = ts; }
      else {
        setStatus('running'); st.tool = ev.tool_name || ''; st.toolInput = hookToolInput(ev.tool_name, ev.tool_input); setAsk(ev.tool_name === 'AskUserQuestion');
        st.recentTools.push({ tool: st.tool, input: st.toolInput, ts }); if (st.recentTools.length > 5) st.recentTools.shift();
      }
      break;
    case 'PostToolUse':
      if (TOUCH_TOOLS.test(ev.tool_name || '')) recordTouch(st, (ev.tool_input || {}).file_path || (ev.tool_input || {}).notebook_path, ts);
      if (sub) { sub.tool = ''; sub.last = ts; }
      else { setStatus('running'); setAsk(false); st.failStreak = 0; }
      break;
    case 'PostToolUseFailure':
      if (!sub) { setStatus('running'); st.failStreak++; st.failures.push({ tool: ev.tool_name || st.tool || '', input: hookToolInput(ev.tool_name, ev.tool_input) || st.toolInput || '', ts }); if (st.failures.length > 10) st.failures.shift(); }
      break;
    case 'PermissionRequest': setStatus('waiting'); setAsk(true); break;
    case 'Notification': {
      const nt = ev.notification_type || '';
      if (/permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|ToolPermission|approval/i.test(nt)) { setStatus('waiting'); setAsk(true); }   // Claude / Gemini / Codex names
      else if (nt === 'idle_prompt') setStatus('waiting');
      break;
    }
    case 'Stop': case 'Interrupt': st.compacting = false; setStatus('waiting'); st.tool = ''; st.toolInput = ''; setAsk(false); break;
    case 'SubagentStart': if (ev.agent_id) st.subagents.set(ev.agent_id, { id: ev.agent_id, type: ev.agent_type || 'agent', since: ts, last: ts, tool: '', toolInput: '' }); break;
    case 'SubagentStop': if (ev.agent_id) st.subagents.delete(ev.agent_id); break;
    case 'SessionEnd': setStatus('done'); setAsk(false); st.ended = true; st.subagents.clear(); break;
    case 'StopFailure': setStatus('error'); st.tool = ''; st.toolInput = ''; setAsk(false); st.compacting = false; st.lastError = { at: ts, reason: String(ev.last_assistant_message || ev.error_details || ev.error || 'unknown').slice(0, 300), error: String(ev.error || '').slice(0, 60) }; break;
    case 'PermissionDenied': (st.denied = st.denied || []).push({ tool: String(ev.tool_name || ''), at: ts }); if (st.denied.length > 20) st.denied.shift(); break;
    case 'TaskCreated': case 'TaskCompleted': {
      const id = String(ev.task_id || ''); if (!id) break;
      st.tasks = st.tasks || [];
      let t = st.tasks.find(x => x.id === id);
      if (!t) { t = { id, desc: '', state: 'open', at: ts }; st.tasks.push(t); if (st.tasks.length > 50) st.tasks.shift(); }
      t.desc = String(ev.task_subject || ev.task_description || t.desc || '').slice(0, 120); t.at = ts;
      if (evName === 'TaskCompleted') t.state = 'done';
      break;
    }
    case 'PreCompact': st.compacting = true; st.compactTrigger = ev.trigger === 'auto' ? 'auto' : 'manual'; break;
    case 'PostCompact': st.compacting = false; break;
    case 'CwdChanged': if (ev.new_cwd) st.cwd = ev.new_cwd; break;
  }
}

// files a session changed (team conflict check): Edit/Write/NotebookEdit targets, stored relative to the session's cwd.
// A path outside the cwd keeps only its file name, so no private directory layout ever leaves the machine.
const TOUCH_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const TOUCH_WINDOW_MS = 10 * 60 * 1000;
function relPath(file, cwd) {
  const f = String(file || '').replace(/\\/g, '/').trim(); if (!f) return '';
  const base = f.split('/').filter(Boolean).pop() || '';
  const abs = f.startsWith('/') || /^[A-Za-z]:\//.test(f);
  if (!abs) { const parts = f.split('/').filter(p => p && p !== '.'); return parts.includes('..') ? base : parts.join('/'); }
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (c && f.startsWith(c + '/')) { const r = f.slice(c.length + 1); return r.split('/').includes('..') ? base : r.split('/').filter(Boolean).join('/'); }
  return base;
}
function recordTouch(st, file, ts) {
  const path = relPath(file, st.cwd); if (!path) return;
  st.touched = (st.touched || []).filter(x => x.path !== path);
  st.touched.push({ path, at: ts });
  if (st.touched.length > 50) st.touched.shift();
}
// newest first, unique, at most `max`, only those touched within `windowMs` of `now`
function touchedFiles(st, now, windowMs, max) {
  const t0 = (now || Date.now()) - (windowMs || TOUCH_WINDOW_MS);
  return ((st && st.touched) || []).filter(x => x.at >= t0).sort((a, b) => b.at - a.at).slice(0, max || 20).map(x => x.path);
}

// a session "loops" when the same tool call repeats 3+ times within 10 minutes, or 3+ tool calls fail in a row.
// Returns null or { count, reason: 'repeat'|'fail', tool, input, since }.
const LOOP_WINDOW_MS = 10 * 60 * 1000;
function loopStateFor(st) {
  if (!st || st.ended) return null;
  const now = st.last || Date.now();
  if ((st.failStreak || 0) >= 3) { const f = st.failures[st.failures.length - 1] || {}; return { count: st.failStreak, reason: 'fail', tool: f.tool || st.tool || '', input: f.input || '', since: (st.failures[0] || {}).ts || now }; }
  const recent = (st.recentTools || []).filter(x => now - x.ts <= LOOP_WINDOW_MS);
  const key = x => `${x.tool}\u0000${x.input}`;
  const counts = new Map();
  for (const x of recent) { if (!x.input) continue; const k = key(x); counts.set(k, (counts.get(k) || 0) + 1); }
  let best = null;
  for (const [k, n] of counts) if (n >= 3 && (!best || n > best.n)) best = { k, n };
  if (!best) return null;
  const [tool, input] = best.k.split('\u0000'); const first = recent.find(x => key(x) === best.k);
  return { count: best.n, reason: 'repeat', tool, input, since: first ? first.ts : now };
}
function hookStatusFor(st) {
  if (!st) return null;
  if (st.status === 'waiting' && Date.now() - st.since > DONE_FRESH_MS) return 'done';
  return st.status;
}

function resolveStatus(baseStatus, screenSt, hk) {
  if (baseStatus === 'error') return 'error';
  const hs = hookStatusFor(hk);
  if (hs) return hs;                                  // hook events are exact
  if (screenSt === 'running' || screenSt === 'waiting' || screenSt === 'done') return screenSt;
  return baseStatus;
}

// ── answer text for Slack / reports: keeps code indentation and rejoins lines the TUI hard-wrapped ──
function displayCols(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300)) ? 2 : 1;
  }
  return n;
}
const RESPONSE_LINE_MARK = /^\s*([•·▪\-*▸→]|\d+[.)]\s|\[[^\]]{1,24}\]|REPORT_|⎿|```|#{1,6}\s)/;
// lines: a screen (array of lines). Returns the last answer (between the last ❯ prompt and the ✻ done line) with the TUI's
// 2-space indent removed, relative indentation kept, and a line that was wrapped because it reached the screen width glued back.
function responseTextFromScreen(lines) {
  let lastPromptIdx = -1, lastDoneIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.includes('✻') && t.includes('done') && lastDoneIdx === -1) lastDoneIdx = i;
    if (t.startsWith('❯') && t.length > 5 && lastDoneIdx > i) { lastPromptIdx = i; break; }
  }
  if (lastDoneIdx < 0) return '';
  if (lastPromptIdx < 0 || lastDoneIdx <= lastPromptIdx) lastPromptIdx = -1;
  const block = lines.slice(lastPromptIdx + 1, lastDoneIdx).map(l => l.replace(/\s+$/, '').replace(/^(\s*)⏺\s?/, '$1  '));
  const nonEmpty = block.filter(l => l.trim());
  if (!nonEmpty.length) return '';
  const width = Math.max(...lines.map(displayCols));
  const base = Math.min(...nonEmpty.map(l => l.match(/^ */)[0].length));
  const out = [];
  for (const raw of block) {
    const l = raw.slice(Math.min(base, raw.match(/^ */)[0].length));
    const prev = out.length ? out[out.length - 1] : null;
    const wrapped = prev && prev.trim() && l.trim() && displayCols(prev) + base >= width - 12 && !RESPONSE_LINE_MARK.test(l) && !/^\s/.test(l);
    if (wrapped) out[out.length - 1] = prev + ' ' + l.trim();   // the TUI wraps at word boundaries, so a space is always right
    else out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const AgentDeskStatus = { SPINNER_RE, DONE_FRESH_MS, statusFromScreen, doneLineStatus, screenHasChoice, parseAgentPanel, parseCtxPct, hookToolInput, applyHookEvent, hookStatusFor, resolveStatus, loopStateFor, relPath, recordTouch, touchedFiles, TOUCH_WINDOW_MS, displayCols, responseTextFromScreen };
// the widget loads this as a classic <script> (globals); tests `import()` it and read globalThis.AgentDeskStatus
root.AgentDeskStatus = AgentDeskStatus;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskStatus;
else Object.assign(root, AgentDeskStatus);
})(typeof globalThis !== 'undefined' ? globalThis : this);
