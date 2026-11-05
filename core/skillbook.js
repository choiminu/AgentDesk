// AgentDesk core: Skillbook pure helpers (SKILL.md front matter, Codex TOML MCP sections, usage records, mastery).
// No DOM, no Electron, no I/O. Loaded as a classic <script> (global AgentDeskSkillbook) or required from main.
//
//   parseSkillMd(text)                   → { name|null, description, triggers[] }  front matter; triggers = quoted phrases (≤ 6, ≤ 40 chars)
//   tomlMcpServers(text)                 → [{ name, keys[], transport: 'stdio'|'http' }]  from [mcp_servers.<name>] sections
//   tomlRemoveSection(text, name)        → { text, removed|null }  drops one [mcp_servers.<name>] section (and its sub-tables); removed = exact text
//                                          (null too when a multi-line value never closes: the section end cannot be trusted)
//   tomlLines(lines)                     → [{ line, header, path, cont }] (+ .open)  header = a real [x]/[[x]] line, not one inside a multi-line value
//   usageFromRecord(rec)                 → [{ key, kind: 'skill'|'mcp', agent, at(ms), repo, tool? }]  from a hook record { ts, agent?, ev }
//                                          (tool: the MCP tool name of mcp__<server>__<tool>)
//   usageFromTranscriptLine(line, agent) → same shape, from one Claude Code transcript JSON line
//   mastery(n)                           → 0 | 1 | 2 | 3  for uses in the last 30 days (0 / 1-4 / 5-19 / ≥ 20)
//   weekCount(byDay, now)                → uses over the last 7 local days including today (byDay: 'YYYY-MM-DD' → n)
(function (root) {
'use strict';
const MAX_TRIGGERS = 6;
const TRIGGER_MAX = 40;

function unquote(v) {
  const s = String(v).trim();
  const m = /^(["'])(.*)\1$/.exec(s);
  return m ? m[2] : s;
}

function parseSkillMd(text) {
  const out = { name: null, description: '', triggers: [] };
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || ''));
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      const fold = val[0] === '>';
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim());
      val = fold ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else val = unquote(val);
    if (kv[1] === 'name') out.name = val || null; else out.description = val;
  }
  out.triggers = quotedPhrases(out.description);
  return out;
}

// quoted phrases ("…", '…', ‘…’, “…”) that start the text or follow a non-word character — what
// /(?:^|[^\w])(?:"([^"]+)"|'([^']+)'|‘([^’]+)’|“([^”]+)”)/g found, without its backtracking: that regex took time
// quadratic in the length on unclosed quotes (a crafted SKILL.md froze the main process). Linear: the next closing
// quote of each kind is precomputed in one pass from the end.
const QUOTES = { '"': '"', "'": "'", '\u2018': '\u2019', '\u201C': '\u201D' };
function quotedPhrases(text) {
  const s = String(text || ''), n = s.length, out = [], seen = new Set(), next = {};
  for (const c of new Set(Object.values(QUOTES))) {
    const a = new Int32Array(n + 2).fill(n);
    for (let i = n - 1; i >= 0; i--) a[i] = s[i] === c ? i : a[i + 1];
    next[c] = a;
  }
  let from = 0;   // a match's own characters cannot be the leading non-word character of the next one
  for (let i = 0; i < n && out.length < MAX_TRIGGERS; i++) {
    const close = QUOTES[s[i]];
    if (!close) continue;
    if (i === 0 ? from !== 0 : i - 1 < from || /\w/.test(s[i - 1])) continue;
    const j = next[close][i + 1];
    if (j >= n || j === i + 1) continue;   // unclosed, or empty quotes
    const p = s.slice(i + 1, j).trim();
    if (p && p.length <= TRIGGER_MAX && !seen.has(p)) { seen.add(p); out.push(p); }
    from = j + 1; i = j;
  }
  return out;
}

// split a TOML table path (a.b."c d") into parts
function tomlPath(s) {
  const parts = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) parts.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return parts;
}
function headerOf(line) {
  const m = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
  return m ? tomlPath(m[1]) : null;
}
const isAnyHeader = line => /^\s*\[\[?[^\[\]]+\]\]?\s*(?:#.*)?$/.test(line);

// classify each line: a table header ([x] / [[x]]) only when it is not inside a multi-line array,
// inline table or multi-line string opened by an earlier value
//   → [{ line, header: bool, path: string[]|null (for [x] headers), cont: bool (continuation of an earlier value) }]
function tomlLines(lines) {
  const out = [];
  let depth = 0;     // open [ / { in values
  let ml = null;     // open multi-line string delimiter: '"""' or "'''"
  for (const line of lines) {
    const cont = depth > 0 || ml !== null;
    if (!cont && isAnyHeader(line)) { out.push({ line, header: true, path: headerOf(line), cont: false }); continue; }
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (ml) {
        if (ml[0] === '"' && line[i] === '\\') { i += 2; continue; }
        if (!line.startsWith(ml, i)) { i++; continue; }
        i += 3;
        while (line[i] === ml[0]) i++; // a closing delimiter may carry up to two extra quotes
        ml = null;
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { ml = c.repeat(3); i += 3; continue; }
        i++;
        while (i < n && line[i] !== c) { if (c === '"' && line[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && depth > 0) depth--;
      i++;
    }
    out.push({ line, header: false, path: null, cont });
  }
  out.open = depth > 0 || ml !== null; // a value never closed: section ends cannot be trusted
  return out;
}

function tomlMcpServers(text) {
  const servers = new Map();
  let cur = null;
  for (const { line, header, path: h, cont } of tomlLines(String(text || '').split(/\r?\n/))) {
    if (header) {
      cur = null;
      if (h && h[0] === 'mcp_servers' && h.length >= 2) {
        let s = servers.get(h[1]);
        if (!s) { s = { name: h[1], keys: [], transport: 'stdio' }; servers.set(h[1], s); }
        if (h.length > 2 && !s.keys.includes(h[2])) s.keys.push(h[2]);
        cur = h.length === 2 ? s : null;
      }
      continue;
    }
    if (!cur || cont) continue;
    const kv = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
    if (kv) {
      const k = unquote(kv[1]);
      if (!cur.keys.includes(k)) cur.keys.push(k);
      if (k === 'url') cur.transport = 'http';
    }
  }
  return [...servers.values()];
}

function tomlRemoveSection(text, name) {
  const src = String(text || '');
  const lines = tomlLines(src.split(/(?<=\n)/));
  if (lines.open) return { text: src, removed: null }; // unterminated value: refuse rather than guess where the section ends
  const kept = [];
  const gone = [];
  let drop = false;
  for (const { line, header, path: h } of lines) {
    if (header) drop = !!h && h[0] === 'mcp_servers' && h[1] === name;
    (drop ? gone : kept).push(line);
  }
  if (!gone.length) return { text: src, removed: null };
  return { text: kept.join(''), removed: gone.join('') };
}

const REPO = cwd => (typeof cwd === 'string' && cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

// one usage from a tool call / prompt text, or null
function usageOfTool(name, input) {
  if (name === 'Skill') {
    const k = input && typeof input.skill === 'string' ? input.skill.trim() : '';
    return k ? { key: k, kind: 'skill' } : null;
  }
  // /^mcp__(.+?)__(.+)$/ without its quadratic backtracking: a server of 1+ chars, the first "__" after it, a tool of
  // 1+ chars; no line terminator anywhere ('.' does not match one)
  const s = typeof name === 'string' ? name : '';
  if (!s.startsWith('mcp__') || /[\n\r\u2028\u2029]/.test(s)) return null;
  const k = s.indexOf('__', 6);
  return k > 0 && k + 2 < s.length ? { key: s.slice(5, k), kind: 'mcp', tool: s.slice(k + 2) } : null;
}
function usageOfPrompt(text) {
  if (typeof text !== 'string') return null;
  const c = /<command-name>\s*\/([\w:.-]+)\s*<\/command-name>/.exec(text);
  const m = c || /^\s*\/([\w:.-]+)/.exec(text);
  return m ? { key: m[1], kind: 'skill' } : null;
}

function usageFromRecord(rec) {
  const ev = rec && rec.ev;
  if (!ev || typeof ev !== 'object') return [];
  const at = typeof rec.ts === 'number' ? Math.round(rec.ts * 1000) : NaN;
  if (!Number.isFinite(at)) return [];
  let u = null;
  if (ev.hook_event_name === 'PreToolUse') u = usageOfTool(ev.tool_name, ev.tool_input);
  else if (ev.hook_event_name === 'UserPromptSubmit') u = usageOfPrompt(ev.prompt);
  return u ? [{ ...u, agent: rec.agent || 'claude', at, repo: REPO(ev.cwd) }] : [];
}

function usageFromTranscriptLine(line, agent = 'claude') {
  let o;
  try { o = JSON.parse(line); } catch { return []; }
  const msg = o && o.message;
  if (!msg || typeof o !== 'object') return [];
  const at = Date.parse(o.timestamp);
  if (!Number.isFinite(at)) return [];
  const repo = REPO(o.cwd);
  const out = [];
  const push = u => { if (u) out.push({ ...u, agent, at, repo }); };
  const content = msg.content;
  if (typeof content === 'string') { if (o.type === 'user' || msg.role === 'user') push(usageOfPrompt(content)); }
  else if (Array.isArray(content)) {
    for (const it of content) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'tool_use') push(usageOfTool(it.name, it.input));
      else if (it.type === 'text' && (o.type === 'user' || msg.role === 'user')) push(usageOfPrompt(it.text));
    }
  }
  return out;
}

function mastery(n) {
  return n >= 20 ? 3 : n >= 5 ? 2 : n >= 1 ? 1 : 0;
}

function weekCount(byDay, now) {
  let sum = 0;
  const base = new Date(now);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    sum += (byDay && byDay[key]) || 0;
  }
  return sum;
}

const AgentDeskSkillbook = { parseSkillMd, tomlLines, tomlMcpServers, tomlRemoveSection, usageFromRecord, usageFromTranscriptLine, mastery, weekCount };
root.AgentDeskSkillbook = AgentDeskSkillbook;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskSkillbook;
})(typeof globalThis !== 'undefined' ? globalThis : this);
