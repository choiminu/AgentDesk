// Shop catalog: plugin marketplaces (local), the MCP registry and Smithery (remote), merged and cached for 6 hours.
// fetchJson is injected; every remote failure falls back to that source's cached items with a fixed error code.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../perm/settings.mjs';

const CACHE_MS = 6 * 3600e3;
const MAX_PAGES = 5;
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers?limit=100';
const SMITHERY_URL = 'https://registry.smithery.ai/servers?pageSize=100';
const OFFICIAL = 'io.modelcontextprotocol.registry/official';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
const ms = v => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : undefined; };
const mkId = (source, marketplace, name) => `${source}:${marketplace || ''}:${name}`;
function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k]; return o; }

export function parseMarketplace(json, marketplaceName) {
  const out = [];
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : [];
  for (const p of list) {
    if (!isObj(p) || !str(p.name)) continue;
    const src = isObj(p.source) ? p.source : null;
    const repo = src && str(src.repo) ? src.repo : (src && str(src.url)) || undefined;
    out.push(clean({
      id: mkId('marketplace', marketplaceName, p.name), kind: 'plugin', name: p.name, title: str(p.title) || p.name,
      description: str(p.description), source: 'marketplace', marketplace: marketplaceName,
      version: str(p.version), homepage: str(p.homepage), repo, category: str(p.category),
    }));
  }
  return out;
}

export function parseRegistry(json) {
  const items = [];
  const list = isObj(json) && Array.isArray(json.servers) ? json.servers : [];
  for (const e of list) {
    const s = isObj(e) && isObj(e.server) ? e.server : null;
    if (!s || !str(s.name)) continue;
    const meta = isObj(e._meta) && isObj(e._meta[OFFICIAL]) ? e._meta[OFFICIAL] : {};
    if (meta.isLatest === false) continue;
    items.push(clean({
      id: mkId('registry', '', s.name), kind: 'mcp', name: s.name, title: str(s.title) || s.name,
      description: str(s.description), source: 'registry', version: str(s.version),
      updatedAt: ms(meta.updatedAt) ?? ms(meta.publishedAt), homepage: str(s.websiteUrl),
      repo: isObj(s.repository) ? str(s.repository.url) : undefined, registry: s,
    }));
  }
  const nc = isObj(json) && isObj(json.metadata) ? json.metadata.nextCursor : null;
  return { items, next: typeof nc === 'string' && nc ? nc : null };
}

export function parseSmithery(json) {
  const items = [];
  const list = isObj(json) && Array.isArray(json.servers) ? json.servers : [];
  for (const s of list) {
    if (!isObj(s) || !str(s.qualifiedName)) continue;
    items.push(clean({
      id: mkId('smithery', '', s.qualifiedName), kind: 'mcp', name: s.qualifiedName, title: str(s.displayName) || s.qualifiedName,
      description: str(s.description), source: 'smithery',
      popularity: typeof s.useCount === 'number' && Number.isFinite(s.useCount) ? s.useCount : undefined,
      updatedAt: ms(s.createdAt), homepage: str(s.homepage),
    }));
  }
  const pg = isObj(json) && isObj(json.pagination) ? json.pagination : {};
  const next = Number.isInteger(pg.currentPage) && Number.isInteger(pg.totalPages) && pg.currentPage < pg.totalPages ? pg.currentPage + 1 : null;
  return { items, next };
}

// ---- remote sources (delete one entry to drop a source; Smithery is meant to be removable this way) ----
async function pageThrough(fetchJson, first, parse, urlFor) {
  const items = [];
  let next = first;
  for (let i = 0; i < MAX_PAGES && next !== null; i++) {
    const json = await fetchJson(urlFor(next));
    if (!isObj(json)) throw Object.assign(new Error('invalid'), { code: 'invalid' });
    const r = parse(json);
    items.push(...r.items);
    next = r.next;
  }
  return items;
}
const REMOTE = [
  { id: 'registry', fetch: fj => pageThrough(fj, '', parseRegistry, c => (c ? `${REGISTRY_URL}&cursor=${encodeURIComponent(c)}` : REGISTRY_URL)) },
  { id: 'smithery', fetch: fj => pageThrough(fj, 1, parseSmithery, n => `${SMITHERY_URL}&page=${n}`) },
];
const errCode = e => {
  if (e && e.code === 'invalid') return 'invalid';
  if (e && Number.isInteger(e.status)) return `http ${e.status}`;
  return 'offline';
};

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; } }
function loadMarketplaces(home) {
  const dir = join(home, '.claude', 'plugins');
  const known = readJson(join(dir, 'known_marketplaces.json'));
  const items = [];
  if (!isObj(known)) return items;
  for (const name of Object.keys(known)) {
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) continue; // the name becomes a path segment
    const f = join(dir, 'marketplaces', name, '.claude-plugin', 'marketplace.json');
    if (existsSync(f)) items.push(...parseMarketplace(readJson(f), name));
  }
  return items;
}

// every id once (the first wins): a marketplace may list a plugin twice, a cache may hold a record twice
function merge(market, registry, smithery) {
  const byName = new Map();
  const ids = new Set();
  const items = [];
  const keep = it => { if (ids.has(it.id)) return false; ids.add(it.id); items.push(it); return true; };
  for (const m of market) keep({ ...m });
  for (const r of registry) { const it = { ...r }; if (keep(it) && !byName.has(it.name)) byName.set(it.name, it); }
  for (const s of smithery) {
    const r = byName.get(s.name);
    if (r) { if (s.popularity !== undefined) r.popularity = s.popularity; if (!r.description && s.description) r.description = s.description; }
    else keep({ ...s });
  }
  return items;
}

export async function loadCatalog({ home, fetchJson, now = Date.now(), refresh = false } = {}) {
  const cacheFile = join(home, '.roca', 'shop-cache.json');
  const raw = readJson(cacheFile);
  const cached = isObj(raw) && isObj(raw.sources) ? raw.sources : {};
  // a hand-edited or older cache may hold anything: only items with a string id and name are kept
  const okItem = it => isObj(it) && !!str(it.id) && !!str(it.name);
  const cacheOf = id => (isObj(cached[id]) && Array.isArray(cached[id].items) ? { ...cached[id], items: cached[id].items.filter(okItem) } : null);
  const fresh = id => { const c = cacheOf(id); return !!c && Number.isFinite(c.fetchedAt) && now >= c.fetchedAt && now - c.fetchedAt < CACHE_MS; };

  const next = {};
  const sources = [{ id: 'marketplace', ok: true }];
  let dirty = false;
  for (const src of REMOTE) {
    const c = cacheOf(src.id);
    if (!refresh && fresh(src.id)) { next[src.id] = c; sources.push({ id: src.id, ok: true }); continue; }
    try {
      const items = await src.fetch(fetchJson);
      next[src.id] = { items, fetchedAt: now }; dirty = true;
      sources.push({ id: src.id, ok: true });
    } catch (e) {
      next[src.id] = c || { items: [], fetchedAt: null };
      sources.push({ id: src.id, ok: false, error: errCode(e) });
    }
  }
  if (dirty) { try { writeJsonAtomic(cacheFile, { sources: next }); } catch { /* cache is best effort */ } }

  const stamps = Object.values(next).map(c => c.fetchedAt).filter(Number.isFinite);
  const items = merge(loadMarketplaces(home), next.registry.items, next.smithery.items);
  return { items, sources, cachedAt: stamps.length ? Math.max(...stamps) : null };
}
