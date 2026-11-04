// Shop IPC: the payload / link / install helpers (shop/payload.mjs) and the main/preload/package wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopPayload, installedOf, linkItems, checkEnv, shopInstallJob } from '../shop/payload.mjs';

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
  const dir = '/home/x/.roca/shop/acme-kit';
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
  await shopInstallJob({ home: '/home/x', item: skillItem, choice: { path: '/home/x/.roca/shop/a-b/sk' }, allAgents: true, inventory: INVENTORY, have: {}, run: async () => ({}), runInstall: fakeRunInstall });
  assert.deepEqual(calls[calls.length - 1].choice, { path: '/home/x/.roca/shop/a-b/sk', allAgents: true });
});

// ---- wiring (source checks) ----
function handlerBody(main, channel) {
  const at = main.indexOf(`ipcMain.handle("${channel}"`);
  assert.ok(at >= 0, `${channel} registered`);
  const next = main.indexOf('ipcMain.handle(', at + 10);
  return main.slice(at, next < 0 ? undefined : next);
}

test('main registers the three shop handlers', () => {
  const main = src('main.mjs');
  for (const ch of ['roca:shop-list', 'roca:shop-link', 'roca:shop-install']) handlerBody(main, ch);
  assert.match(main, /from "\.\/shop\/catalog\.mjs"/);
  assert.match(main, /from "\.\/shop\/payload\.mjs"/);
  assert.match(main, /AbortSignal\.timeout\(10000\)/);
  const inst = handlerBody(main, 'roca:shop-install');
  assert.match(inst, /sbQueue/, 'installs share the skillbook queue');
});

test('shop install never logs env', () => {
  const main = src('main.mjs');
  const start = main.indexOf('// ── Shop');
  const end = main.indexOf('// ── Shop end');
  assert.ok(start > 0 && end > start, 'shop block is marked');
  const block = main.slice(start, end);
  for (const m of block.matchAll(/console\.\w+\(([^;]*)\)/g)) assert.ok(!/\benv\b|req\b/.test(m[1]), `console call without env: ${m[0]}`);
  const inst = handlerBody(main, 'roca:shop-install');
  assert.ok(!/console\./.test(inst) || !/env/.test(inst.match(/console\.[^;]*/g)?.join('') || ''));
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
