// Shop IPC handlers (main process; main.mjs wraps each in ipcMain.handle). Raw registry records, plan entries/steps,
// clone paths and typed env values stay here; the renderer sends ids only (catalog id or a link choiceId) plus the env
// values for plan.needs, which go to runInstall and are dropped. Errors are logged by code only, never with a request.
//   makeShopHandlers(deps) → { list(req), link(req), install(req), choices }
//   deps: home (string), loadCatalog({ refresh }), have(refresh) → { npx, uvx }, inventory() → scanInventory result,
//         enqueue(fn) → Promise (the Skillbook action queue), run(cmd, args, opts) (execFile wrapper),
//         optional: fetchRepo, detectRepo, parseRepoLink, runInstall, uuid, now, log(tag, code)
// Every failure is { ok: false, error, detail } with fixed codes (payload.mjs fixed()).
import { readFileSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mcpEntryName } from './plan.mjs';
import { parseRepoLink as parseRepoLink0, fetchRepo as fetchRepo0, detectRepo as detectRepo0 } from './repo.mjs';
import { runInstall as runInstall0 } from './install.mjs';
import { shopPayload, linkItems, linkFound, shopInstallJob, fixed } from './payload.mjs';

const CHOICE_MS = 30 * 60e3;
const MAX_CHOICES = 200;
const idOk = v => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
const codeOf = e => (e && typeof e.code === 'string' && /^[A-Za-z_]{1,40}$/.test(e.code) ? e.code : e && typeof e.name === 'string' ? e.name : 'error');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const bad = detail => fixed({ ok: false, error: 'failed', detail });
const GONE = () => fixed({ ok: false, error: 'gone', detail: 'missing' });

export function makeShopHandlers(deps) {
  const {
    home, run, enqueue,
    fetchRepo = fetchRepo0, detectRepo = detectRepo0, parseRepoLink = parseRepoLink0, runInstall = runInstall0,
    uuid = randomUUID, now = Date.now, log = (tag, code) => console.error(`[shop] ${tag}`, code),
  } = deps;
  const knownMarketplaces = () => {
    try { const j = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8')); return isObj(j) ? j : {}; } catch { return {}; }
  };

  // ---- catalog: one load at a time; a refresh asked for during a load runs after it
  let catalog = null, job = null;
  function load(refresh) {
    if (job && !refresh) return job;
    const prev = job || Promise.resolve();
    const j = prev.catch(() => {}).then(() => deps.loadCatalog({ refresh: !!refresh })).then(c => { catalog = c; return c; });
    job = j;
    j.then(() => { if (job === j) job = null; }, () => { if (job === j) job = null; });
    return j;
  }

  // ---- link choices: kept 30 minutes under a random id; each remembers the clone folder it came from
  const choices = new Map();
  function prune() {
    const t = now();
    for (const [k, v] of choices) if (t - v.at > CHOICE_MS) choices.delete(k);
    while (choices.size > MAX_CHOICES) choices.delete(choices.keys().next().value);
  }
  // a clone replaces its folder: every choice from that folder (or under it) is gone
  function invalidate(dir) {
    const d = resolve(dir);
    for (const [k, v] of choices) if (v.dir === d || v.dir.startsWith(d + sep)) choices.delete(k);
  }
  // the runner shops use: a git clone (fetchRepo clones into "<root>/.tmp-<name>" then renames it to "<root>/<name>")
  // invalidates the choices of the final folder, whether it came from a link or from install.mjs's plugin fallback
  const shopRun = async (cmd, args, opts) => {
    const clone = cmd === 'git' && Array.isArray(args) && args.includes('clone') && typeof args[args.length - 1] === 'string';
    if (clone) { const t = args[args.length - 1]; invalidate(join(dirname(t), basename(t).replace(/^\.tmp-/, ''))); }
    try { return await run(cmd, args, opts); }
    finally { if (clone) { const t = args[args.length - 1]; invalidate(join(dirname(t), basename(t).replace(/^\.tmp-/, ''))); } }
  };

  async function list(req) {
    const refresh = !!(req && req.refresh === true);
    try {
      const [c, have] = await Promise.all([load(refresh), deps.have(refresh)]);
      return shopPayload({ catalog: c, inventory: deps.inventory(), have });
    } catch (e) { log('list', codeOf(e)); return bad('io'); }
  }

  async function link(req) {
    const text = req && req.text;
    const parsed = typeof text === 'string' ? parseRepoLink(text) : null;
    if (!parsed) return bad('bad link');
    try {
      // clone and scan in one queued job: no other clone or install touches the folder in between
      const entries = await enqueue(async () => {
        const got = await fetchRepo({ home, link: text, run: shopRun });
        if (!got || !got.ok) return null;
        const dir = resolve(got.dir);
        const found = linkItems(detectRepo(dir, parsed.path), parsed);
        prune();
        const at = now();
        for (const e of found) { e.choiceId = uuid(); e.at = at; e.dir = dir; choices.set(e.choiceId, e); }
        return found;
      });
      if (!entries) return bad('clone');
      if (!entries.length) return bad('empty');
      const have = await deps.have(false);
      return { ok: true, found: linkFound(entries, { inventory: deps.inventory(), have, catalogItems: catalog && catalog.items, known: knownMarketplaces() }) };
    } catch (e) { log('link', codeOf(e)); return bad('io'); }
  }

  async function install(req) {
    const id = req && req.id, choiceId = req && req.choiceId;
    if (!isObj(req) || !!id === !!choiceId || (id && !idOk(id)) || (choiceId && !idOk(choiceId))) return bad('bad request');
    let env = req.env;   // checked against the plan's needs in shopInstallJob; never logged, never returned
    const allAgents = req.allAgents === true;
    try {
      // the catalog is loaded before taking the queue (a slow fetch must not hold up other actions)
      if (id && !catalog) { try { await load(false); } catch { return GONE(); } }
      return await enqueue(async () => {
        let item, choice;
        if (choiceId) {
          prune();
          const c = choices.get(choiceId);
          if (!c) return GONE();
          item = c.item; choice = c.choice;
        } else {
          item = catalog && Array.isArray(catalog.items) ? catalog.items.find(i => isObj(i) && i.id === id) : null;
          if (!item) return GONE();
          choice = item.kind === 'mcp' ? { name: mcpEntryName(item.name) } : {};
        }
        return shopInstallJob({ home, item, choice, env, allAgents, inventory: deps.inventory(), catalogItems: catalog && catalog.items,
          known: knownMarketplaces(), have: await deps.have(false), run: shopRun, runInstall });
      });
    } catch (e) { log('install', codeOf(e)); return bad('io'); }
    finally { env = null; }
  }

  return { list, link, install, choices };
}
