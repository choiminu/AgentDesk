// Skillbook inventory scan: read-only, synchronous, one try/catch per source.
// Returns names, paths and key NAMES only for MCP servers: never env/header values, args, URLs or full commands.
import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook (package is type:module, so no module.exports)

const { parseSkillMd, tomlLines, tomlMcpServers } = globalThis.AgentDeskSkillbook;
const SKILL_READ_MAX = 64 * 1024;
const ALL = ['claude', 'codex', 'gemini'];
const WHERES = ['claude-user', 'claude-project', 'mcpjson', 'codex', 'gemini'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const baseOf = cmd => (typeof cmd === 'string' ? (cmd.trim().split(/\s+/)[0] || '').split(/[\\/]/).pop() : '') || undefined;
const names = o => (isObj(o) ? Object.keys(o) : []);
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
function readHead(f) {
  if (!statSync(f).isFile()) throw new Error('not a file');
  const fd = openSync(f, 'r');
  try { const b = Buffer.alloc(SKILL_READ_MAX); return b.toString('utf8', 0, readSync(fd, b, 0, SKILL_READ_MAX, 0)); } finally { closeSync(fd); }
}
const subdirs = dir => readdirSync(dir).filter(n => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } }).sort();

// one MCP entry from a JSON config; secrets stay behind
function mcpFromJson(def, gemini = false) {
  const d = isObj(def) ? def : {};
  const url = d.url || d.httpUrl;
  let transport = d.type === 'sse' || (typeof url === 'string' && /\/sse\b/.test(url) && d.type !== 'http') ? 'sse' : url ? 'http' : 'stdio';
  if (gemini) transport = d.httpUrl ? 'http' : d.url ? 'sse' : 'stdio'; // Gemini: url = SSE, httpUrl = streamable HTTP
  const out = { transport, envKeys: names(d.env) };
  const command = baseOf(d.command);
  if (command) out.command = command;
  const headerKeys = names(d.headers);
  if (headerKeys.length) out.headerKeys = headerKeys;
  return out;
}

// the non-secret summary stored with a parked entry (actions.mjs copies it from the scanned item); anything odd is dropped
const KEY_NAME = /^[\w.-]{1,128}$/;
function parkedSummary(m, scope) {
  const d = isObj(m) ? m : {};
  const keys = v => (Array.isArray(v) ? v.filter(k => typeof k === 'string' && KEY_NAME.test(k)) : []);
  const out = { transport: ['stdio', 'http', 'sse'].includes(d.transport) ? d.transport : 'stdio' };
  if (typeof d.command === 'string' && KEY_NAME.test(d.command)) out.command = d.command;
  out.envKeys = keys(d.envKeys);
  const headerKeys = keys(d.headerKeys);
  if (headerKeys.length) out.headerKeys = headerKeys;
  out.scope = scope;
  return out;
}

// light TOML reads of one [mcp_servers.<name>] section: command basename and env key names only
function tomlDetails(text, name) {
  let sec = null; const out = { envKeys: [] };
  for (const { line, header, path: p, cont } of tomlLines(text.split(/\r?\n/))) {
    if (header) {
      sec = p && p[0] === 'mcp_servers' && p[1] === name ? (p.length === 2 ? 'main' : p.length === 3 && p[2] === 'env' ? 'env' : null) : null;
      continue;
    }
    const kv = !cont && /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv || !sec) continue;
    if (sec === 'env') out.envKeys.push(kv[1].replace(/^(["'])(.*)\1$/, '$2'));
    else if (kv[1] === 'command') { const m = /^(["'])(.*?)\1/.exec(kv[2].trim()); const b = m && baseOf(m[2]); if (b) out.command = b; }
  }
  return out;
}

// does a Claude plugin hold anything whose use is recorded (payload.mjs pluginEntry sums "<plugin>:<skill|command>" and
// "plugin_<plugin>_<server>")? A skills/ or commands/ folder with an entry, or MCP servers in its .mcp.json (wrapped in
// mcpServers or flat) or its manifest (.claude-plugin/plugin.json mcpServers: an object, or a path / list of paths).
// Output styles, LSP servers, hooks or agents only, or an install folder that is gone: false — the payload marks such a
// plugin not counted, so it never shows 미사용 or lands in 💤 (where the bulk trash would uninstall a plugin in use).
function pluginCountable(path) {
  if (!path) return false;
  const filled = d => { try { return readdirSync(join(path, d)).some(n => !n.startsWith('.')); } catch { return false; } };
  if (filled('skills') || filled('commands')) return true;
  const servers = v => isObj(v) && Object.values(v).some(isObj);
  try { const j = readJson(join(path, '.mcp.json')); if (servers(isObj(j) && isObj(j.mcpServers) ? j.mcpServers : j)) return true; } catch { /* none or unreadable */ }
  try {
    const m = readJson(join(path, '.claude-plugin', 'plugin.json')).mcpServers;
    if (servers(m) || (typeof m === 'string' && m.trim()) || (Array.isArray(m) && m.length)) return true;
  } catch { /* no manifest */ }
  return false;
}

export function scanInventory({ home, repos = [] } = {}) {
  const items = [];
  const sources = [];
  const seen = new Set();
  const repoPaths = (Array.isArray(repos) ? repos : []).filter(r => typeof r === 'string' && r).map(r => resolve(r));
  const norm = p => resolve(p);

  const add = it => {
    const agentPart = it.agents.length > 1 ? 'shared' : it.agents[0];
    const id = `${it.kind}:${it.source}:${agentPart}:${it.repoKey || it.repo || ''}:${it.idName || it.name}`;
    delete it.idName; delete it.repoKey;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, ...it });
  };

  // run one source; ENOENT on an optional source is silent, otherwise it shows as unreadable
  function source(id, label, fn, { optional = false } = {}) {
    try { fn(); sources.push({ id, label, ok: true }); }
    catch (e) {
      if (optional && e && e.code === 'ENOENT') return;
      sources.push({ id, label, ok: false, error: e && e.code === 'ENOENT' ? 'not found' : e instanceof SyntaxError ? 'invalid JSON' : 'unreadable' });
    }
  }

  // a link in an agent's own skills folder that points into ~/.agents/skills(-disabled) is the shared item, listed once
  const realOr = p => { try { return realpathSync(p); } catch { return null; } };
  const sharedRoots = ['skills', 'skills-disabled'].map(n => realOr(join(home, '.agents', n))).filter(Boolean);
  const linksToShared = p => {
    try { if (!lstatSync(p).isSymbolicLink()) return false; } catch { return false; }
    const r = realOr(p);
    return !!r && sharedRoots.includes(dirname(r));
  };

  function skillsIn(dir, { src, agents, repo, repoKey, on = true, plugin, pluginName, skipShared = false }) {
    for (const d of subdirs(dir)) {
      if (skipShared && linksToShared(join(dir, d))) continue;
      let meta;
      try { meta = parseSkillMd(readHead(join(dir, d, 'SKILL.md'))); } catch { continue; }
      const name = meta.name || d;
      const usageKey = pluginName ? `${pluginName}:${name}` : name;
      add({ kind: 'skill', name, idName: usageKey, agents: agents.slice(), source: src, ...(repo ? { repo, repoKey } : {}), path: join(dir, d),
        description: meta.description, triggers: meta.triggers, on, usageKey, ...(plugin ? { plugin } : {}) });
    }
  }

  function mcpItems(servers, { src, agents, where, file, scope, repo, repoKey, project, disabled = [] }) {
    for (const name of names(servers)) {
      add({ kind: 'mcp', name, idName: `${where}:${name}`, agents: agents.slice(), source: src, ...(repo ? { repo, repoKey } : {}), description: '', triggers: [], on: !disabled.includes(name), usageKey: name,
        mcp: { ...mcpFromJson(servers[name], where === 'gemini'), scope }, loc: { file, where, ...(repo ? { repo } : {}), ...(project ? { project } : {}) } });
    }
  }

  // Claude skills
  const cl = join(home, '.claude');
  source('claude-skills', '~/.claude/skills', () => skillsIn(join(cl, 'skills'), { src: 'user', agents: ['claude'], skipShared: true }), { optional: true });
  source('claude-skills-disabled', '~/.claude/skills-disabled', () => skillsIn(join(cl, 'skills-disabled'), { src: 'user', agents: ['claude'], on: false, skipShared: true }), { optional: true });

  // Claude plugins and their skills
  source('claude-plugins', '~/.claude/plugins', () => {
    const inst = readJson(join(cl, 'plugins', 'installed_plugins.json'));
    let enabled = {};
    try { enabled = readJson(join(cl, 'settings.json')).enabledPlugins || {}; } catch { /* no settings: nothing enabled */ }
    for (const key of names(inst.plugins)) {
      const at = key.lastIndexOf('@');
      const pname = at > 0 ? key.slice(0, at) : key;
      const marketplace = at > 0 ? key.slice(at + 1) : '';
      const list = Array.isArray(inst.plugins[key]) ? inst.plugins[key] : [inst.plugins[key]];
      const rec = list.find(isObj);
      if (!rec) continue;
      const on = enabled[key] === true;
      const path = typeof rec.installPath === 'string' ? rec.installPath : undefined;
      const plugin = { marketplace, ...(rec.version ? { version: String(rec.version) } : {}), countable: pluginCountable(path) };
      add({ kind: 'plugin', name: pname, agents: ['claude'], source: 'plugin', ...(path ? { path } : {}), description: '', triggers: [], on, usageKey: pname, plugin });
      if (path) { try { skillsIn(join(path, 'skills'), { src: 'plugin', agents: ['claude'], on, plugin, pluginName: pname }); } catch { /* plugin without skills */ } }
    }
  });

  // shared and Codex skills
  source('agents-skills', '~/.agents/skills', () => skillsIn(join(home, '.agents', 'skills'), { src: 'shared', agents: ALL }), { optional: true });
  source('agents-skills-disabled', '~/.agents/skills-disabled', () => skillsIn(join(home, '.agents', 'skills-disabled'), { src: 'shared', agents: ALL, on: false }), { optional: true });
  source('codex-skills', '~/.codex/skills', () => skillsIn(join(home, '.codex', 'skills'), { src: 'user', agents: ['codex'], skipShared: true }), { optional: true });

  // Claude MCP: user level, and project level for listed repos only
  let claudeJson = null; // kept for the .mcp.json servers below: their off switch lives in projects[<repo>]
  source('claude-mcp', '~/.claude.json', () => {
    const file = join(home, '.claude.json');
    const j = readJson(file);
    claudeJson = isObj(j) ? j : null;
    mcpItems(j.mcpServers, { src: 'user', agents: ['claude'], where: 'claude-user', file, scope: 'user' });
    if (isObj(j.projects)) {
      for (const p of Object.keys(j.projects)) {
        if (!repoPaths.includes(norm(p))) continue;
        mcpItems(j.projects[p] && j.projects[p].mcpServers, { src: 'project', agents: ['claude'], where: 'claude-project', file, scope: 'project', repo: basename(norm(p)), repoKey: norm(p), project: p });
      }
    }
  });

  // Codex MCP
  source('codex-mcp', '~/.codex/config.toml', () => {
    const file = join(home, '.codex', 'config.toml');
    const text = readFileSync(file, 'utf8');
    for (const s of tomlMcpServers(text)) {
      const d = tomlDetails(text, s.name);
      add({ kind: 'mcp', name: s.name, idName: `codex:${s.name}`, agents: ['codex'], source: 'user', description: '', triggers: [], on: true, usageKey: s.name,
        mcp: { transport: s.transport, ...(d.command ? { command: d.command } : {}), envKeys: d.envKeys, scope: 'user' }, loc: { file, where: 'codex' } });
    }
  });

  // Gemini MCP and extensions
  source('gemini-mcp', '~/.gemini/settings.json', () => {
    const file = join(home, '.gemini', 'settings.json');
    mcpItems(readJson(file).mcpServers, { src: 'user', agents: ['gemini'], where: 'gemini', file, scope: 'user' });
  });
  source('gemini-extensions', '~/.gemini/extensions', () => {
    const dir = join(home, '.gemini', 'extensions');
    for (const d of subdirs(dir)) {
      let m;
      try { m = readJson(join(dir, d, 'gemini-extension.json')); } catch { continue; }
      const name = typeof m.name === 'string' && m.name ? m.name : d;
      add({ kind: 'plugin', name, agents: ['gemini'], source: 'extension', path: join(dir, d), description: typeof m.description === 'string' ? m.description : '', triggers: [], on: true, usageKey: name,
        plugin: { marketplace: 'gemini', ...(m.version ? { version: String(m.version) } : {}) } });
    }
  }, { optional: true });

  // per-repo sources
  for (const r of repoPaths) {
    const repo = basename(r);
    source(`repo-skills:${r}`, `${repo}/.claude/skills`, () => skillsIn(join(r, '.claude', 'skills'), { src: 'project', agents: ['claude'], repo, repoKey: r }), { optional: true });
    source(`repo-mcp:${r}`, `${repo}/.mcp.json`, () => {
      const file = join(r, '.mcp.json');
      const servers = readJson(file).mcpServers;
      // Claude Code's per-project switch: ~/.claude.json projects[<exact key>].disabledMcpjsonServers
      const projects = claudeJson && isObj(claudeJson.projects) ? claudeJson.projects : {};
      const project = Object.keys(projects).find(p => isObj(projects[p]) && norm(p) === r);
      const off = project && projects[project].disabledMcpjsonServers;
      const disabled = Array.isArray(off) ? off.filter(x => typeof x === 'string') : [];
      mcpItems(servers, { src: 'project', agents: ['claude'], where: 'mcpjson', file, scope: 'project', repo, repoKey: r, ...(project ? { project } : {}), disabled });
    }, { optional: true });
  }

  // parked (turned-off) MCP entries: id/name/agent/loc and the stored non-secret summary only, never json/toml
  source('parked', '~/.roca/skillbook-parked.json', () => {
    const p = readJson(join(home, '.roca', 'skillbook-parked.json'));
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (!isObj(e) || e.kind !== 'mcp' || typeof e.id !== 'string' || typeof e.name !== 'string') continue;
      const id = typeof e.sid === 'string' && e.sid ? e.sid : e.id; // each stored copy is its own item
      const agent = ALL.includes(e.agent) ? e.agent : 'claude';
      const where = e.loc && e.loc.where;
      if (!WHERES.includes(where) || typeof e.loc.file !== 'string' || !e.loc.file) continue;
      const project = where === 'claude-project' || where === 'mcpjson';
      const loc = { file: e.loc.file, where, ...(typeof e.loc.repo === 'string' ? { repo: e.loc.repo } : {}), ...(where === 'claude-project' && typeof e.loc.project === 'string' ? { project: e.loc.project } : {}) };
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, kind: 'mcp', name: e.name, agents: [agent], source: project ? 'project' : 'user', ...(loc.repo ? { repo: loc.repo } : {}),
        description: '', triggers: [], on: false, usageKey: e.name, mcp: parkedSummary(e.mcp, project ? 'project' : 'user'), loc });
    }
  }, { optional: true });

  return { items, sources };
}
