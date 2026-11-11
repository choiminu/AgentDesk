// AgentDesk core: sessions grouped into projects, where a project is a folder. No DOM, no I/O.
// Loaded as a classic <script> (global AgentDeskProjects) or required from tests.
//
// A session belongs to the project whose folder holds its work folder — git or no git. Three kinds, first match wins:
//   user     a folder the user made a project (by widening one, or merging two): the deepest one that holds the session
//   orca     an Orca repository (by its id): its worktree sessions, and any other session working under the folder
//            those worktrees live in
//   folder   nothing else matched: the session's own work folder is its project
// The list keeps its order: projects stay where they are (cfg.order), a new one goes to the end. Urgency is shown
// elsewhere (a "now" section), not by moving projects around.
//
//   norm(path)                      → the path without a trailing slash ('' for anything that is not an absolute path)
//   under(path, root)               → path is root or inside it (by whole segments)
//   parentOf(path)                  → one folder up ('' at the top)
//   commonParent(a, b)              → the deepest folder holding both ('' when only the filesystem root does)
//   group(sessions, cfg, now)       → { projects: [{ id, kind, name, path, sessions, live, old, folders }], order }
//        sessions: [{ id, cwd, home?, orca?: repository id, repoName?, status, needsInput, time, keep? }]
//        home: the folder that decides the project when it is not the work folder itself (a worktree → its repository)
//        cfg: { user: [{ path, name? }], names: { id: name }, order: [id], folded: { id: true } }
//        live / old: sessions split by "finished over OLD_MS ago"; folders: distinct work folders in the project
//   worktreeName(text)              → the name when it can be a folder and a branch at once, else ''
//   homeOf(cwd, links)              → the repository root of a work folder inside a worktree AgentDesk made ('' otherwise)
//   nowList(sessions, now)          → sessions that need an answer, then those that stopped for input in the last NOW_MS
//   widen(cfg, project)             → cfg with the project's folder moved one level up as a user project (null at the top)
//   merge(cfg, a, b)                → cfg with a user project at the common parent of a and b (null when there is none)
//   unmake(cfg, id)                 → cfg without that user project
//   reorder(cfg, order, id, beforeId) → cfg.order with id placed before beforeId (or last)
(function (root) {
'use strict';

const OLD_MS = 24 * 3600000, NOW_MS = 10 * 60000;
const MIN_DEPTH = 2;   // a project is never "/" or a top-level folder such as /Users: too wide to mean anything
const USER_MAX = 60;

function norm(p) {
  let s = typeof p === 'string' ? p.trim().replace(/\\/g, '/') : '';
  if (!s || s.length > 4096 || !(s.startsWith('/') || /^[A-Za-z]:\//.test(s))) return '';
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
const segs = p => norm(p).split('/').filter(Boolean);
function under(p, r) { const a = norm(p), b = norm(r); return !!a && !!b && (a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)); }
function parentOf(p) { const s = norm(p), i = s.lastIndexOf('/'); return !s || i <= 0 ? '' : s.slice(0, i); }
const baseOf = p => segs(p).pop() || '';
function commonParent(a, b) {
  const x = segs(a), y = segs(b), out = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i]);
  if (!out.length) return '';
  const lead = /^[A-Za-z]:$/.test(out[0]) ? '' : '/';
  return `${lead}${out.join('/')}`;
}
const depth = p => segs(p).length;

const isOld = (s, now) => (s.status === 'done' || s.status === 'error') && now - (Number(s.time) || 0) > OLD_MS && !s.keep;
const rank = s => (s.needsInput ? 0 : s.status === 'running' ? 1 : s.status === 'waiting' ? 2 : s.keep ? 2.5 : s.status === 'error' ? 3 : 4);

function cleanCfg(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const user = [], seen = new Set();
  for (const u of Array.isArray(c.user) ? c.user : []) {
    const path = norm(u && u.path);
    if (!path || depth(path) < MIN_DEPTH || seen.has(path) || user.length >= USER_MAX) continue;
    seen.add(path); user.push({ path });
  }
  const names = {}, folded = {};
  if (c.names && typeof c.names === 'object') for (const [k, v] of Object.entries(c.names).slice(0, 300)) if (typeof v === 'string' && v.trim()) names[k] = v.trim().slice(0, 60);
  if (c.folded && typeof c.folded === 'object') for (const k of Object.keys(c.folded).slice(0, 300)) if (c.folded[k] === true) folded[k] = true;
  const order = (Array.isArray(c.order) ? c.order : []).filter(v => typeof v === 'string' && v).slice(0, 400);
  return { user, names, order: [...new Set(order)], folded };
}

function group(sessions, cfg, now) {
  const c = cleanCfg(cfg), list = (Array.isArray(sessions) ? sessions : []).filter(s => s && s.id);
  // Orca repositories, and the folder their worktrees live in (…/workspaces/<repo>/<worktree>): a session started by
  // hand in one of those worktrees belongs to the same project as the Orca card beside it
  const orca = new Map();   // repository id → { id, name, path, roots: Set }
  for (const s of list) {
    const rid = typeof s.orca === 'string' ? s.orca : '';
    if (!rid) continue;
    const cwd = norm(s.cwd), up = parentOf(cwd), name = String(s.repoName || '').trim() || baseOf(up) || baseOf(cwd);
    let o = orca.get(rid);
    if (!o) { o = { id: rid, name, path: '', roots: new Set() }; orca.set(rid, o); }
    if (!cwd) continue;
    const rootDir = up && baseOf(up) === name && depth(up) >= MIN_DEPTH ? up : cwd;   // …/workspaces/<repo>/<worktree> → the <repo> folder
    o.roots.add(rootDir);
    if (!o.path || rootDir.length < o.path.length) o.path = rootDir;
  }
  const projects = new Map();
  const put = (id, kind, path, s, name) => {
    let p = projects.get(id);
    if (!p) { p = { id, kind, path, name: c.names[id] || name || baseOf(path) || path, sessions: [] }; projects.set(id, p); }
    p.sessions.push(s);
  };
  const deepest = (cwd, roots) => { let best = ''; for (const r of roots) if (under(cwd, r) && r.length > best.length) best = r; return best; };
  for (const s of list) {
    const cwd = norm(s.home) || norm(s.cwd);   // home: where the session belongs when its folder is a worktree made elsewhere (its repository)
    const u = cwd ? deepest(cwd, c.user.map(x => x.path)) : '';
    if (u) { put(`user:${u}`, 'user', u, s); continue; }
    const own = typeof s.orca === 'string' && s.orca ? orca.get(s.orca) : null;
    if (own) { put(`orca:${own.id}`, 'orca', own.path, s, own.name); continue; }
    let hit = null, len = 0;
    if (cwd) for (const o of orca.values()) { const r = deepest(cwd, o.roots); if (r && r.length > len) { hit = o; len = r.length; } }
    if (hit) { put(`orca:${hit.id}`, 'orca', hit.path, s, hit.name); continue; }
    put(cwd ? `folder:${cwd}` : 'folder:', 'folder', cwd, s);
  }
  // a fixed order: what the user (or an earlier draw) settled first, then new projects by name at the end
  const known = c.order.filter(id => projects.has(id)), rest = [...projects.keys()].filter(id => !known.includes(id)).sort((a, b) => projects.get(a).name.localeCompare(projects.get(b).name) || a.localeCompare(b));
  const order = [...known, ...rest];
  const out = order.map(id => {
    const p = projects.get(id);
    p.sessions.sort((a, b) => rank(a) - rank(b) || String(norm(a.cwd)).localeCompare(String(norm(b.cwd))) || (Number(b.time) || 0) - (Number(a.time) || 0));
    p.live = p.sessions.filter(s => !isOld(s, now)); p.old = p.sessions.filter(s => isOld(s, now));
    p.folders = [...new Set(p.sessions.map(s => norm(s.cwd)).filter(Boolean))];
    p.folded = c.folded[id] === true;
    return p;
  });
  return { projects: out, order: [...new Set([...c.order, ...order])].slice(0, 400) };
}

// a worktree made by AgentDesk: its name is one path segment and a branch name at once
const WT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const worktreeName = v => { const s = typeof v === 'string' ? v.trim() : ''; return WT_NAME_RE.test(s) && !s.includes('..') && !s.endsWith('.') && !s.endsWith('.lock') ? s : ''; };
// the repository a work folder belongs to, from the worktrees AgentDesk made ({ worktree path: repository root })
function homeOf(cwd, links) {
  const p = norm(cwd); if (!p || !links || typeof links !== 'object') return '';
  let best = '', root = '';
  for (const [wt, r] of Object.entries(links)) if (under(p, wt) && norm(wt).length > best.length && norm(r)) { best = norm(wt); root = norm(r); }
  return root;
}
function nowList(sessions, now) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(s => s && s.id);
  const asks = list.filter(s => s.needsInput).sort((a, b) => (Number(a.askSince) || 0) - (Number(b.askSince) || 0));
  const fresh = list.filter(s => !s.needsInput && s.status === 'waiting' && now - (Number(s.since) || 0) <= NOW_MS && now - (Number(s.since) || 0) >= 0).sort((a, b) => (Number(b.since) || 0) - (Number(a.since) || 0));
  return [...asks, ...fresh].slice(0, 8);
}

function withUser(cfg, path, replace) {
  const c = cleanCfg(cfg), p = norm(path);
  if (!p || depth(p) < MIN_DEPTH) return null;
  // the new project takes in the user projects inside it (they would never be reached otherwise)
  c.user = [...c.user.filter(u => !under(u.path, p)), { path: p }];
  const id = `user:${p}`, i = replace ? c.order.indexOf(replace) : -1;
  c.order = c.order.filter(v => v !== id);
  if (i >= 0) c.order.splice(Math.min(i, c.order.length), 0, id); else c.order.push(id);
  return c;
}
function widen(cfg, project) { const up = project && project.path ? parentOf(project.path) : ''; return up ? withUser(cfg, up, project.id) : null; }
function merge(cfg, a, b) { const up = a && b && a.path && b.path ? commonParent(a.path, b.path) : ''; return up ? withUser(cfg, up, a.id) : null; }
function unmake(cfg, id) { const c = cleanCfg(cfg); c.user = c.user.filter(u => `user:${u.path}` !== id); delete c.names[id]; return c; }
function reorder(cfg, order, id, beforeId) {
  const c = cleanCfg(cfg), list = (Array.isArray(order) ? order : c.order).filter(v => v !== id);
  const i = beforeId ? list.indexOf(beforeId) : -1;
  if (i >= 0) list.splice(i, 0, id); else list.push(id);
  c.order = list;
  return c;
}

const AgentDeskProjects = { norm, under, parentOf, commonParent, group, nowList, worktreeName, homeOf, widen, merge, unmake, reorder, cleanCfg, OLD_MS, NOW_MS, MIN_DEPTH };
root.AgentDeskProjects = AgentDeskProjects;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskProjects;
})(typeof globalThis !== 'undefined' ? globalThis : this);
