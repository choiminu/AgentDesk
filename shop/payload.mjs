// Shop IPC helpers (pure, main process): what the renderer sees of the catalog and of a pasted link, the env check and
// one install job. Raw registry records, plan entries/steps and typed env values never leave main.
//   shopPayload({ catalog, inventory, have }) → { ok, items, sources, cachedAt }
//   installedOf(inventory, catalogItems) → { plugins, mcp, skills, marketplaces: Set, versions: Map<'name@market', version> }
//   linkItems(detected, { owner, repo }) → [{ item, choice, hasScripts }]   (detectRepo results → installable items)
//   checkEnv(env, needs) → a copy holding exactly `needs` | null
//   shopInstallJob({ home, item, choice, env, allAgents, inventory, catalogItems, known, have, run, runInstall }) → fixed-code result
//   known = ~/.claude/plugins/known_marketplaces.json (parsed): a link plugin whose marketplace name is already known
//   but recorded with another source (or none we can read) gets a manual plan with detail 'conflict' and never installs
import { planInstall, hasUpdate, mcpEntryName } from './plan.mjs';
import { parseMarketplace } from './catalog.mjs';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
const list = v => (Array.isArray(v) ? v : []);

export function installedOf(inventory, catalogItems = [], known = null) {
  const out = { plugins: new Set(), mcp: new Set(), skills: new Set(), marketplaces: new Set(), versions: new Map() };
  for (const it of list(inventory && inventory.items)) {
    if (!isObj(it) || !str(it.name)) continue;
    const agents = list(it.agents);
    if (it.kind === 'plugin' && agents.includes('claude') && isObj(it.plugin) && str(it.plugin.marketplace)) {
      const key = `${it.name}@${it.plugin.marketplace}`;
      out.plugins.add(key);
      out.marketplaces.add(it.plugin.marketplace);
      if (str(it.plugin.version)) out.versions.set(key, it.plugin.version);
    } else if (it.kind === 'mcp' && isObj(it.loc) && it.loc.where === 'claude-user') {
      out.mcp.add(it.name); // on or parked: either way the name is taken in ~/.claude.json
    } else if (it.kind === 'skill' && !it.plugin && (it.source === 'user' || it.source === 'shared') && (agents.includes('claude') || it.source === 'shared')) {
      out.skills.add(it.name);
    }
  }
  if (isObj(known)) for (const k of Object.keys(known)) out.marketplaces.add(k);
  for (const it of list(catalogItems)) if (isObj(it) && it.source === 'marketplace' && str(it.marketplace)) out.marketplaces.add(it.marketplace);
  return out;
}

const publicPlan = p => ({ kind: p.kind, show: list(p.show).map(String), needs: list(p.needs).map(String), ...(p.oauth ? { oauth: true } : {}),
  ...(p.detail === 'conflict' ? { detail: 'conflict' } : {}) });

const lc = v => str(v).toLowerCase();
// does the known marketplace `name` come from this link's repo? (github repo, or a git URL on github.com)
function sameSource(rec, ownerRepo) {
  const src = isObj(rec) && isObj(rec.source) ? rec.source : null;
  if (!src || !ownerRepo) return false;
  const want = lc(ownerRepo);
  if (src.source === 'github') return lc(src.repo) === want;
  if (src.source === 'git' || src.source === 'url') {
    const m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(str(src.url));
    return !!m && lc(m[1]) === want;
  }
  return false;
}
const CONFLICT = { kind: 'manual', show: ['같은 이름의 마켓이 이미 다른 출처로 등록되어 있습니다 (marketplace name conflict)'], needs: [], detail: 'conflict' };

function planOf(item, installed, have, known) {
  if (item.source === 'link' && item.kind === 'plugin' && str(item.marketplace)) {
    const name = item.marketplace;
    const kn = isObj(known) && Object.prototype.hasOwnProperty.call(known, name);
    if ((kn || installed.marketplaces.has(name)) && !(kn && sameSource(known[name], item.marketplaceSource))) return { ...CONFLICT, show: CONFLICT.show.slice() };
  }
  try { return planInstall(item, { installed, have: isObj(have) ? have : {} }); } catch { return { kind: 'manual', show: [], needs: [] }; }
}

export function shopPayload({ catalog, inventory, have } = {}) {
  const items = list(isObj(catalog) ? catalog.items : null).filter(it => isObj(it) && str(it.id) && str(it.name) && str(it.kind));
  const installed = installedOf(inventory, items);
  const out = items.map(it => {
    const { registry, ...rest } = it; // the raw record stays in main
    const plan = planOf(it, installed, have);
    const key = it.kind === 'plugin' ? `${it.name}@${it.marketplace || ''}` : null;
    const isIn = plan.kind === 'installed';
    return { ...rest, plan: publicPlan(plan), installed: isIn, update: !!(isIn && key && hasUpdate(installed.versions.get(key), it.version)) };
  });
  return {
    ok: true, items: out,
    sources: list(isObj(catalog) ? catalog.sources : null).filter(isObj),
    cachedAt: isObj(catalog) && Number.isFinite(catalog.cachedAt) ? catalog.cachedAt : null,
  };
}

// detectRepo results: a marketplace becomes its plugins (installed through the link as marketplace source); a lone
// plugin.json has no marketplace (→ manual); skills keep their folder (the install copies it); server.json is a registry record
export function linkItems(detected, { owner, repo } = {}) {
  const out = [];
  const source = `${owner}/${repo}`;
  const listed = new Set();
  for (const d of list(detected)) {
    if (!isObj(d) || d.kind !== 'marketplace' || !str(d.name) || d.name.startsWith('.')) continue;
    for (const p of parseMarketplace(d.manifest, d.name)) {
      if (listed.has(p.name)) continue;
      listed.add(p.name);
      const { repo: _r, ...plug } = p;
      out.push({ item: { ...plug, source: 'link', marketplaceSource: source }, choice: {}, hasScripts: false });
    }
  }
  for (const d of list(detected)) {
    if (!isObj(d) || !str(d.name)) continue;
    const base = { name: d.name, title: d.name, description: str(d.description), source: 'link' };
    if (d.kind === 'plugin' && !listed.has(d.name)) out.push({ item: { ...base, kind: 'plugin' }, choice: {}, hasScripts: false });
    else if (d.kind === 'skill' && str(d.path)) out.push({ item: { ...base, kind: 'skill' }, choice: { path: d.path }, hasScripts: d.hasScripts !== false });
    else if (d.kind === 'mcp' && isObj(d.manifest)) out.push({ item: { ...base, kind: 'mcp', registry: d.manifest }, choice: { name: mcpEntryName(d.name) }, hasScripts: false });
  }
  return out;
}

// what the renderer may send for a link choice: no manifest, no path
export function linkFound(entries, { inventory, have, catalogItems, known } = {}) {
  const installed = installedOf(inventory, catalogItems, known);
  return list(entries).map(e => ({
    choiceId: e.choiceId, kind: e.item.kind, name: e.item.name, description: str(e.item.description), hasScripts: !!e.hasScripts,
    plan: publicPlan(planOf(e.item, installed, have, known)),
  }));
}

const BAD_CHARS = /[\u0000-\u001f\u007f]/;
export function checkEnv(env, needs) {
  const want = list(needs);
  if (env === undefined || env === null) return want.length ? null : {};
  if (!isObj(env) || (Object.getPrototypeOf(env) !== Object.prototype && Object.getPrototypeOf(env) !== null)) return null;
  const keys = Object.keys(env);
  if (keys.length !== want.length || !want.every(n => Object.prototype.hasOwnProperty.call(env, n))) return null;
  const copy = {};
  for (const n of want) {
    const v = env[n];
    if (typeof v !== 'string' || v.length > 4096 || BAD_CHARS.test(v)) return null;
    copy[n] = v;
  }
  return copy;
}

const ROUTES = new Set(['config', 'cli', 'marketplace', 'local', 'claude', 'agents']);
const ERRORS = new Set(['failed', 'unsupported', 'gone']);
const DETAILS = new Set(['bad request', 'needs', 'exists', 'missing', 'invalid JSON', 'unparsed', 'io', 'cli', 'manual', 'kind',
  'conflict', 'bad link', 'clone', 'empty']);
// only known fields with known values: whatever an installer returns, no output or value text gets through
export function fixed(r) {
  if (isObj(r) && r.ok === true) return { ok: true, ...(ROUTES.has(r.route) ? { route: r.route } : {}), ...(r.oauth === true ? { oauth: true } : {}) };
  return { ok: false, error: isObj(r) && ERRORS.has(r.error) ? r.error : 'failed', detail: isObj(r) && DETAILS.has(r.detail) ? r.detail : 'io' };
}

// the plan is made again here from a fresh inventory (an earlier install in the queue may have changed it)
export async function shopInstallJob({ home, item, choice, env, allAgents, inventory, catalogItems, known, have, run, runInstall } = {}) {
  if (!isObj(item) || typeof runInstall !== 'function') return fixed({ ok: false, error: 'failed', detail: 'bad request' });
  const plan = planOf(item, installedOf(inventory, catalogItems, known), have, known);
  if (plan.detail === 'conflict') return fixed({ ok: false, error: 'unsupported', detail: 'conflict' });
  const vals = checkEnv(env, plan.needs);
  if (!vals) return fixed({ ok: false, error: 'failed', detail: 'needs' });
  const ch = { ...(isObj(choice) ? choice : {}) };
  if (item.kind === 'skill' && allAgents === true) ch.allAgents = true;
  try {
    return fixed(await runInstall({ home, plan, env: vals, run, choice: ch }));
  } catch {
    return fixed({ ok: false, error: 'failed', detail: 'io' });
  }
}
