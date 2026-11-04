// Shop pasted links: validate a plain public GitHub link, shallow-clone it, tell what is inside.
// Security: parseRepoLink is the only gate; nothing else here builds a command from user text.
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, rmSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, sep, basename, relative } from 'node:path';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook

const { parseSkillMd } = globalThis.AgentDeskSkillbook;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const SEG_RE = /^[A-Za-z0-9_.@+-]{1,100}$/;
const bareName = s => NAME_RE.test(s) && s !== '.' && s !== '..' && !s.startsWith('-');

// → { owner, repo, ref?, path? } | null. A ref is the first segment after /tree/ (a branch name with a slash is not supported).
export function parseRepoLink(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > 400 || /[\s\0]/.test(t)) return null;
  let parts;
  if (t.startsWith('https://')) {
    const m = /^https:\/\/github\.com\/([^?#]+)$/.exec(t);
    if (!m) return null;
    parts = m[1].replace(/\/$/, '').split('/');
    if (parts.length === 2 || (parts.length >= 4 && parts[2] === 'tree')) { /* ok */ } else return null;
  } else {
    parts = t.split('/');
    if (parts.length !== 2) return null;
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!bareName(owner) || !bareName(repo)) return null;
  const out = { owner, repo };
  if (parts.length > 2) {
    const ref = parts[3];
    if (!REF_RE.test(ref) || ref.startsWith('-') || ref.includes('..')) return null;
    out.ref = ref;
    const rest = parts.slice(4);
    if (rest.length) {
      if (rest.some(s => !SEG_RE.test(s) || s === '.' || s === '..')) return null;
      out.path = rest.join('/');
    }
  }
  return out;
}

// → { ok: true, dir } | { ok: false, error: 'bad link' | 'clone failed' }
// `run(cmd, args, opts)` — opts = { env, timeout }: the caller's wrapper merges env over its own and applies the timeout.
// The clone goes to a temp sibling and replaces the old clone only after it succeeded.
const CLONE_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
const CLONE_OPTS = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
export async function fetchRepo({ home, link, run }) {
  const p = parseRepoLink(link);
  if (!p) return { ok: false, error: 'bad link' };
  const root = join(home, '.roca', 'shop');
  const dir = join(root, `${p.owner}-${p.repo}`);
  const tmp = join(root, `.tmp-${p.owner}-${p.repo}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    rmSync(tmp, { recursive: true, force: true });
    const args = [...CLONE_OPTS, 'clone', '--depth', '1', '--no-tags', ...(p.ref ? ['--branch', p.ref] : []), '--', `https://github.com/${p.owner}/${p.repo}.git`, tmp];
    const r = await run('git', args, { env: { ...CLONE_ENV }, timeout: 60000 });
    if (r && typeof r === 'object' && r.code !== undefined && r.code !== 0) throw new Error('clone');
    if (!lstatSync(tmp).isDirectory()) throw new Error('clone');
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { ok: true, dir };
  } catch {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: 'clone failed' };
  }
}

const SCRIPT_EXT = /\.(sh|py|js|mjs)$/i;
const SKIP_DIR = n => n === '.git' || n === 'node_modules' || (n.startsWith('.') && n !== '.claude');
const JSON_MAX = 1024 * 1024;
const MAX_SKILLS = 200;

// true when no component between the clone root and p is a symlink (and p stays inside it)
let CLONE = null;
function plain(p) {
  if (!CLONE) return false;
  try { return realpathSync(p) === join(CLONE.real, relative(CLONE.lex, resolve(p))); } catch { return false; }
}
function readJson(f) { try { const st = lstatSync(f); if (!st.isFile() || st.size > JSON_MAX) return null; if (!plain(f)) return null; const j = JSON.parse(readFileSync(f, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } }
function readHead(f) {
  const fd = openSync(f, 'r');
  try { const b = Buffer.alloc(64 * 1024); return b.toString('utf8', 0, readSync(fd, b, 0, b.length, 0)); } finally { closeSync(fd); }
}
const str = v => (typeof v === 'string' ? v : '');

function hasScripts(dir, depth = 0, seen = { n: 0 }) {
  let ents; try { ents = readdirSync(dir); } catch { return true; }
  for (const n of ents) {
    if (++seen.n > 500) return true; // fail closed: too big to inspect
    let st; try { st = lstatSync(join(dir, n)); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) { if (SCRIPT_EXT.test(n) || (st.mode & 0o111)) return true; }
    else if (st.isDirectory() && n !== '.git') { if (depth >= 3 || hasScripts(join(dir, n), depth + 1, seen)) return true; }
  }
  return false;
}

function findSkills(root, out, depth = 0) {
  if (out.length >= MAX_SKILLS) return;
  let st; try { st = lstatSync(join(root, 'SKILL.md')); } catch { st = null; }
  if (st && st.isFile()) {
    let meta = { name: null, description: '' };
    try { meta = parseSkillMd(readHead(join(root, 'SKILL.md'))); } catch { /* unreadable: folder name */ }
    out.push({ kind: 'skill', name: meta.name || basename(root), path: root, description: meta.description || '', hasScripts: hasScripts(root) });
    return;
  }
  if (depth >= 4) return;
  let ents; try { ents = readdirSync(root).sort(); } catch { return; }
  for (const n of ents) {
    if (SKIP_DIR(n)) continue;
    try { if (!lstatSync(join(root, n)).isDirectory()) continue; } catch { continue; }
    findSkills(join(root, n), out, depth + 1);
  }
}

// Order: marketplace.json → plugin.json → SKILL.md folders → server.json. `path` narrows to a subfolder inside dir.
export function detectRepo(dir, path) {
  let base;
  try {
    const rootReal = realpathSync(dir);
    base = path ? resolve(dir, path) : dir;
    const real = realpathSync(base);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return [];
    if (!lstatSync(real).isDirectory()) return [];
    CLONE = { real: rootReal, lex: resolve(dir) };
    if (!plain(base)) return [];
  } catch { return []; }
  const out = [];
  const mk = readJson(join(base, '.claude-plugin', 'marketplace.json'));
  if (mk) out.push({ kind: 'marketplace', name: str(mk.name) || basename(base), path: base, description: str(mk.description) || str(mk.metadata?.description), manifest: mk });
  const pl = readJson(join(base, '.claude-plugin', 'plugin.json'));
  if (pl) out.push({ kind: 'plugin', name: str(pl.name) || basename(base), path: base, description: str(pl.description), manifest: pl });
  findSkills(base, out);
  const sv = readJson(join(base, 'server.json'));
  if (sv) out.push({ kind: 'mcp', name: str(sv.name) || basename(base), path: base, description: str(sv.description), manifest: sv });
  return out;
}
