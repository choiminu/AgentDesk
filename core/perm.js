// AgentDesk core: "approve Claude Code permission requests from the widget" — pure logic shared by the main process
// (perm/server.mjs), the renderer and the tests. No DOM, no Electron, no I/O. Needs core/mask.js loaded first
// (globalThis.AgentDeskMask).
//
//   summarize(req)              → what the widget shows for one PermissionRequest hook input (masked, size-bounded):
//                                 { tool, kind: 'bash'|'edit'|'json', command?, desc?, filePath?, added?, removed?,
//                                   edits?, preview?, text, truncated, hasSuggestions }
//                                 truncated = part of the input is not on screen → the widget refuses [허용]
//   decisionOutput(behavior, m) → the hook's stdout JSON for an allow / deny decision (never updatedPermissions)
//   timeoutOutput()             → {} — no decision: Claude Code keeps its own terminal prompt
//   sortQueue(list)             → oldest first (createdAt, then seq)
//   cleanReason(s)              → a deny reason safe to hand back to Claude (no control / bidi / invisible chars, ≤ 300)
//   revealInvisible(s)          → bidi controls and invisible characters made visible as ⟨U+XXXX⟩
(function (root) {
'use strict';
const JSON_MAX = 1000;            // "other tools": the tool_input JSON
const CMD_MAX = 4000;             // a Bash command is shown whole up to this
const PATH_MAX = 500;
const WRITE_LINES = 40, WRITE_CHARS = 3000;   // Write / NotebookEdit content preview
const EDIT_LINES = 20, EDIT_CHARS = 1500;     // Edit: old_string and new_string each
const DENY_DEFAULT = 'AgentDesk에서 거부';
const maskFn = s => (root.AgentDeskMask && root.AgentDeskMask.mask ? root.AgentDeskMask.mask(s) : String(s == null ? '' : s));
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const lineCount = s => { const x = str(s); return x ? x.split('\n').length : 0; };

// bidi overrides / isolates, zero-width and other invisible format characters, C1 controls, and C0 controls other
// than \n and \t: a command can look harmless while running something else (Trojan Source), so show them
const INVISIBLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
function revealInvisible(s) {
  return str(s).replace(INVISIBLE_RE, c => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}
// cut first (masking regexes are bounded, but there is no reason to feed them 1 MB), mask, then reveal hidden characters
const show = (s, n) => { const x = str(s); return revealInvisible(maskFn(x.length > n ? x.slice(0, n) + '…' : x)); };
// first `lines` lines / `chars` characters; cut = something was left out
function head(s, lines, chars) {
  const x = str(s); const ls = x.split('\n');
  let out = ls.slice(0, lines).join('\n'); let cut = ls.length > lines;
  if (out.length > chars) { out = out.slice(0, chars); cut = true; }
  return { text: revealInvisible(maskFn(out)) + (cut ? '\n…' : ''), cut };
}

function summarize(req) {
  const r = req && typeof req === 'object' ? req : {};
  const rawTool = str(r.tool_name);
  const tool = show(rawTool, 120) || '?';
  const input = r.tool_input && typeof r.tool_input === 'object' ? r.tool_input : {};
  const hasSuggestions = Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0;
  let truncated = rawTool.length > 120;
  if (rawTool === 'Bash') {
    const raw = str(input.command);
    const command = show(raw, CMD_MAX);
    const desc = show(input.description, 200);
    truncated = truncated || raw.length > CMD_MAX;
    return { tool, kind: 'bash', command, desc, text: desc ? `${desc}\n${command}` : command, truncated, hasSuggestions };
  }
  if (rawTool === 'Edit' || rawTool === 'MultiEdit' || rawTool === 'Write' || rawTool === 'NotebookEdit') {
    const rawPath = str(input.file_path || input.notebook_path);
    const filePath = show(rawPath, PATH_MAX);
    truncated = truncated || rawPath.length > PATH_MAX;
    let added = 0, removed = 0, preview = '', edits;
    if (rawTool === 'Write' || rawTool === 'NotebookEdit') {
      const body = rawTool === 'Write' ? input.content : input.new_source;
      added = lineCount(body);
      const h = head(body, WRITE_LINES, WRITE_CHARS); preview = h.text; truncated = truncated || h.cut;
    } else {
      const list = rawTool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : [input];
      for (const e of list) { if (!e || typeof e !== 'object') continue; removed += lineCount(e.old_string); added += lineCount(e.new_string); }
      const first = list.find(e => e && typeof e === 'object') || {};
      const a = head(first.old_string, EDIT_LINES, EDIT_CHARS), b = head(first.new_string, EDIT_LINES, EDIT_CHARS);
      preview = `--- ${a.text.split('\n').join('\n--- ')}\n+++ ${b.text.split('\n').join('\n+++ ')}`;
      truncated = truncated || a.cut || b.cut;
      if (rawTool === 'MultiEdit') { edits = list.length; truncated = truncated || list.length !== 1; }   // only the first edit is shown
    }
    return { tool, kind: 'edit', filePath, added, removed, edits, preview, text: `${filePath} (+${added} -${removed})`, truncated, hasSuggestions };
  }
  let json = '';
  try { json = JSON.stringify(input); } catch { json = ''; }
  return { tool, kind: 'json', text: show(json, JSON_MAX), truncated: truncated || json.length > JSON_MAX, hasSuggestions };
}

function cleanReason(s) {
  return str(s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').trim().slice(0, 300);
}

function decisionOutput(behavior, message) {
  if (behavior !== 'allow' && behavior !== 'deny') throw new Error('behavior must be allow or deny');
  const decision = { behavior };
  if (behavior === 'deny') decision.message = cleanReason(message) || DENY_DEFAULT;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function timeoutOutput() { return {}; }

function sortQueue(list) {
  return (list || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.seq || 0) - (b.seq || 0));
}

const AgentDeskPerm = { summarize, decisionOutput, timeoutOutput, sortQueue, cleanReason, revealInvisible, DENY_DEFAULT, JSON_MAX, CMD_MAX };
root.AgentDeskPerm = AgentDeskPerm;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskPerm;
})(typeof globalThis !== 'undefined' ? globalThis : this);
