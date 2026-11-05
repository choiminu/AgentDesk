// Shop IPC: the payload / link / install helpers (shop/payload.mjs) and the main/preload/package wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopPayload, installedOf, linkItems, checkEnv, shopInstallJob } from '../shop/payload.mjs';
import { makeShopHandlers } from '../shop/ipc.mjs';
const put = (f, t) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = f => readFileSync(join(ROOT, f), 'utf8');

const REG = {
  name: 'io.example/demo-srv', description: 'Demo', version: '1.0.0',
  packages: [{ registryType: 'npm', identifier: 'demo-srv', version: '1.0.0',
    environmentVariables: [{ name: 'DEMO_TOKEN', isRequired: true, isSecret: true, default: 'sk-default-VALUE' }] }],
};
const CATALOG = {
  items: [
    { id: 'marketplace:mkt:alpha', kind: 'plugin', name: 'alpha', title: 'alpha', source: 'marketplace', marketplace: 'mkt', version: '1.2.0' },
    { id: 'marketplace:mkt:beta', kind: 'plugin', name: 'beta', title: 'beta', source: 'marketplace', marketplace: 'mkt', version: '2.0.0' },
    { id: 'registry::io.example/demo-srv', kind: 'mcp', name: 'io.example/demo-srv', title: 'Demo', source: 'registry', version: '1.0.0', registry: REG },
    { id: 'registry::io.example/have-srv', kind: 'mcp', name: 'io.example/have-srv', title: 'Have', source: 'registry', registry: { name: 'io.example/have-srv', remotes: [{ type: 'streamable-http', url: 'https://h.example.test/mcp' }] } },
  ],
  sources: [{ id: 'marketplace', ok: true }, { id: 'registry', ok: true }, { id: 'smithery', ok: false, error: 'offline' }],
  cachedAt: 123,
};
const INVENTORY = { items: [
  { kind: 'plugin', name: 'alpha', agents: ['claude'], source: 'plugin', plugin: { marketplace: 'mkt', version: '1.1.0' } },
  { kind: 'mcp', name: 'have-srv', agents: ['claude'], source: 'user', loc: { where: 'claude-user' } },
  { kind: 'skill', name: 'my-skill', agents: ['claude'], source: 'user' },
], sources: [] };

test('shop list payload keeps registry records in main', () => {
  const p = shopPayload({ catalog: CATALOG, inventory: INVENTORY, have: { npx: true, uvx: false } });
  assert.equal(p.ok, true);
  assert.equal(p.cachedAt, 123);
  assert.deepEqual(p.sources, CATALOG.sources);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('"registry":{'), 'no raw registry record');
  assert.ok(!json.includes('sk-default-VALUE'));
  for (const it of p.items) {
    assert.equal(it.registry, undefined);
    assert.deepEqual(Object.keys(it.plan).filter(k => !['kind', 'show', 'needs', 'oauth'].includes(k)), [], 'plan has no entry/steps');
  }
  const by = id => p.items.find(i => i.id === id);
  assert.equal(by('marketplace:mkt:alpha').installed, true);
  assert.equal(by('marketplace:mkt:alpha').update, true, '1.2.0 > 1.1.0');
  assert.equal(by('marketplace:mkt:beta').installed, false);
  assert.equal(by('marketplace:mkt:beta').update, false);
  assert.deepEqual(by('marketplace:mkt:beta').plan.show, ['claude plugin install beta@mkt'], 'known marketplace is not re-added');
  assert.equal(by('registry::io.example/demo-srv').plan.kind, 'mcp-write');
  assert.deepEqual(by('registry::io.example/demo-srv').plan.needs, ['DEMO_TOKEN']);
  assert.equal(by('registry::io.example/have-srv').installed, true);
  // npx missing → manual
  const q = shopPayload({ catalog: CATALOG, inventory: INVENTORY, have: {} });
  assert.equal(q.items.find(i => i.id === 'registry::io.example/demo-srv').plan.kind, 'manual');
  // a broken catalog never throws
  assert.deepEqual(shopPayload({ catalog: null, inventory: null, have: null }).items, []);
  assert.deepEqual(shopPayload({ catalog: { items: [null, 3, 'x', { id: 'a' }] }, inventory: { items: [null] } }).items, []);
});

test('installed sets come from the inventory', () => {
  const s = installedOf(INVENTORY, CATALOG.items);
  assert.ok(s.plugins.has('alpha@mkt'));
  assert.ok(s.mcp.has('have-srv'));
  assert.ok(s.skills.has('my-skill'));
  assert.ok(s.marketplaces.has('mkt'));
  assert.equal(s.versions.get('alpha@mkt'), '1.1.0');
});

test('link detections become installable items', () => {
  const dir = '/home/x/.roca/shop/acme__kit';
  const found = linkItems([
    { kind: 'marketplace', name: 'kit-market', path: dir, description: 'M', manifest: { name: 'kit-market', plugins: [{ name: 'p1', description: 'P1' }, { name: '-bad' }] } },
    { kind: 'plugin', name: 'p1', path: dir, description: 'P1', manifest: {} },
    { kind: 'skill', name: 'sk', path: join(dir, 'skills', 'sk'), description: 'S', hasScripts: true },
    { kind: 'mcp', name: 'io.example/linked', path: dir, description: 'L', manifest: { name: 'io.example/linked', remotes: [{ type: 'sse', url: 'https://l.example.test/sse' }] } },
    { kind: 'marketplace', name: '.hidden', path: dir, manifest: { plugins: [{ name: 'z' }] } },
  ], { owner: 'acme', repo: 'kit' });
  const plug = found.find(f => f.item.kind === 'plugin' && f.item.name === 'p1');
  assert.equal(plug.item.marketplace, 'kit-market');
  assert.equal(plug.item.marketplaceSource, 'acme/kit');
  assert.ok(!found.some(f => f.item.marketplace === '.hidden'), 'dot marketplace rejected');
  assert.equal(found.filter(f => f.item.kind === 'plugin' && f.item.name === 'p1').length, 1, 'plugin.json duplicate of a listed plugin is dropped');
  const sk = found.find(f => f.item.kind === 'skill');
  assert.deepEqual(sk.choice, { path: join(dir, 'skills', 'sk') });
  assert.equal(sk.hasScripts, true);
  const mcp = found.find(f => f.item.kind === 'mcp');
  assert.deepEqual(mcp.choice, { name: 'linked' });
  assert.equal(mcp.item.registry.name, 'io.example/linked');
});

test('env must match the needs exactly', () => {
  assert.deepEqual(checkEnv(undefined, []), {});
  assert.deepEqual(checkEnv({}, []), {});
  assert.equal(checkEnv({ X: 'v' }, []), null, 'extra key');
  assert.deepEqual(checkEnv({ A: 'v1', B: 'v2' }, ['A', 'B']), { A: 'v1', B: 'v2' });
  assert.equal(checkEnv({ A: 'v1' }, ['A', 'B']), null, 'missing key');
  assert.equal(checkEnv({ A: 'v1', B: 2 }, ['A', 'B']), null, 'non-string');
  assert.equal(checkEnv({ A: 'x'.repeat(4097) }, ['A']), null, 'too long');
  assert.equal(checkEnv({ A: 'a\nb' }, ['A']), null, 'control char');
  assert.equal(checkEnv({ A: 'a\u007fb' }, ['A']), null, 'DEL');
  assert.equal(checkEnv(['v'], ['0']), null, 'array');
  assert.equal(checkEnv({ __proto__: { A: 'v' } }, ['A']), null, 'inherited key');
  assert.deepEqual(checkEnv({ A: 'x'.repeat(4096) }, ['A']), { A: 'x'.repeat(4096) });
});

test('install result carries no env values', async () => {
  const SECRET = 'sk-test-SECRET-123';
  const calls = [];
  const fakeRunInstall = async (args) => {
    calls.push(args);
    // a misbehaving installer that echoes everything back
    return { ok: true, route: 'config', oauth: true, env: args.env, echo: JSON.stringify(args.env), detail: SECRET, stdout: SECRET };
  };
  const item = CATALOG.items.find(i => i.kind === 'mcp' && i.name === 'io.example/demo-srv');
  const r = await shopInstallJob({ home: '/home/x', item, choice: { name: 'demo-srv' }, env: { DEMO_TOKEN: SECRET }, inventory: INVENTORY, have: { npx: true }, run: async () => ({ code: 0 }), runInstall: fakeRunInstall });
  assert.deepEqual(r, { ok: true, route: 'config', oauth: true });
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.kind, 'mcp-write', 'plan recomputed in main');
  assert.deepEqual(calls[0].choice, { name: 'demo-srv' });
  assert.equal(calls[0].env.DEMO_TOKEN, SECRET, 'the value reaches runInstall');
  // error results: only fixed codes
  const bad = await shopInstallJob({ home: '/home/x', item, choice: { name: 'demo-srv' }, env: { DEMO_TOKEN: SECRET }, inventory: INVENTORY, have: { npx: true },
    run: async () => ({ code: 0 }), runInstall: async () => ({ ok: false, error: SECRET, detail: SECRET }) });
  assert.deepEqual(bad, { ok: false, error: 'failed', detail: 'io' });
  // wrong env keys never reach runInstall
  const n = calls.length;
  const wrong = await shopInstallJob({ home: '/home/x', item, choice: { name: 'demo-srv' }, env: { OTHER: SECRET }, inventory: INVENTORY, have: { npx: true }, run: async () => ({ code: 0 }), runInstall: fakeRunInstall });
  assert.deepEqual(wrong, { ok: false, error: 'failed', detail: 'needs' });
  assert.equal(calls.length, n);
  // a thrown installer error is a fixed code
  const thrown = await shopInstallJob({ home: '/home/x', item, choice: { name: 'demo-srv' }, env: { DEMO_TOKEN: SECRET }, inventory: INVENTORY, have: { npx: true },
    run: async () => ({ code: 0 }), runInstall: async () => { throw new Error(SECRET); } });
  assert.deepEqual(thrown, { ok: false, error: 'failed', detail: 'io' });
  // allAgents goes only to skill choices
  const skillItem = { kind: 'skill', name: 'sk' };
  await shopInstallJob({ home: '/home/x', item: skillItem, choice: { path: '/home/x/.roca/shop/a__b/sk' }, allAgents: true, inventory: INVENTORY, have: {}, run: async () => ({}), runInstall: fakeRunInstall });
  assert.deepEqual(calls[calls.length - 1].choice, { path: '/home/x/.roca/shop/a__b/sk', allAgents: true });
});

// ---- handlers (shop/ipc.mjs) over a temp home ----
function harness({ files = {}, known, catalog = CATALOG, runInstall, loadCatalog, inventory = INVENTORY } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'shop-ipc-'));
  if (known) put(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify(known));
  const calls = { run: [], load: [], enqueue: 0 };
  const repo = { files };
  const run = async (cmd, args, opts) => {
    calls.run.push([cmd, args]);
    if (cmd === 'git') { const dir = args[args.length - 1]; for (const [f, t] of Object.entries(repo.files)) put(join(dir, f), t); }
    return { code: 0, stdout: '', stderr: '' };
  };
  let q = Promise.resolve();
  const enqueue = fn => { calls.enqueue++; const j = q.then(fn); q = j.catch(() => {}); return j; };
  const h = makeShopHandlers({
    home, run, enqueue, have: async () => ({ npx: true, uvx: false }), inventory: () => inventory,
    loadCatalog: loadCatalog || (async ({ refresh }) => { calls.load.push(refresh); return catalog; }),
    ...(runInstall ? { runInstall } : {}),
  });
  return { home, h, calls, repo };
}
const SKILL = (n, body = 'x') => `---\nname: ${n}\ndescription: ${n} one.\n---\n${body}\n`;

test('second clone invalidates earlier choices', async () => {
  const { home, h, repo } = harness({ files: { 'skills/sk/SKILL.md': SKILL('sk', 'first') } });
  const a = await h.link({ text: 'acme/kit' });
  assert.equal(a.ok, true);
  const first = a.found.find(f => f.kind === 'skill');
  assert.equal(first.hasScripts, false);
  assert.ok(!JSON.stringify(a).includes(home), 'no clone path sent');
  repo.files = { 'skills/sk/SKILL.md': SKILL('sk', 'second') };
  const b = await h.link({ text: 'acme/kit' });   // the same link again: same folder, re-cloned
  const second = b.found.find(f => f.kind === 'skill');
  assert.deepEqual(await h.install({ choiceId: first.choiceId }), { ok: false, error: 'gone', detail: 'missing' });
  const r = await h.install({ choiceId: second.choiceId });
  assert.deepEqual(r, { ok: true, route: 'claude' });
  assert.match(readFileSync(join(home, '.claude', 'skills', 'sk', 'SKILL.md'), 'utf8'), /second/);
  rmSync(home, { recursive: true, force: true });
});

test('a fallback clone in an install invalidates choices from that folder', async () => {
  let home0;
  // install.mjs's plugin fallback clones through the runner it is given: here a fake runInstall does the same
  const { home, h, calls } = harness({ files: { 'skills/sk/SKILL.md': SKILL('sk') },
    runInstall: async ({ run }) => { await run('git', ['clone', '--', 'https://github.com/acme/kit.git', join(home0, '.roca', 'shop', '.tmp-acme__kit')]); return { ok: true, route: 'local' }; } });
  home0 = home;
  const sk = (await h.link({ text: 'acme/kit' })).found[0];
  assert.equal(h.choices.size, 1);
  assert.deepEqual(await h.install({ id: 'marketplace:mkt:beta' }), { ok: true, route: 'local' });
  assert.equal(calls.run.filter(([c]) => c === 'git').length, 2);
  assert.equal(h.choices.size, 0);
  assert.deepEqual(await h.install({ choiceId: sk.choiceId }), { ok: false, error: 'gone', detail: 'missing' });
  rmSync(home, { recursive: true, force: true });
});

test('a link marketplace named like a known one from elsewhere is a conflict', async () => {
  const files = { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'kit-market', plugins: [{ name: 'p1', description: 'P1' }] }) };
  for (const known of [{ 'kit-market': { source: { source: 'github', repo: 'other/x' } } }, { 'kit-market': { source: { source: 'directory', path: '/x' } } }, { 'kit-market': {} }]) {
    const { home, h, calls } = harness({ files, known });
    const a = await h.link({ text: 'acme/kit' });
    const p = a.found.find(f => f.name === 'p1');
    assert.equal(p.plan.kind, 'manual');
    assert.equal(p.plan.detail, 'conflict');
    assert.deepEqual(await h.install({ choiceId: p.choiceId }), { ok: false, error: 'unsupported', detail: 'conflict' });
    assert.ok(!calls.run.some(([c]) => c === 'claude'), 'nothing installed');
    rmSync(home, { recursive: true, force: true });
  }
  // same repo recorded → installs from the known marketplace (no re-add)
  for (const src of [{ source: 'github', repo: 'Acme/Kit' }, { source: 'git', url: 'https://github.com/acme/kit.git' }]) {
    const { home, h } = harness({ files, known: { 'kit-market': { source: src } } });
    const p = (await h.link({ text: 'acme/kit' })).found.find(f => f.name === 'p1');
    assert.equal(p.plan.kind, 'plugin');
    assert.deepEqual(p.plan.show, ['claude plugin install p1@kit-market']);
    rmSync(home, { recursive: true, force: true });
  }
  // unknown marketplace → added from the link
  const { home, h } = harness({ files });
  const p = (await h.link({ text: 'acme/kit' })).found.find(f => f.name === 'p1');
  assert.deepEqual(p.plan.show, ['claude plugin marketplace add acme/kit', 'claude plugin install p1@kit-market']);
  rmSync(home, { recursive: true, force: true });
});

test('install requests are checked', async () => {
  const seen = [];
  const { home, h, calls } = harness({ files: { 'skills/sk/SKILL.md': SKILL('sk') }, runInstall: async a => { seen.push(a); return { ok: true, route: 'claude' }; } });
  const BAD = { ok: false, error: 'failed', detail: 'bad request' };
  assert.deepEqual(await h.install({ id: 'marketplace:mkt:beta', choiceId: 'x' }), BAD);
  assert.deepEqual(await h.install({}), BAD);
  assert.deepEqual(await h.install(null), BAD);
  assert.deepEqual(await h.install({ id: 'x'.repeat(301) }), BAD);
  assert.deepEqual(await h.install({ id: 'a\nb' }), BAD);
  assert.deepEqual(await h.install({ choiceId: 'nope' }), { ok: false, error: 'gone', detail: 'missing' });
  assert.deepEqual(await h.install({ id: 'marketplace:mkt:nope' }), { ok: false, error: 'gone', detail: 'missing' });
  const sk = (await h.link({ text: 'acme/kit' })).found[0];
  for (const v of ['true', 1, {}]) await h.install({ choiceId: sk.choiceId, allAgents: v });
  assert.ok(seen.every(a => a.choice.allAgents === undefined), 'allAgents only when exactly true');
  await h.install({ choiceId: sk.choiceId, allAgents: true });
  assert.equal(seen[seen.length - 1].choice.allAgents, true);
  await h.install({ id: 'registry::io.example/have-srv' });
  assert.equal(calls.load.length, 1);
  rmSync(home, { recursive: true, force: true });
});

test('handlers never log or return env values', async () => {
  const SECRET = 'sk-test-SECRET-987';
  const logs = [];
  const orig = {};
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) { orig[k] = console[k]; console[k] = (...a) => logs.push(a.map(String).join(' ')); }
  try {
    const { home, h } = harness({ runInstall: async ({ env }) => { const e = new Error(SECRET + JSON.stringify(env)); e.code = SECRET; throw e; } });
    const r1 = await h.install({ id: 'registry::io.example/demo-srv', env: { DEMO_TOKEN: SECRET } });
    assert.deepEqual(r1, { ok: false, error: 'failed', detail: 'io' });
    const h2 = makeShopHandlers({ home, enqueue: fn => fn(), have: async () => ({ npx: true }), loadCatalog: async () => CATALOG, run: async () => ({ code: 0 }),
      inventory: () => { throw Object.assign(new Error(SECRET), { code: SECRET }); } });
    const r2 = await h2.install({ id: 'registry::io.example/demo-srv', env: { DEMO_TOKEN: SECRET } });
    assert.deepEqual(r2, { ok: false, error: 'failed', detail: 'io' });
    const r3 = await h.install({ id: 'registry::io.example/demo-srv', env: { DEMO_TOKEN: SECRET, EXTRA: SECRET } });
    assert.deepEqual(r3, { ok: false, error: 'failed', detail: 'needs' });
    for (const r of [r1, r2, r3]) assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.ok(logs.length > 0, 'errors were logged');
    assert.ok(!logs.some(l => l.includes(SECRET)), logs.join('\n'));
    rmSync(home, { recursive: true, force: true });
  } finally { Object.assign(console, orig); }
});

test('catalog: refresh during a load runs after it; install loads before the queue', async () => {
  let release;
  const log = [];
  const { home, h, calls } = harness({ loadCatalog: ({ refresh }) => { log.push(refresh); return log.length === 1 ? new Promise(r => { release = () => r(CATALOG); }) : Promise.resolve(CATALOG); } });
  const a = h.list({});
  const b = h.list({ refresh: true });
  await new Promise(r => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  assert.deepEqual(log, [false, true]);
  rmSync(home, { recursive: true, force: true });
  // a failing load: install answers gone without taking the queue
  const f = harness({ loadCatalog: async () => { throw new Error('offline'); } });
  assert.deepEqual(await f.h.install({ id: 'marketplace:mkt:beta' }), { ok: false, error: 'gone', detail: 'missing' });
  assert.equal(f.calls.enqueue, 0);
  assert.deepEqual(await f.h.list({}), { ok: false, error: 'failed', detail: 'io' });
  assert.deepEqual(await f.h.link({ text: 'https://evil.com/x' }), { ok: false, error: 'failed', detail: 'bad link' });
  void calls;
  rmSync(f.home, { recursive: true, force: true });
});

// ---- wiring (source checks) ----
function handlerBody(main, channel) {
  const at = main.indexOf(`ipcMain.handle("${channel}"`);
  assert.ok(at >= 0, `${channel} registered`);
  return main.slice(at, main.indexOf('\n', at));
}

test('main registers the three shop handlers', () => {
  const main = src('main.mjs');
  assert.match(handlerBody(main, 'roca:shop-list'), /shop\.list\(req\)/);
  assert.match(handlerBody(main, 'roca:shop-link'), /shop\.link\(req\)/);
  assert.match(handlerBody(main, 'roca:shop-install'), /shop\.install\(req\)/);
  assert.match(main, /from "\.\/shop\/ipc\.mjs"/);
  assert.match(main, /AbortSignal\.timeout\(10000\)/);
  assert.match(main, /function shopEnqueue\(fn\) \{ const job = sbQueue\.then\(fn\); sbQueue = /, 'installs share the skillbook queue');
});

test('sbRun accepts env and timeout', () => {
  const main = src('main.mjs');
  assert.match(main, /function sbRun\(cmd, args, opts\)/);
  assert.match(main, /PATH: EXEC_PATH, \.\.\.env/);
});

test('preload and package expose the shop', () => {
  const pre = src('preload.cjs');
  assert.match(pre, /shopList: \(req\) => ipcRenderer\.invoke\("roca:shop-list", req\)/);
  assert.match(pre, /shopLink: \(req\) => ipcRenderer\.invoke\("roca:shop-link", req\)/);
  assert.match(pre, /shopInstall: \(req\) => ipcRenderer\.invoke\("roca:shop-install", req\)/);
  const pkg = JSON.parse(src('package.json'));
  assert.ok(pkg.build.files.includes('shop/**/*'));
});

test('a /tree/<ref>/<path> link plans its marketplace from the previewed local folder', async () => {
  const files = { 'sub/dir/.claude-plugin/marketplace.json': JSON.stringify({ name: 'kit-market', plugins: [{ name: 'p1', description: 'P1' }] }),
    '.claude-plugin/marketplace.json': JSON.stringify({ name: 'root-market', plugins: [{ name: 'r1' }] }) };
  const seen = [];
  const { home, h } = harness({ files, runInstall: async a => { seen.push(a); return { ok: true, route: 'local' }; } });
  const dir = join(home, '.roca', 'shop', 'acme__kit@dev', 'sub', 'dir');
  const r = await h.link({ text: 'https://github.com/acme/kit/tree/dev/sub/dir' });
  const p = r.found.find(f => f.name === 'p1');
  assert.ok(!r.found.some(f => f.name === 'r1'), 'only what the path holds');
  assert.equal(p.plan.kind, 'plugin');
  assert.deepEqual(p.plan.show, [`claude plugin marketplace add ${dir}`, 'claude plugin install p1@kit-market']);
  assert.deepEqual(await h.install({ choiceId: p.choiceId }), { ok: true, route: 'local' });
  assert.deepEqual(seen[0].plan.steps.map(s => s.args), [['plugin', 'marketplace', 'add', dir], ['plugin', 'install', 'p1@kit-market']]);
  rmSync(home, { recursive: true, force: true });
  // a ref alone (no path): the clone root, still local — the clone is that ref, owner/repo would be the default branch
  const h2 = harness({ files: { '.claude-plugin/marketplace.json': files['sub/dir/.claude-plugin/marketplace.json'] } });
  const p2 = (await h2.h.link({ text: 'https://github.com/acme/kit/tree/v2' })).found.find(f => f.name === 'p1');
  assert.deepEqual(p2.plan.show, [`claude plugin marketplace add ${join(h2.home, '.roca', 'shop', 'acme__kit@v2')}`, 'claude plugin install p1@kit-market']);
  rmSync(h2.home, { recursive: true, force: true });
  // linkItems: no ref/path → owner/repo, as before
  const d = [{ kind: 'marketplace', name: 'm', path: '/h/.roca/shop/a__b', manifest: { name: 'm', plugins: [{ name: 'x' }] } }];
  assert.equal(linkItems(d, { owner: 'a', repo: 'b' })[0].item.marketplacePath, undefined);
  assert.equal(linkItems(d, { owner: 'a', repo: 'b', ref: 'v1' })[0].item.marketplacePath, '/h/.roca/shop/a__b');
});

test('re-pasting a link after a local-path install: installed, and a directory source in the clone is the same source', async () => {
  const files = { 'sub/.claude-plugin/marketplace.json': JSON.stringify({ name: 'kit-market', plugins: [{ name: 'p1' }, { name: 'p2' }] }) };
  const inventory = { items: [...INVENTORY.items, { kind: 'plugin', name: 'p1', agents: ['claude'], source: 'plugin', plugin: { marketplace: 'kit-market', version: '1.0.0' } }], sources: [] };
  // harness makes its own home: known_marketplaces.json (pointing into that home) is written after it exists
  const hh = harness({ files, inventory });
  const home = hh.home;
  put(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'kit-market': { source: { source: 'directory', path: join(home, '.roca', 'shop', 'acme__kit', 'sub') } } }));
  const found = (await hh.h.link({ text: 'https://github.com/acme/kit/tree/main/sub' })).found;
  const p1 = found.find(f => f.name === 'p1'), p2 = found.find(f => f.name === 'p2');
  assert.equal(p1.plan.kind, 'installed', 'installed is checked before conflict');
  assert.equal(p2.plan.kind, 'plugin', 'same clone folder → same source, no re-add');
  assert.deepEqual(p2.plan.show, ['claude plugin install p2@kit-market']);
  // the clone root itself is accepted too; another clone folder is not
  put(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'kit-market': { source: { source: 'directory', path: join(home, '.roca', 'shop', 'acme__kit') } } }));
  assert.equal((await hh.h.link({ text: 'https://github.com/acme/kit/tree/main/sub' })).found.find(f => f.name === 'p2').plan.kind, 'plugin');
  put(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'kit-market': { source: { source: 'directory', path: join(home, '.roca', 'shop', 'acme__kit2') } } }));
  const p2b = (await hh.h.link({ text: 'https://github.com/acme/kit/tree/main/sub' })).found.find(f => f.name === 'p2');
  assert.equal(p2b.plan.detail, 'conflict');
  rmSync(home, { recursive: true, force: true });
});
