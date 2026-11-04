// Skillbook IPC: the payload builder (skillbook/payload.mjs) over a temp home, and the main/preload/package wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanInventory } from '../skillbook/scan.mjs';
import { createUsageStore } from '../skillbook/usage.mjs';
import { skillbookPayload } from '../skillbook/payload.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); };
const skill = (dir, name) => put(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} one.\n---\nbody\n`);
const DAY = 86400e3;
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sb-ipc-'));
  const repo = join(home, 'work', 'alpha');
  skill(join(home, '.claude/skills'), 'user-skill');
  skill(join(home, '.claude/skills-disabled'), 'off-skill');
  skill(join(home, '.agents/skills'), 'shared-skill');
  skill(join(repo, '.claude/skills'), 'proj-skill');
  put(join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: {
    'demoplug@mkt': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/mkt/demoplug/1.0.0'), version: '1.0.0' }] } });
  skill(join(home, '.claude/plugins/cache/mkt/demoplug/1.0.0/skills'), 'plug-skill');
  put(join(home, '.claude/settings.json'), { enabledPlugins: { 'demoplug@mkt': true } });
  put(join(home, '.claude.json'), { mcpServers: {
    'user-srv': { command: '/usr/local/bin/demo-srv', args: ['--key', 'sk-SECRET2'], env: { API_TOKEN: 'sk-SECRET1' } },
    'user-http': { type: 'http', url: 'https://h/mcp?token=sk-SECRET4', headers: { Authorization: 'Bearer sk-SECRET3' } } } });
  put(join(home, '.codex/config.toml'), '[mcp_servers.codex-srv]\ncommand = "/opt/bin/cx"\nargs = ["--key", "sk-SECRET2"]\n[mcp_servers.codex-srv.env]\nCX_TOKEN = "sk-SECRET1"\n');
  put(join(home, '.gemini/settings.json'), { mcpServers: { 'gem-srv': { command: 'gem', env: { G_TOKEN: 'sk-SECRET1' } } } });
  put(join(home, '.gemini/extensions/gem-ext/gemini-extension.json'), { name: 'gem-ext', description: 'An extension.' });
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [{ id: 'mcp:user:claude::claude-user:parked-srv', sid: 'mcp:user:claude::claude-user:parked-srv@1', kind: 'mcp', agent: 'claude', name: 'parked-srv',
    loc: { file: join(home, '.claude.json'), where: 'claude-user' }, at: 1, json: { command: 'x', env: { T: 'sk-SECRET1' } } }] });
  const store = createUsageStore({ file: join(home, '.roca', 'skillbook-usage.json'), now: () => NOW });
  return { home, repo, store };
}
const use = (store, key, daysAgo, n = 1, agent = 'claude') => { for (let i = 0; i < n; i++) store.add({ key, kind: 'skill', agent, at: NOW - daysAgo * DAY, repo: 'alpha' }); };
const build = ({ home, repo, store }, removed = []) => skillbookPayload({ inventory: scanInventory({ home, repos: [repo] }), store, removed, now: NOW });
const byName = (p, name, kind) => p.items.find(i => i.name === name && (!kind || i.kind === kind));

test('skillbook IPC payload has no secrets', () => {
  const fx = fixture();
  use(fx.store, 'user-srv', 0, 2);
  const p = build(fx);
  assert.equal(p.ok, true);
  assert.ok(p.items.length >= 10);
  assert.ok(!JSON.stringify(p).includes('sk-SECRET'));
  assert.ok(byName(p, 'parked-srv'), 'parked entry listed');
});

test('counted is false for Codex- or Gemini-only items', () => {
  const fx = fixture();
  use(fx.store, 'codex-srv', 0, 3, 'codex');
  const p = build(fx);
  const cx = byName(p, 'codex-srv');
  assert.equal(cx.uses.counted, false);
  assert.equal(cx.uses.total, 0);
  assert.equal(byName(p, 'gem-srv').uses.counted, false);
  assert.equal(byName(p, 'user-srv').uses.counted, true);
  assert.equal(byName(p, 'shared-skill').uses.counted, true); // shared: Claude is one of its agents
});

test('week, month (30 days), total and mastery from the store', () => {
  const fx = fixture();
  use(fx.store, 'user-skill', 0, 3);
  use(fx.store, 'user-skill', 20, 3);
  use(fx.store, 'user-skill', 40, 1);
  const u = byName(build(fx), 'user-skill').uses;
  assert.equal(u.week, 3);
  assert.equal(u.month, 6);
  assert.equal(u.total, 7);
  assert.equal(u.mastery, 2);
  assert.equal(u.lastAt, NOW);
  assert.equal(u.lastRepo, 'alpha');
  assert.deepEqual(u.byAgent, { claude: 7 });
  const none = byName(build(fx), 'off-skill').uses;
  assert.deepEqual(none, { week: 0, month: 0, total: 0, mastery: 0, counted: true });
});

test('usage keys without an inventory item are dropped', () => {
  const fx = fixture();
  use(fx.store, 'Users', 0, 9); // a prompt starting with "/Users/..."
  use(fx.store, 'demoplug:plug-skill', 0, 1);
  const p = build(fx);
  assert.ok(!JSON.stringify(p).includes('"Users"'));
  assert.equal(p.items.reduce((s, i) => s + i.uses.total, 0), 1);
  assert.equal(byName(p, 'plug-skill').uses.total, 1);
});

test('each item says which actions it supports', () => {
  const fx = fixture();
  const removed = [{ id: 'skill:user:claude::gone@5', kind: 'skill', name: 'gone', removedAt: 5, how: 'trash' }, { id: 'mcp:x@6', kind: 'mcp', name: 'x', removedAt: 6, how: 'config' }];
  const p = build(fx, removed);
  const can = (name, kind) => byName(p, name, kind).can;
  assert.deepEqual(can('user-skill'), { off: true, on: false, remove: true, restore: false, reveal: true });
  assert.deepEqual(can('off-skill'), { off: false, on: true, remove: true, restore: false, reveal: true });
  assert.deepEqual(can('shared-skill'), { off: true, on: false, remove: true, restore: false, reveal: true });
  assert.deepEqual(can('proj-skill'), { off: false, on: false, remove: true, restore: false, reveal: true });
  assert.deepEqual(can('plug-skill'), { off: false, on: false, remove: false, restore: false, reveal: true });
  assert.deepEqual(can('demoplug', 'plugin'), { off: true, on: false, remove: true, restore: false, reveal: true });
  assert.deepEqual(can('gem-ext'), { off: false, on: false, remove: false, restore: false, reveal: true });
  assert.deepEqual(can('user-srv'), { off: true, on: false, remove: true, restore: false, reveal: false });
  assert.deepEqual(can('parked-srv'), { off: false, on: true, remove: true, restore: false, reveal: false });
  assert.equal(byName(p, 'parked-srv').id, 'mcp:user:claude::claude-user:parked-srv@1'); // the stored id, as is
  assert.equal(p.backfill, 'running');
});

test('main, preload and package wire the skillbook IPC', () => {
  const main = readFileSync(join(ROOT, 'main.mjs'), 'utf8');
  const preload = readFileSync(join(ROOT, 'preload.cjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(main, /ipcMain\.handle\("roca:skillbook"/);
  assert.match(main, /ipcMain\.handle\("roca:skillbook-act"/);
  assert.match(main, /timelineIndex\.add\(o\); sbFeed\(o\);/); // readNewEvents and orca:hooks-recent both feed
  assert.equal((main.match(/timelineIndex\.add\(o\); sbFeed\(o\);/g) || []).length, 2);
  assert.match(main, /store\.feedRecord\(o\)/);
  assert.doesNotMatch(main, /store\.addRecord\(/);
  assert.match(main, /shell\.trashItem/);
  assert.match(main, /shell\.showItemInFolder\(item\.path\)/);
  assert.match(main, /skillbook-usage\.json/);
  assert.doesNotMatch(main, /shell:\s*true/);
  assert.match(preload, /skillbook:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("roca:skillbook"\)/);
  assert.match(preload, /skillbookAct:\s*\(req\)\s*=>\s*ipcRenderer\.invoke\("roca:skillbook-act",\s*req\)/);
  assert.ok(pkg.build.files.includes('skillbook/**/*'));
});

test('removed rows can be restored only where actOn can (MCP, plugin; not a trashed skill)', async () => {
  const { home } = fixture();
  const removed = [
    { id: 'skill:user:claude::gone@5', kind: 'skill', name: 'gone', removedAt: 5, how: 'trash' },
    { id: 'plugin:plugin:claude::demoplug@6', kind: 'plugin', name: 'demoplug', removedAt: 6, how: 'plugin' },
    { id: 'mcp:user:claude::claude-user:x@7', kind: 'mcp', name: 'x', removedAt: 7, how: 'config' },
    { id: 'odd@8', kind: 'other', name: 'odd', removedAt: 8, how: '' },
  ];
  const p = skillbookPayload({ inventory: { items: [], sources: [] }, store: null, removed, now: NOW });
  assert.deepEqual(p.removed.map(r => [r.kind, r.can.restore]), [['skill', false], ['plugin', true], ['mcp', true], ['other', false]]);
  // the skill row really is refused by actOn
  const { actOn } = await import('../skillbook/actions.mjs');
  const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  mk(join(home, '.roca'), { recursive: true });
  wf(join(home, '.roca/skillbook-removed.json'), JSON.stringify({ v: 1, entries: [{ id: 'skill:user:claude::gone', sid: 'skill:user:claude::gone@5', kind: 'skill', agent: 'claude', name: 'gone', path: join(home, 'x'), at: Date.now(), how: 'trash' }] }));
  assert.deepEqual(await actOn({ home, item: { id: 'skill:user:claude::gone@5', name: 'gone', kind: 'skill' }, action: 'restore', trash: async () => {}, run: async () => ({ code: 0 }) }), { ok: false, error: 'unsupported', detail: 'trash' });
});
