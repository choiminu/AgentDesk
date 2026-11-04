// AgentDesk core: Skillbook pure helpers (SKILL.md front matter, Codex TOML MCP sections, usage records, mastery).
// No DOM, no Electron, no I/O. Loaded as a classic <script> (global AgentDeskSkillbook) or required from main.
//
//   parseSkillMd(text)                   → { name|null, description, triggers[] }  front matter; triggers = quoted phrases (≤ 6, ≤ 40 chars)
//   tomlMcpServers(text)                 → [{ name, keys[], transport: 'stdio'|'http' }]  from [mcp_servers.<name>] sections
//   tomlRemoveSection(text, name)        → { text, removed|null }  drops one [mcp_servers.<name>] section (and its sub-tables); removed = exact text
//   usageFromRecord(rec)                 → [{ key, kind: 'skill'|'mcp', agent, at(ms), repo }]  from a hook record { ts, agent?, ev }
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
  const seen = new Set();
  const re = /(?:^|[^\w])(?:"([^"]+)"|'([^']+)'|‘([^’]+)’|“([^”]+)”)/g;
  let t;
  while ((t = re.exec(out.description)) && out.triggers.length < MAX_TRIGGERS) {
    const p = (t[1] || t[2] || t[3] || t[4] || '').trim();
    if (p && p.length <= TRIGGER_MAX && !seen.has(p)) { seen.add(p); out.triggers.push(p); }
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
const isAnyHeader = line => /^\s*\[/.test(line);

function tomlMcpServers(text) {
  const servers = new Map();
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (isAnyHeader(line)) {
      const h = headerOf(line);
      cur = null;
      if (h && h[0] === 'mcp_servers' && h.length >= 2) {
        let s = servers.get(h[1]);
        if (!s) { s = { name: h[1], keys: [], transport: 'stdio' }; servers.set(h[1], s); }
        if (h.length > 2 && !s.keys.includes(h[2])) s.keys.push(h[2]);
        cur = h.length === 2 ? s : null;
      }
      continue;
    }
    if (!cur) continue;
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
  const lines = src.split(/(?<=\n)/);
  const kept = [];
  const gone = [];
  let drop = false;
  for (const line of lines) {
    if (isAnyHeader(line)) {
      const h = headerOf(line);
      drop = !!h && h[0] === 'mcp_servers' && h[1] === name;
    }
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
  const m = /^mcp__(.+?)__.+$/.exec(typeof name === 'string' ? name : '');
  return m ? { key: m[1], kind: 'mcp' } : null;
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

const AgentDeskSkillbook = { parseSkillMd, tomlMcpServers, tomlRemoveSection, usageFromRecord, usageFromTranscriptLine, mastery, weekCount };
root.AgentDeskSkillbook = AgentDeskSkillbook;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskSkillbook;
})(typeof globalThis !== 'undefined' ? globalThis : this);
