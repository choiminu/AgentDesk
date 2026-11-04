// Skillbook actions: turn off / on, remove / restore one skill, plugin or MCP server. Main process only.
//   actOn({ home, item, action, trash, run, repos? }) → { ok: true } | { ok: false, error: 'gone'|'unsupported'|'failed', detail? }
//     detail is one of DETAILS (fixed codes): exception messages, file text and CLI output never reach the caller
//     action: 'off' | 'on' | 'remove' | 'restore'; item: a scanInventory item (restore: a listRemoved row, looked up by id)
//     repos: the repo paths the scan was given (limits which <repo>/.claude/skills folders remove may trash)
//     a parked item's / removed row's id is its stored entry's own key (sid), so on / restore act on that exact copy
//     trash(path) → Promise<void> (shell.trashItem); run(cmd, args) → Promise<{ code, stdout, stderr }> (execFile wrapper)
//   listRemoved({ home, now }) → [{ id, kind, name, removedAt, how }]  removed in the last 30 days, no config contents
//
// Skills: off/on move the folder between <root>/skills and <root>/skills-disabled (~/.claude, ~/.agents); remove → trash.
// Plugins: the claude CLI (disable / enable / uninstall / install).
// .mcp.json servers (a team file in git): off / on only, through Claude Code's own per-project switch
// ~/.claude.json projects[<exact key>].disabledMcpjsonServers; the .mcp.json itself is never written. No remove / restore.
// MCP: the entry is taken out of its config into ~/.roca/skillbook-parked.json (off) or skillbook-removed.json (remove),
// verbatim (JSON object or exact TOML text), and written back by on / restore. Those files hold secrets: mode 0600, main only.
// Every config write re-reads the file first, fails with 'gone' when the entry is no longer there (nothing written),
// backs the file up to ~/.roca/skillbook-backup, changes only that entry and writes atomically.
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook
import { readJsonStrict, writeJsonAtomic, backupPrivate } from '../perm/settings.mjs';

const { tomlLines, tomlMcpServers, tomlRemoveSection } = globalThis.AgentDeskSkillbook;
const KEEP_REMOVED_MS = 30 * 24 * 60 * 60 * 1000;
const PARKED = 'skillbook-parked.json';
const REMOVED = 'skillbook-removed.json';
const ACTIONS = ['off', 'on', 'remove', 'restore'];
const PLUGIN_PART = /^[\w.:+-]+$/;
const KEEP_BACKUPS = 20; // per config file name in ~/.roca/skillbook-backup (0600 copies that hold secrets)
const DETAILS = new Set(['bad request', 'action', 'location', 'plugin', 'kind', 'trash', 'empty', 'unparsed', 'exists', 'missing', 'invalid JSON', 'io', 'cli']);
// a thrown error as a fixed code (its message may quote a config file)
const errDetail = e => (e && (e.code === 'EJSON' || e instanceof SyntaxError) ? 'invalid JSON' : e && e.code === 'ENOENT' ? 'missing' : 'io');

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const fail = (error, detail) => (detail ? { ok: false, error, detail } : { ok: false, error });
const exists = p => { try { lstatSync(p); return true; } catch { return false; } };

// ---------- ~/.roca stores ----------
const storeFile = (home, name) => join(home, '.roca', name);
function readStore(home, name) {
  const o = readJsonStrict(storeFile(home, name)); // {} when missing; throws when broken (never overwrite it)
  return { v: 1, entries: Array.isArray(o.entries) ? o.entries.filter(e => isObj(e) && typeof e.id === 'string') : [] };
}
function writeStore(home, name, store, now) {
  const entries = name === REMOVED ? store.entries.filter(e => typeof e.at === 'number' && now - e.at <= KEEP_REMOVED_MS) : store.entries;
  mkdirSync(join(home, '.roca'), { recursive: true, mode: 0o700 });
  const f = storeFile(home, name);
  writeJsonAtomic(f, { v: 1, entries });
  chmodSync(f, 0o600);
}
// every stored copy has its own key (sid = <item id>@<at>, made unique); entries are never replaced, so a stored
// config (often the only copy) is never overwritten by a later off / remove of the same name. Old entries without sid use id.
const keyOf = e => (typeof e.sid === 'string' && e.sid ? e.sid : e.id);
function withEntry(store, e) {
  const taken = new Set(store.entries.map(keyOf));
  const base = typeof e.sid === 'string' && e.sid ? e.sid : `${e.id}@${e.at}`;
  let sid = base;
  for (let n = 2; taken.has(sid); n++) sid = `${base}.${n}`;
  return { v: 1, entries: store.entries.concat({ ...e, sid }) };
}
function without(store, key) {
  const i = store.entries.findIndex(e => keyOf(e) === key);
  return { v: 1, entries: i < 0 ? store.entries : store.entries.filter((_, j) => j !== i) };
}
const findLive = (store, key, now, expires) => store.entries.find(e => keyOf(e) === key && (!expires || (typeof e.at === 'number' && now - e.at <= KEEP_REMOVED_MS)));

function baseEntry(item, now) {
  const agents = Array.isArray(item.agents) && item.agents.length ? item.agents : ['claude'];
  return { id: item.id, kind: item.kind, agent: agents.length > 1 ? 'shared' : agents[0], name: item.name, at: now };
}
// the non-secret summary the scan shows for a parked entry
function mcpSummary(m) {
  const out = {};
  if (!isObj(m)) return out;
  for (const k of ['transport', 'command', 'scope']) if (typeof m[k] === 'string') out[k] = m[k];
  for (const k of ['envKeys', 'headerKeys']) if (Array.isArray(m[k])) out[k] = m[k].filter(x => typeof x === 'string');
  return out;
}

function backup(home, file) {
  const dir = join(home, '.roca', 'skillbook-backup'), base = basename(file);
  backupPrivate(file, dir, `${base}.${Date.now()}`);
  pruneBackups(dir, base);
}
// keep the newest KEEP_BACKUPS copies of one config (named <base>.<ms>); other files in the folder are left alone
function pruneBackups(dir, base) {
  let names; try { names = readdirSync(dir); } catch { return; }
  const at = n => Number(n.slice(base.length + 1));
  const mine = names.filter(n => n.startsWith(`${base}.`) && /^\d+$/.test(n.slice(base.length + 1))).sort((a, b) => at(b) - at(a));
  for (const n of mine.slice(KEEP_BACKUPS)) { try { unlinkSync(join(dir, n)); } catch { /* next time */ } }
}
function writeTextAtomic(file, text) {
  let mode = 0o600; try { mode = statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.agentdesk-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    try { chmodSync(tmp, mode); } catch {}
    renameSync(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}

// ---------- MCP locations ----------
// only the files the scan reads; a loc pointing anywhere else is refused
function checkLoc(home, loc) {
  if (!isObj(loc) || typeof loc.file !== 'string' || !isAbsolute(loc.file)) return null;
  const f = resolve(loc.file);
  const want = { 'claude-user': join(home, '.claude.json'), 'claude-project': join(home, '.claude.json'), codex: join(home, '.codex', 'config.toml'), gemini: join(home, '.gemini', 'settings.json') }[loc.where];
  if (want ? f !== resolve(want) : !(loc.where === 'mcpjson' && basename(f) === '.mcp.json')) return null;
  if (loc.where === 'claude-project' && (typeof loc.project !== 'string' || !loc.project)) return null;
  let real = f;
  try { real = realpathSync(f); } catch { /* missing: written where it is */ }
  return { ...loc, file: real }; // a symlinked config: read, back up and write its target, the link stays
}

// the mcpServers object holding the entry (create: make missing containers for on / restore)
function jsonBox(obj, loc, create) {
  let parent = obj;
  if (loc.where === 'claude-project') {
    if (!has(obj, 'projects') && create) obj.projects = {};
    if (!isObj(obj.projects)) return null;
    if (!has(obj.projects, loc.project) && create) obj.projects = { ...obj.projects, [loc.project]: {} };
    parent = obj.projects[loc.project];
    if (!isObj(parent)) return null;
  }
  if (!has(parent, 'mcpServers') && create) parent.mcpServers = {};
  return isObj(parent.mcpServers) ? { parent, box: parent.mcpServers } : null;
}

// take one entry out of its config; returns { data, before } or a failure
function takeOut(home, loc, name, commit) {
  if (loc.where === 'codex') {
    let text;
    try { text = readFileSync(loc.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fail('gone'); throw e; }
    if (!tomlMcpServers(text).some(s => s.name === name)) return fail('gone');
    const r = tomlRemoveSection(text, name);
    if (!r.removed) return fail('failed', 'unparsed');
    const before = nextHeader(text, name);
    commit({ toml: r.removed, ...(before !== undefined ? { before } : {}) }, () => { backup(home, loc.file); writeTextAtomic(loc.file, r.text); });
    return { ok: true };
  }
  if (!existsSync(loc.file)) return fail('gone');
  const obj = readJsonStrict(loc.file);
  const at = jsonBox(obj, loc, false);
  if (!at || !has(at.box, name)) return fail('gone');
  const keys = Object.keys(at.box);
  const before = keys[keys.indexOf(name) + 1];
  const data = at.box[name];
  delete at.box[name];
  commit({ json: data, ...(before !== undefined ? { before } : {}) }, () => { backup(home, loc.file); writeJsonAtomic(loc.file, obj); });
  return { ok: true };
}

// the first header after the [mcp_servers.<name>] section starts that is not part of it (where the text goes back)
function nextHeader(text, name) {
  let inside = false;
  for (const { line, header, path } of tomlLines(text.split(/\r?\n/))) {
    if (!header) continue;
    const ours = !!path && path[0] === 'mcp_servers' && path[1] === name;
    if (ours) inside = true;
    else if (inside) return line;
  }
  return undefined;
}

// write one stored entry back into its config; refuses to overwrite an entry of the same name
function putBack(home, entry) {
  const loc = checkLoc(home, entry.loc);
  if (!loc) return fail('unsupported', 'location');
  const name = entry.name;
  if (loc.where === 'codex') {
    if (typeof entry.toml !== 'string' || !entry.toml) return fail('failed', 'empty');
    let text = '';
    try { text = readFileSync(loc.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (tomlMcpServers(text).some(s => s.name === name)) return fail('failed', 'exists');
    const lines = tomlLines(text.split(/(?<=\n)/));
    if (lines.open) return fail('failed', 'unparsed'); // a value never closes: no safe place to insert
    const nl = /\r\n/.test(text) ? '\r\n' : '\n';
    let pos = -1, off = 0;
    if (typeof entry.before === 'string') {
      for (const l of lines) { if (l.header && l.line.replace(/\r?\n$/, '') === entry.before) { pos = off; break; } off += l.line.length; }
    }
    let add = entry.toml;
    if (pos >= 0 && !add.endsWith('\n')) add += nl; // never join the restored text onto the next header
    const out = pos >= 0 ? text.slice(0, pos) + add + text.slice(pos) : text + (text && !text.endsWith('\n') ? nl : '') + add;
    if (existsSync(loc.file)) backup(home, loc.file);
    else mkdirSync(dirname(loc.file), { recursive: true });
    writeTextAtomic(loc.file, out);
    return { ok: true };
  }
  if (!isObj(entry.json)) return fail('failed', 'empty');
  if (loc.where === 'claude-user' || loc.where === 'claude-project') {
    // ~/.claude.json is Claude Code's own state file: never create one holding only mcpServers
    let raw = '';
    try { raw = readFileSync(loc.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!raw.trim()) return fail('failed', 'missing');
  }
  const obj = readJsonStrict(loc.file);
  const at = jsonBox(obj, loc, true);
  if (!at) return fail('failed', 'unparsed');
  if (has(at.box, name)) return fail('failed', 'exists');
  const pairs = Object.entries(at.box);
  const i = typeof entry.before === 'string' ? pairs.findIndex(([k]) => k === entry.before) : -1;
  pairs.splice(i >= 0 ? i : pairs.length, 0, [name, entry.json]);
  at.parent.mcpServers = Object.fromEntries(pairs); // same key: the parent's key order is kept
  if (existsSync(loc.file)) backup(home, loc.file);
  writeJsonAtomic(loc.file, obj);
  return { ok: true };
}

// off / remove of an MCP entry: store first, then the config (store rolled back if the config write fails)
function mcpOut(home, item, storeName, now) {
  const loc = checkLoc(home, item.loc);
  if (!loc) return fail('unsupported', 'location');
  const store = readStore(home, storeName);
  return takeOut(home, loc, item.name, (data, writeConfig) => {
    const e = { ...baseEntry(item, now), loc: item.loc, ...(storeName === REMOVED ? { how: 'config' } : {}), ...data, mcp: mcpSummary(item.mcp) };
    writeStore(home, storeName, withEntry(store, e), now);
    try { writeConfig(); } catch (err) { writeStore(home, storeName, store, now); throw err; }
  });
}

// .mcp.json server off / on: add or drop its name in ~/.claude.json projects[loc.project].disabledMcpjsonServers
function mcpjsonSwitch(home, item, action) {
  const loc = item.loc;
  if (!isObj(loc) || typeof loc.file !== 'string' || !isAbsolute(loc.file) || basename(loc.file) !== '.mcp.json') return fail('unsupported', 'location');
  if (typeof loc.project !== 'string' || !loc.project) return fail('failed', 'missing'); // Claude Code has no entry for this folder yet
  if (resolve(loc.project) !== dirname(resolve(loc.file))) return fail('unsupported', 'location');
  let cj = join(home, '.claude.json');
  try { cj = realpathSync(cj); } catch { /* missing: refused below */ }
  if (!existsSync(cj)) return fail('failed', 'missing');
  const obj = readJsonStrict(cj); // re-read right before the write
  const proj = isObj(obj.projects) && has(obj.projects, loc.project) ? obj.projects[loc.project] : null;
  if (!isObj(proj)) return fail('failed', 'missing'); // never create a project entry
  const list = has(proj, 'disabledMcpjsonServers') ? proj.disabledMcpjsonServers : [];
  if (!Array.isArray(list)) return fail('failed', 'unparsed');
  const name = item.name;
  if (action === 'off') {
    const team = readJsonStrict(loc.file);
    if (!isObj(team.mcpServers) || !has(team.mcpServers, name)) return fail('gone');
    if (list.includes(name)) return { ok: true }; // already off
    proj.disabledMcpjsonServers = list.concat(name);
  } else {
    if (!list.includes(name)) return fail('gone');
    proj.disabledMcpjsonServers = list.filter(x => x !== name);
  }
  backup(home, cj);
  writeJsonAtomic(cj, obj);
  return { ok: true };
}

// ---------- skills ----------
function skillMove(home, item, action) {
  if (item.plugin || typeof item.path !== 'string' || !isAbsolute(item.path)) return fail('unsupported', 'location');
  const path = resolve(item.path);
  const from = action === 'off' ? 'skills' : 'skills-disabled';
  const to = action === 'off' ? 'skills-disabled' : 'skills';
  const roots = [join(home, '.claude'), join(home, '.agents')].map(r => resolve(r, from));
  if (!roots.includes(dirname(path))) return fail('unsupported', 'location');
  if (!exists(path)) return fail('gone');
  const dest = join(dirname(dirname(path)), to, basename(path));
  if (exists(dest)) return fail('failed', 'exists');
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(path, dest);
  return { ok: true };
}
// a skill folder may be trashed only from a folder the scan reads: the home roots, or <repo>/.claude/skills of
// the item's repo (one of `repos` when given, otherwise a repo whose folder name is item.repo)
function removableSkill(home, item, repos) {
  const parent = dirname(resolve(item.path));
  const roots = [['.claude', 'skills'], ['.claude', 'skills-disabled'], ['.agents', 'skills'], ['.agents', 'skills-disabled'], ['.codex', 'skills']].map(p => resolve(home, ...p));
  if (roots.includes(parent)) return true;
  if (typeof item.repo !== 'string' || !item.repo || basename(parent) !== 'skills' || basename(dirname(parent)) !== '.claude') return false;
  const repo = dirname(dirname(parent));
  if (basename(repo) !== item.repo) return false;
  return !Array.isArray(repos) || repos.some(r => typeof r === 'string' && resolve(r) === repo);
}
async function skillRemove(home, item, trash, now, repos) {
  if (item.plugin || typeof item.path !== 'string' || !isAbsolute(item.path)) return fail('unsupported', 'location');
  const path = resolve(item.path);
  if (!removableSkill(home, item, repos)) return fail('unsupported', 'location');
  if (!exists(path)) return fail('gone');
  readStore(home, REMOVED); // a broken store fails before anything moves
  await trash(path);
  writeStore(home, REMOVED, withEntry(readStore(home, REMOVED), { ...baseEntry(item, now), path, how: 'trash' }), now); // re-read after the await
  return { ok: true };
}

// ---------- plugins ----------
function pluginRef(name, marketplace) {
  if (typeof name !== 'string' || !PLUGIN_PART.test(name) || name.startsWith('-')) return null;
  if (marketplace && (typeof marketplace !== 'string' || !PLUGIN_PART.test(marketplace))) return null;
  return marketplace ? `${name}@${marketplace}` : name;
}
async function claude(run, args) {
  let r;
  try { r = await run('claude', args); } catch { return fail('failed', 'cli'); }
  if (!r || r.code !== 0) return fail('failed', 'cli'); // the CLI's output stays in main
  return { ok: true };
}

// ---------- entry points ----------
export async function actOn(req = {}) {
  const r = await act(req);
  if (r && r.ok === false && r.detail !== undefined && !DETAILS.has(r.detail)) return { ...r, detail: 'io' };
  return r;
}
async function act({ home, item, action, trash, run, repos } = {}) {
  if (typeof home !== 'string' || !home || !isObj(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return fail('failed', 'bad request');
  if (!ACTIONS.includes(action)) return fail('unsupported', 'action');
  const now = Date.now();
  try {
    if (action === 'restore') return await restore(home, item, run, now);
    if (item.kind === 'skill') return action === 'remove' ? await skillRemove(home, item, trash, now, repos) : skillMove(home, item, action);
    if (item.kind === 'plugin') {
      if (item.source === 'extension' || !(item.agents || []).includes('claude')) return fail('unsupported', 'plugin');
      const ref = pluginRef(item.name, item.plugin && item.plugin.marketplace);
      if (!ref) return fail('unsupported', 'plugin');
      if (action !== 'remove') return await claude(run, ['plugin', action === 'off' ? 'disable' : 'enable', ref]);
      readStore(home, REMOVED); // a broken store fails before the CLI runs
      const r = await claude(run, ['plugin', 'uninstall', ref]);
      if (!r.ok) return r;
      writeStore(home, REMOVED, withEntry(readStore(home, REMOVED), { ...baseEntry(item, now), how: 'plugin', plugin: { name: item.name, marketplace: (item.plugin && item.plugin.marketplace) || '' } }), now);
      return r;
    }
    if (item.kind !== 'mcp') return fail('unsupported', 'kind');
    if (isObj(item.loc) && item.loc.where === 'mcpjson') return action === 'remove' ? fail('unsupported', 'location') : mcpjsonSwitch(home, item, action);
    if (action === 'off') return mcpOut(home, item, PARKED, now);
    if (action === 'remove') {
      const parked = readStore(home, PARKED);
      const p = findLive(parked, item.id, now, false);
      if (item.on === false && p) { // already parked: move the stored entry over
        const removed = readStore(home, REMOVED);
        writeStore(home, REMOVED, withEntry(removed, { ...p, at: now, how: 'config' }), now);
        writeStore(home, PARKED, without(parked, item.id), now);
        return { ok: true };
      }
      return mcpOut(home, item, REMOVED, now);
    }
    // on
    const parked = readStore(home, PARKED);
    const p = findLive(parked, item.id, now, false);
    if (!p || p.kind !== 'mcp') return fail('gone');
    const r = putBack(home, p);
    if (!r.ok) return r;
    writeStore(home, PARKED, without(parked, item.id), now);
    return r;
  } catch (e) {
    return fail('failed', errDetail(e));
  }
}

async function restore(home, item, run, now) {
  const e = findLive(readStore(home, REMOVED), item.id, now, true);
  if (!e) return fail('gone');
  if (e.kind === 'skill') return fail('unsupported', 'trash');
  let r;
  if (e.kind === 'plugin') {
    const ref = isObj(e.plugin) && pluginRef(e.plugin.name, e.plugin.marketplace);
    if (!ref) return fail('unsupported', 'plugin');
    r = await claude(run, ['plugin', 'install', ref]);
  } else if (e.kind === 'mcp') {
    if (isObj(e.loc) && e.loc.where === 'mcpjson') return fail('unsupported', 'location'); // never write a team file
    r = putBack(home, e);
  }
  else return fail('unsupported', 'kind');
  if (!r.ok) return r;
  writeStore(home, REMOVED, without(readStore(home, REMOVED), keyOf(e)), now); // re-read: the CLI call awaited
  return r;
}

export function listRemoved({ home, now = Date.now() } = {}) {
  let store;
  try { store = readStore(home, REMOVED); } catch { return []; }
  return store.entries
    .filter(e => typeof e.at === 'number' && now - e.at <= KEEP_REMOVED_MS)
    .map(e => ({ id: keyOf(e), kind: e.kind, name: typeof e.name === 'string' ? e.name : '', removedAt: e.at, how: typeof e.how === 'string' ? e.how : '' }));
}
