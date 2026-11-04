import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarketplace, parseRegistry, parseSmithery, loadCatalog } from '../shop/catalog.mjs';

const MARKET = { name: 'demo-market', plugins: [
  { name: 'alpha-tools', description: 'Alpha helpers', version: '1.2.0', homepage: 'https://example.test/alpha', category: 'dev' },
  { name: 'beta-kit', description: 'Beta kit', source: { source: 'github', repo: 'acme/beta-kit' } },
] };
const REG_P1 = {
  servers: [
    { server: { name: 'io.example/weather', title: 'Weather', description: 'Weather MCP', version: '2.0.0', websiteUrl: 'https://example.test/w',
        repository: { url: 'https://github.com/acme/weather' }, packages: [{ registryType: 'npm', identifier: 'weather-mcp' }], remotes: [] },
      _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true, updatedAt: '2026-10-01T00:00:00Z' } } },
    { server: { name: 'io.example/weather', description: 'Weather MCP old', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false, updatedAt: '2026-01-01T00:00:00Z' } } },
  ],
  metadata: { nextCursor: 'c2', count: 2 },
};
const SMI_P1 = { servers: [
  { qualifiedName: 'io.example/weather', displayName: 'Weather', description: 'Weather via smithery', useCount: 4200, createdAt: '2026-05-01T00:00:00Z', homepage: 'https://smithery.test/w' },
  { qualifiedName: 'only/smith', displayName: 'Only Smith', description: 'x', useCount: 7, createdAt: '2026-06-01T00:00:00Z' },
], pagination: { currentPage: 1, totalPages: 1 } };

function home() {
  const h = mkdtempSync(join(tmpdir(), 'shopcat-'));
  const mp = join(h, '.claude', 'plugins');
  mkdirSync(join(mp, 'marketplaces', 'demo-market', '.claude-plugin'), { recursive: true });
  writeFileSync(join(mp, 'known_marketplaces.json'), JSON.stringify({ 'demo-market': { source: { source: 'github', repo: 'acme/demo' } } }));
  writeFileSync(join(mp, 'marketplaces', 'demo-market', '.claude-plugin', 'marketplace.json'), JSON.stringify(MARKET));
  return h;
}
const fakeFetch = (log = []) => async (url) => {
  log.push(url);
  if (url.includes('registry.modelcontextprotocol.io')) return url.includes('cursor=') ? { servers: [], metadata: {} } : REG_P1;
  if (url.includes('registry.smithery.ai')) return SMI_P1;
  throw new Error('unexpected');
};

test('parsers keep the fields', () => {
  const m = parseMarketplace(MARKET, 'demo-market');
  assert.equal(m.length, 2);
  assert.deepEqual([m[0].id, m[0].kind, m[0].name, m[0].version, m[0].category, m[0].homepage, m[0].source, m[0].marketplace],
    ['marketplace:demo-market:alpha-tools', 'plugin', 'alpha-tools', '1.2.0', 'dev', 'https://example.test/alpha', 'marketplace', 'demo-market']);
  const r = parseRegistry(REG_P1);
  assert.equal(r.next, 'c2');
  assert.equal(r.items.length, 1); // non-latest dropped
  const w = r.items[0];
  assert.deepEqual([w.id, w.kind, w.name, w.title, w.version, w.repo, w.homepage, w.source],
    ['registry::io.example/weather', 'mcp', 'io.example/weather', 'Weather', '2.0.0', 'https://github.com/acme/weather', 'https://example.test/w', 'registry']);
  assert.equal(w.updatedAt, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(w.registry.packages[0].identifier, 'weather-mcp');
  const s = parseSmithery(SMI_P1);
  assert.equal(s.next, null);
  assert.deepEqual([s.items[0].popularity, s.items[0].title, s.items[0].updatedAt, s.items[0].source], [4200, 'Weather', Date.parse('2026-05-01T00:00:00Z'), 'smithery']);
  assert.equal(parseSmithery({ servers: [], pagination: { currentPage: 1, totalPages: 3 } }).next, 2);
  assert.deepEqual(parseRegistry({}).items, []);
  assert.deepEqual(parseSmithery(null).items, []);
});

test('registry paging is capped', async () => {
  const h = home(); const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes('registry.modelcontextprotocol.io')) return { servers: [], metadata: { nextCursor: 'again' } };
    return { servers: [], pagination: { currentPage: 1, totalPages: 1 } };
  };
  await loadCatalog({ home: h, fetchJson, now: 1e12 });
  assert.equal(urls.filter(u => u.includes('registry.modelcontextprotocol.io')).length, 5);
  rmSync(h, { recursive: true });
});

test('one failing source keeps the rest', async () => {
  const h = home();
  const fetchJson = async (url) => { if (url.includes('smithery')) throw new Error('boom secret'); return fakeFetch()(url); };
  const c = await loadCatalog({ home: h, fetchJson, now: 1e12 });
  assert.ok(c.items.some(i => i.source === 'marketplace'));
  assert.ok(c.items.some(i => i.source === 'registry'));
  assert.deepEqual(c.sources.find(s => s.id === 'smithery'), { id: 'smithery', ok: false, error: 'offline' });
  assert.equal(c.sources.find(s => s.id === 'registry').ok, true);
  // http status and invalid json get fixed codes; a source that worked before keeps its cached items
  const h2 = home();
  await loadCatalog({ home: h2, fetchJson: fakeFetch(), now: 1e12 });
  const c2 = await loadCatalog({ home: h2, now: 1e12 + 1, refresh: true, fetchJson: async (url) => {
    if (url.includes('smithery')) throw Object.assign(new Error('x'), { status: 503 });
    return 'not an object';
  } });
  assert.equal(c2.sources.find(s => s.id === 'smithery').error, 'http 503');
  assert.equal(c2.sources.find(s => s.id === 'registry').error, 'invalid');
  // failed sources keep their cached items
  assert.ok(c2.items.some(i => i.source === 'registry'));
  assert.ok(c2.items.some(i => i.source === 'smithery'));
  rmSync(h2, { recursive: true });
  rmSync(h, { recursive: true });
});

test('cache is used for 6 hours', async () => {
  const h = home(); const log = [];
  const t0 = 1e12;
  const a = await loadCatalog({ home: h, fetchJson: fakeFetch(log), now: t0 });
  const n = log.length; assert.ok(n >= 2);
  const file = join(h, '.roca', 'shop-cache.json');
  assert.ok(existsSync(file));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const b = await loadCatalog({ home: h, fetchJson: fakeFetch(log), now: t0 + 5 * 3600e3 });
  assert.equal(log.length, n);
  assert.equal(b.cachedAt, a.cachedAt);
  assert.equal(b.items.length, a.items.length);
  await loadCatalog({ home: h, fetchJson: fakeFetch(log), now: t0 + 5 * 3600e3, refresh: true });
  assert.ok(log.length > n);
  const m = log.length;
  await loadCatalog({ home: h, fetchJson: fakeFetch(log), now: t0 + 12 * 3600e3 });
  assert.ok(log.length > m);
  rmSync(h, { recursive: true });
});

test('smithery merges into registry items by name', async () => {
  const h = home();
  const c = await loadCatalog({ home: h, fetchJson: fakeFetch(), now: 1e12 });
  const mcp = c.items.filter(i => i.kind === 'mcp');
  assert.equal(mcp.length, 2);
  const w = mcp.find(i => i.name === 'io.example/weather');
  assert.equal(w.source, 'registry');
  assert.equal(w.popularity, 4200);
  assert.ok(w.registry);
  assert.equal(mcp.find(i => i.name === 'only/smith').source, 'smithery');
  rmSync(h, { recursive: true });
});
