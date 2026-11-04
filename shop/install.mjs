// Shop installs: run one plan from shop/plan.mjs. Main process only.
//   runInstall({ home, plan, env, run, choice }) → Promise<{ ok: true, route, oauth? } | { ok: false, error, detail? }>
//     env: { NAME: value } for plan.needs — the values go into the one ~/.claude.json entry and nowhere else
//          (never into argv, the result, a log line or another file); the plan object is not changed
//     run(cmd, args, opts?) → Promise<{ code, stdout, stderr }> (execFile wrapper, no shell); its output never leaves here
//     choice: { name? (mcp entry / skill name), path? (skill folder inside ~/.roca/shop) + allAgents? }
//     plugin fallback: only when the plan adds the marketplace; clones that source, needs the same marketplace name
//   routes: 'config' (mcp-write), 'cli' (mcp-cli), 'marketplace' | 'local' (plugin), 'claude' | 'agents' (skill)
//   error is 'failed' | 'unsupported'; detail is one of DETAILS (fixed codes, no CLI output or exception text)
import { lstatSync, readFileSync, mkdirSync, cpSync, renameSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, basename, dirname, sep } from 'node:path';
import '../core/skillbook.js'; // classic script: sets globalThis.AgentDeskSkillbook
import { addMcpEntry } from '../skillbook/actions.mjs';
import { fetchRepo, detectRepo } from './repo.mjs';

const { parseSkillMd } = globalThis.AgentDeskSkillbook;
const DETAILS = new Set(['bad request', 'needs', 'exists', 'missing', 'invalid JSON', 'unparsed', 'io', 'cli', 'manual', 'kind']);
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const PLUGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (error, detail) => ({ ok: false, error, detail: DETAILS.has(detail) ? detail : 'io' });
const exists = p => { try { lstatSync(p); return true; } catch { return false; } };
const safeName = n => typeof n === 'string' && NAME_RE.test(n) && n !== '.' && n !== '..' && !n.includes('..');

export async function runInstall({ home, plan, env, run, choice } = {}) {
  if (typeof home !== 'string' || !isAbsolute(home) || !isObj(plan)) return fail('failed', 'bad request');
  try {
    switch (plan.kind) {
      case 'installed': return fail('failed', 'exists');
      case 'manual': return fail('unsupported', 'manual');
      case 'mcp-write': return mcpWrite(home, plan, env, choice);
      case 'mcp-cli': return await cliSteps(plan, run, 'cli');
      case 'plugin': return await plugin(home, plan, run);
      case 'skill': return skill(home, choice);
      default: return fail('unsupported', 'kind');
    }
  } catch {
    return fail('failed', 'io'); // the message may quote a path or a value
  }
}

// ---------- MCP ----------
function needsOk(plan, env) {
  const needs = Array.isArray(plan.needs) ? plan.needs : [];
  if (!needs.every(n => typeof n === 'string')) return null;
  if (!needs.length) return needs;
  if (!isObj(env)) return null;
  // a value holding "${" is refused: Claude Code expands ${VAR} in config values, so it could pull in another variable
  const ok = v => typeof v === 'string' && v !== '' && !v.includes('${');
  return needs.every(n => Object.prototype.hasOwnProperty.call(env, n) && ok(env[n])) ? needs : null;
}

// a copy of v with ${NAME} (NAME in needs) replaced in every string; one pass, so a value is never expanded again
function fill(v, needs, env) {
  if (typeof v === 'string') return v.replace(PLACEHOLDER, (m, n) => (needs.includes(n) ? env[n] : m));
  if (Array.isArray(v)) return v.map(x => fill(x, needs, env));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, needs, env)]));
  return v;
}

// the entry name: the caller's, else the one the plan shows ("~/.claude.json mcpServers.<name>")
function entryName(plan, choice) {
  if (isObj(choice) && choice.name !== undefined) return choice.name;
  const m = /^~\/\.claude\.json mcpServers\.(.+)$/.exec(Array.isArray(plan.show) ? String(plan.show[0] ?? '') : '');
  return m ? m[1] : null;
}

function mcpWrite(home, plan, env, choice) {
  const needs = needsOk(plan, env);
  if (!needs) return fail('failed', 'needs');
  const name = entryName(plan, choice);
  if (!safeName(name) || !isObj(plan.entry)) return fail('failed', 'bad request');
  // secrets go to env / headers only: a needed placeholder anywhere else (args, command, url) would put the value on
  // the server's command line or in a URL — refused
  const { env: e0, headers: h0, ...rest } = plan.entry;
  if (needs.some(n => JSON.stringify(rest).includes('${' + n + '}'))) return fail('failed', 'bad request');
  const entry = { ...plan.entry };
  if (e0 !== undefined) entry.env = fill(e0, needs, env);
  if (h0 !== undefined) entry.headers = fill(h0, needs, env);
  const r = addMcpEntry({ home, name, entry });
  if (!r.ok) return fail('failed', r.detail);
  return { ok: true, route: 'config', ...(plan.oauth ? { oauth: true } : {}) };
}

// ---------- CLI ----------
async function claude(run, args) {
  if (typeof run !== 'function') return false;
  try { const r = await run('claude', args); return !!r && r.code === 0; } catch { return false; }
}
const okStep = s => isObj(s) && s.cmd === 'claude' && Array.isArray(s.args) && s.args.length > 0 && s.args.every(a => typeof a === 'string' && !a.includes('${'));

async function cliSteps(plan, run, route) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length || !steps.every(okStep)) return fail('failed', 'bad request');
  for (const s of steps) if (!(await claude(run, s.args))) return fail('failed', 'cli');
  return { ok: true, route, ...(plan.oauth ? { oauth: true } : {}) };
}

// ---------- plugins ----------
async function plugin(home, plan, run) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const install = steps[steps.length - 1];
  if (!steps.length || !steps.every(okStep) || install.args[0] !== 'plugin' || install.args[1] !== 'install' || install.args.length !== 3) return fail('failed', 'bad request');
  const parts = install.args[2].split('@');
  if (parts.length !== 2 || !PLUGIN_RE.test(parts[0]) || !PLUGIN_RE.test(parts[1])) return fail('failed', 'bad request');
  const market = parts[1];
  const first = await cliSteps(plan, run, 'marketplace');
  if (first.ok) return first;

  // fallback: only when the marketplace was unknown (the plan adds it) — clone its source and add it as a
  // local-path marketplace, and only when the clone's marketplace.json has the planned name (the install ref stays)
  const add = steps.find(s => s.args.length === 4 && s.args[0] === 'plugin' && s.args[1] === 'marketplace' && s.args[2] === 'add');
  if (!add) return first;
  const got = await fetchRepo({ home, link: add.args[3], run });
  if (!got.ok) return first;
  const mk = detectRepo(got.dir).find(d => d.kind === 'marketplace');
  if (!mk || mk.name !== market) return first;
  if (!(await claude(run, ['plugin', 'marketplace', 'add', got.dir]))) return fail('failed', 'cli');
  if (!(await claude(run, install.args))) return fail('failed', 'cli');
  return { ok: true, route: 'local' };
}

// ---------- skills ----------
// the caller's name, else SKILL.md `name:`, else the folder name — the first one that is a safe folder name
function skillName(src, choice) {
  let meta = null;
  try { meta = parseSkillMd(readFileSync(join(src, 'SKILL.md'), 'utf8').slice(0, 64 * 1024)); } catch { /* folder name */ }
  return [choice.name, meta && meta.name, basename(src)].find(safeName) || null;
}

// copies the folder without symlinks or .git (a clone has none of the former; this stays true for any source)
const noLinks = p => { try { const st = lstatSync(p); return !st.isSymbolicLink() && basename(p) !== '.git'; } catch { return false; } };

function skill(home, choice) {
  if (!isObj(choice) || typeof choice.path !== 'string' || !isAbsolute(choice.path)) return fail('failed', 'bad request');
  const src = resolve(choice.path);
  // only folders inside ~/.roca/shop (link clones) are copied
  try {
    if (!realpathSync(src).startsWith(realpathSync(join(home, '.roca', 'shop')) + sep)) return fail('failed', 'bad request');
  } catch { return fail('failed', 'bad request'); }
  let st;
  try { st = lstatSync(src); } catch { return fail('failed', 'missing'); }
  if (!st.isDirectory()) return fail('failed', 'missing');
  try { if (!lstatSync(join(src, 'SKILL.md')).isFile()) return fail('failed', 'missing'); } catch { return fail('failed', 'missing'); }
  const name = skillName(src, choice);
  if (!safeName(name)) return fail('failed', 'bad request');

  const claudeDir = join(home, '.claude', 'skills', name);
  const target = choice.allAgents ? join(home, '.agents', 'skills', name) : claudeDir;
  // a skill of that name, on or off, in either root: refuse (turning the other one on would collide)
  const taken = ['.claude', '.agents'].flatMap(r => ['skills', 'skills-disabled'].map(d => join(home, r, d, name)));
  if (taken.some(exists)) return fail('failed', 'exists');

  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.agentdesk-${name}-${process.pid}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(src, tmp, { recursive: true, filter: noLinks, errorOnExist: true, force: false });
    if (exists(target)) throw new Error('exists');
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (!choice.allAgents) return { ok: true, route: 'claude' };
  try {
    mkdirSync(dirname(claudeDir), { recursive: true });
    symlinkSync(target, claudeDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    rmSync(target, { recursive: true, force: true }); // nothing half-installed
    return fail('failed', exists(claudeDir) ? 'exists' : 'io');
  }
  return { ok: true, route: 'agents' };
}
