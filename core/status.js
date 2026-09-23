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
  if (!st) { st = { sid, cwd: ev.cwd, transcript: ev.transcript_path || '', first: ts, status: 'waiting', tool: '', toolInput: '', needsInput: false, since: ts, last: ts, subagents: new Map(), ended: false }; sessions.set(sid, st); }
  if (ev.cwd) st.cwd = ev.cwd;
  if (rec.term) st.term = rec.term;   // TERM_PROGRAM of the launching terminal (Orca, iTerm.app, tmux, Apple_Terminal)
  st.agent = rec.agent || st.agent || 'claude';   // which CLI emitted the event (claude / gemini / codex)
  if (ev.transcript_path) st.transcript = ev.transcript_path;
  st.last = Math.max(st.last, ts);
  const setStatus = (v) => { if (st.status !== v) { st.status = v; st.since = ts; } };
  const sub = ev.agent_id ? st.subagents.get(ev.agent_id) : null;
  // Gemini CLI uses its own event names; Codex CLI shares Claude Code's. Normalize to the Claude Code set.
  const GEMINI_EVENTS = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PostCompact' };
  const evName = GEMINI_EVENTS[ev.hook_event_name] || ev.hook_event_name;
  switch (evName) {
    case 'SessionStart': st.ended = false; break;
    case 'UserPromptSubmit': setStatus('running'); st.tool = ''; st.toolInput = ''; st.needsInput = false; st.ended = false; break;
    case 'PreToolUse':
      if (sub) { sub.tool = ev.tool_name || ''; sub.toolInput = hookToolInput(ev.tool_name, ev.tool_input); sub.last = ts; }
      else { setStatus('running'); st.tool = ev.tool_name || ''; st.toolInput = hookToolInput(ev.tool_name, ev.tool_input); st.needsInput = ev.tool_name === 'AskUserQuestion'; }
      break;
    case 'PostToolUse':
      if (sub) { sub.tool = ''; sub.last = ts; }
      else { setStatus('running'); st.needsInput = false; }
      break;
    case 'PermissionRequest': setStatus('waiting'); st.needsInput = true; break;
    case 'Notification': {
      const nt = ev.notification_type || '';
      if (/permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|ToolPermission|approval/i.test(nt)) { setStatus('waiting'); st.needsInput = true; }   // Claude / Gemini / Codex names
      else if (nt === 'idle_prompt') setStatus('waiting');
      break;
    }
    case 'Stop': case 'Interrupt': setStatus('waiting'); st.tool = ''; st.toolInput = ''; st.needsInput = false; break;
    case 'SubagentStart': if (ev.agent_id) st.subagents.set(ev.agent_id, { id: ev.agent_id, type: ev.agent_type || 'agent', since: ts, last: ts, tool: '', toolInput: '' }); break;
    case 'SubagentStop': if (ev.agent_id) st.subagents.delete(ev.agent_id); break;
    case 'SessionEnd': st.ended = true; st.status = 'done'; st.since = ts; st.subagents.clear(); break;
    case 'PostCompact': break;
  }
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

const AgentDeskStatus = { SPINNER_RE, DONE_FRESH_MS, statusFromScreen, doneLineStatus, screenHasChoice, parseAgentPanel, parseCtxPct, hookToolInput, applyHookEvent, hookStatusFor, resolveStatus };
// the widget loads this as a classic <script> (globals); tests `import()` it and read globalThis.AgentDeskStatus
root.AgentDeskStatus = AgentDeskStatus;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskStatus;
else Object.assign(root, AgentDeskStatus);
})(typeof globalThis !== 'undefined' ? globalThis : this);
