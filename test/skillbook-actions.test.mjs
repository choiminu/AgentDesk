// Skillbook actions: skillbook/actions.mjs over a temp home with fake trash / run (made-up names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync, utimesSync, renameSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanInventory } from '../skillbook/scan.mjs';
import { actOn, listRemoved } from '../skillbook/actions.mjs';

const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n'); };
const json = f => JSON.parse(readFileSync(f, 'utf8'));
const DAY = 86400000;

const CLAUDE_JSON = {
  numStartups: 3,
  mcpServers: { 'keep-srv': { command: 'a' }, 'user-srv': { command: '/usr/bin/demo', args: ['--key', 'sk-SECRET2'], env: { API_TOKEN: 'sk-SECRET1' } }, 'last-srv': { type: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer sk-SECRET3' } } },
  projects: {},
  tipsHistory: { x: 1 },
};
const CODEX = '# my codex config\nmodel = "m"\n\n[mcp_servers.first]\ncommand = "f"\n\n[mcp_servers.codex-srv]\ncommand = "/opt/bin/cx"\nargs = [\n  ["--key", "sk-SECRET2"],\n]\n[mcp_servers.codex-srv.env]\nCX_TOKEN = "sk-SECRET1"\n\n[profiles.p]\nmodel = "n"\n';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sb-act-'));
  const repo = join(home, 'work', 'alpha');
  put(join(home, '.claude/skills/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: Demo.\n---\nbody\n');
  put(join(home, '.claude/skills/demo-skill/ref/notes.md'), 'notes\n');
  put(join(home, '.claude.json'), { ...CLAUDE_JSON, projects: { [repo]: { allowedTools: [], mcpServers: { 'proj-srv': { command: 'node', args: ['p'] } } } } });
  put(join(repo, '.mcp.json'), { mcpServers: { 'file-srv': { command: 'npx', env: { K1: 'v' } } }, other: true });
  put(join(home, '.codex/config.toml'), CODEX);
  put(join(home, '.gemini/settings.json'), { theme: 'x', mcpServers: { 'gem-srv': { command: 'gem' } } });
  put(join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'demo@market': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/market/demo/1.0.0'), version: '1.0.0' }] } });
  put(join(home, '.claude/settings.json'), { enabledPlugins: { 'demo@market': true } });
  return { home, repo };
}
const scan = (home, repo) => scanInventory({ home, repos: [repo] }).items;
const item = (home, repo, f) => scan(home, repo).find(f);
const fakes = () => {
  const calls = { trash: [], run: [] };
  return { calls, trash: async p => { calls.trash.push(p); rmSync(p, { recursive: true, force: true }); }, run: async (cmd, args) => { calls.run.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; } };
};
const backups = home => { try { return readdirSync(join(home, '.roca/skillbook-backup')); } catch { return []; } };
const mode = f => statSync(f).mode & 0o777;

test('skill off and on', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const it = item(home, repo, i => i.kind === 'skill' && i.name === 'demo-skill');
  assert.deepEqual(await actOn({ home, item: it, action: 'off', ...f }), { ok: true });
  assert.ok(!existsSync(join(home, '.claude/skills/demo-skill')));
  assert.equal(readFileSync(join(home, '.claude/skills-disabled/demo-skill/ref/notes.md'), 'utf8'), 'notes\n');
  const off = item(home, repo, i => i.kind === 'skill' && i.name === 'demo-skill');
  assert.equal(off.on, false);
  assert.deepEqual(await actOn({ home, item: off, action: 'on', ...f }), { ok: true });
  assert.equal(readFileSync(join(home, '.claude/skills/demo-skill/ref/notes.md'), 'utf8'), 'notes\n');
  assert.ok(!existsSync(join(home, '.claude/skills-disabled/demo-skill')));
  assert.equal(item(home, repo, i => i.name === 'demo-skill').on, true);
  // turning on over an existing folder of the same name fails without moving anything (same id: the scan shows one)
  put(join(home, '.claude/skills-disabled/demo-skill/SKILL.md'), '---\nname: demo-skill\n---\n');
  assert.deepEqual(await actOn({ home, item: off, action: 'on', ...f }), { ok: false, error: 'failed', detail: 'exists' });
  assert.ok(existsSync(join(home, '.claude/skills-disabled/demo-skill')));
});

test('skill remove goes to the trash and restore points there', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const it = item(home, repo, i => i.kind === 'skill' && i.name === 'demo-skill');
  assert.deepEqual(await actOn({ home, item: it, action: 'remove', ...f }), { ok: true });
  assert.deepEqual(f.calls.trash, [it.path]);
  const [r] = listRemoved({ home, now: Date.now() });
  assert.ok(r.id.startsWith(`${it.id}@`)); // its own stored copy assert.equal(r.how, 'trash'); assert.equal(r.kind, 'skill');
  assert.deepEqual(await actOn({ home, item: r, action: 'restore', ...f }), { ok: false, error: 'unsupported', detail: 'trash' });
  // a skill that is already gone is not trashed
  assert.deepEqual(await actOn({ home, item: it, action: 'remove', ...f }), { ok: false, error: 'gone' });
  assert.equal(f.calls.trash.length, 1);
});

test('mcp off parks and on restores byte-for-byte', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  const before = json(cj);
  const js = item(home, repo, i => i.name === 'user-srv');
  assert.deepEqual(await actOn({ home, item: js, action: 'off', ...f }), { ok: true });
  const mid = json(cj);
  assert.equal(mid.mcpServers['user-srv'], undefined);
  assert.deepEqual(Object.keys(mid), Object.keys(before));
  assert.deepEqual(Object.keys(mid.mcpServers), ['keep-srv', 'last-srv']);
  assert.deepEqual({ ...mid, mcpServers: null }, { ...before, mcpServers: null });
  assert.ok(backups(home).some(b => b.startsWith('.claude.json.')));
  const parkedFile = join(home, '.roca/skillbook-parked.json');
  assert.equal(mode(parkedFile), 0o600);
  const pk = json(parkedFile);
  assert.equal(pk.v, 1);
  const e = pk.entries.find(x => x.id === js.id);
  assert.deepEqual(e.json, before.mcpServers['user-srv']);
  assert.deepEqual(e.mcp, { transport: 'stdio', command: 'demo', envKeys: ['API_TOKEN'], scope: 'user' });
  assert.equal(e.agent, 'claude'); assert.equal(e.kind, 'mcp'); assert.equal(typeof e.at, 'number');
  // the scan shows it as off with the stored summary
  const parked = item(home, repo, i => i.name === 'user-srv' && i.on === false);
  assert.equal(parked.on, false); assert.deepEqual(parked.mcp.envKeys, ['API_TOKEN']); assert.equal(parked.mcp.command, 'demo');
  assert.deepEqual(await actOn({ home, item: parked, action: 'on', ...f }), { ok: true });
  const after = json(cj);
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(after.mcpServers), Object.keys(before.mcpServers)); // back in its old place
  assert.deepEqual(json(parkedFile).entries, []);

  // Codex TOML: a section with a multi-line array and a sub-table
  const cf = join(home, '.codex/config.toml');
  const cx = item(home, repo, i => i.name === 'codex-srv');
  assert.deepEqual(await actOn({ home, item: cx, action: 'off', ...f }), { ok: true });
  const t = readFileSync(cf, 'utf8');
  assert.equal(t, '# my codex config\nmodel = "m"\n\n[mcp_servers.first]\ncommand = "f"\n\n[profiles.p]\nmodel = "n"\n');
  assert.ok(backups(home).some(b => b.startsWith('config.toml.')));
  const ce = json(parkedFile).entries.find(x => x.id === cx.id);
  assert.equal(ce.toml, '[mcp_servers.codex-srv]\ncommand = "/opt/bin/cx"\nargs = [\n  ["--key", "sk-SECRET2"],\n]\n[mcp_servers.codex-srv.env]\nCX_TOKEN = "sk-SECRET1"\n\n');
  assert.deepEqual(ce.mcp, { transport: 'stdio', command: 'cx', envKeys: ['CX_TOKEN'], scope: 'user' });
  const cxOff = item(home, repo, i => i.name === 'codex-srv' && i.on === false);
  assert.equal(cxOff.on, false);
  assert.deepEqual(await actOn({ home, item: cxOff, action: 'on', ...f }), { ok: true });
  assert.equal(readFileSync(cf, 'utf8'), CODEX);
});

test('mcp in project, .mcp.json and gemini: remove and restore', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const files = { 'proj-srv': join(home, '.claude.json'), 'file-srv': join(repo, '.mcp.json'), 'gem-srv': join(home, '.gemini/settings.json') };
  for (const [name, file] of Object.entries(files)) {
    const before = json(file);
    const it = item(home, repo, i => i.name === name);
    assert.deepEqual(await actOn({ home, item: it, action: 'remove', ...f }), { ok: true }, name);
    assert.ok(!JSON.stringify(json(file)).includes(`"${name}"`), name);
    assert.equal(item(home, repo, i => i.name === name), undefined, name);
    const r = listRemoved({ home, now: Date.now() }).find(x => x.name === name);
    assert.equal(r.name, name); assert.equal(r.kind, 'mcp');
    assert.deepEqual(await actOn({ home, item: r, action: 'restore', ...f }), { ok: true }, name);
    assert.deepEqual(json(file), before, name);
    assert.equal(listRemoved({ home, now: Date.now() }).find(x => x.name === name), undefined);
  }
  assert.equal(mode(join(home, '.roca/skillbook-removed.json')), 0o600);
  // the removed list never carries config contents
  const it = item(home, repo, i => i.name === 'user-srv');
  await actOn({ home, item: it, action: 'remove', ...f });
  assert.ok(!JSON.stringify(listRemoved({ home, now: Date.now() })).includes('sk-SECRET'));
  assert.ok(readFileSync(join(home, '.roca/skillbook-removed.json'), 'utf8').includes('sk-SECRET1'));
});

test('a turned-off mcp can be removed from the parked list', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const it = item(home, repo, i => i.name === 'gem-srv');
  await actOn({ home, item: it, action: 'off', ...f });
  const off = item(home, repo, i => i.name === 'gem-srv' && i.on === false);
  assert.deepEqual(await actOn({ home, item: off, action: 'remove', ...f }), { ok: true });
  assert.deepEqual(json(join(home, '.roca/skillbook-parked.json')).entries, []);
  assert.equal(item(home, repo, i => i.name === 'gem-srv'), undefined);
  const r = listRemoved({ home, now: Date.now() }).find(x => x.name === 'gem-srv');
  assert.deepEqual(await actOn({ home, item: r, action: 'restore', ...f }), { ok: true });
  assert.deepEqual(json(join(home, '.gemini/settings.json')).mcpServers['gem-srv'], { command: 'gem' });
});

test('on / restore never clobber an entry of the same name', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  const it = item(home, repo, i => i.name === 'user-srv');
  await actOn({ home, item: it, action: 'off', ...f });
  const off = item(home, repo, i => i.name === 'user-srv' && i.on === false);
  const c = json(cj); c.mcpServers['user-srv'] = { command: 'someone-else' }; put(cj, c);
  const text = readFileSync(cj, 'utf8');
  assert.deepEqual(await actOn({ home, item: off, action: 'on', ...f }), { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(readFileSync(cj, 'utf8'), text);
  assert.equal(json(join(home, '.roca/skillbook-parked.json')).entries.length, 1);
  // TOML too
  const cf = join(home, '.codex/config.toml');
  const cx = item(home, repo, i => i.name === 'codex-srv');
  await actOn({ home, item: cx, action: 'remove', ...f });
  put(cf, readFileSync(cf, 'utf8') + '[mcp_servers.codex-srv]\ncommand = "new"\n');
  const ct = readFileSync(cf, 'utf8');
  const r = listRemoved({ home, now: Date.now() }).find(x => x.name === 'codex-srv');
  assert.deepEqual(await actOn({ home, item: r, action: 'restore', ...f }), { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(readFileSync(cf, 'utf8'), ct);
});

test('acting on an entry that disappeared fails without writing', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  const it = item(home, repo, i => i.name === 'user-srv');
  const c = json(cj); delete c.mcpServers['user-srv']; put(cj, c);
  const old = new Date(Date.now() - 60000);
  utimesSync(cj, old, old);
  const m0 = statSync(cj).mtimeMs;
  assert.deepEqual(await actOn({ home, item: it, action: 'off', ...f }), { ok: false, error: 'gone' });
  assert.equal(statSync(cj).mtimeMs, m0);
  assert.ok(!existsSync(join(home, '.roca/skillbook-parked.json')));
  assert.deepEqual(backups(home), []);
  // TOML
  const cf = join(home, '.codex/config.toml');
  const cx = item(home, repo, i => i.name === 'codex-srv');
  put(cf, '[profiles.p]\nmodel = "n"\n');
  utimesSync(cf, old, old);
  const t0 = statSync(cf).mtimeMs;
  assert.deepEqual(await actOn({ home, item: cx, action: 'remove', ...f }), { ok: false, error: 'gone' });
  assert.equal(statSync(cf).mtimeMs, t0);
  assert.ok(!existsSync(join(home, '.roca/skillbook-removed.json')));
  // a broken config is not written either
  put(cj, '{broken');
  utimesSync(cj, old, old);
  const r = await actOn({ home, item: it, action: 'off', ...f });
  assert.equal(r.ok, false); assert.equal(r.error, 'failed');
  assert.equal(readFileSync(cj, 'utf8'), '{broken');
  // a parked entry that is no longer parked
  assert.deepEqual(await actOn({ home, item: { ...it, on: false }, action: 'on', ...f }), { ok: false, error: 'gone' });
});

test('plugin actions call the CLI', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const it = item(home, repo, i => i.kind === 'plugin' && i.name === 'demo');
  assert.deepEqual(await actOn({ home, item: it, action: 'off', ...f }), { ok: true });
  assert.deepEqual(f.calls.run, [['claude', 'plugin', 'disable', 'demo@market']]);
  assert.deepEqual(await actOn({ home, item: it, action: 'on', ...f }), { ok: true });
  assert.deepEqual(await actOn({ home, item: it, action: 'remove', ...f }), { ok: true });
  const r = listRemoved({ home, now: Date.now() }).find(x => x.name === 'demo');
  assert.equal(r.how, 'plugin'); assert.equal(r.kind, 'plugin'); assert.equal(r.name, 'demo');
  assert.deepEqual(await actOn({ home, item: r, action: 'restore', ...f }), { ok: true });
  assert.deepEqual(f.calls.run.slice(1), [['claude', 'plugin', 'enable', 'demo@market'], ['claude', 'plugin', 'uninstall', 'demo@market'], ['claude', 'plugin', 'install', 'demo@market']]);
  assert.deepEqual(listRemoved({ home, now: Date.now() }), []);
  // a failing CLI is reported and leaves no removed entry
  const bad = { ...f, run: async () => ({ code: 1, stdout: '', stderr: 'not found\n' }) };
  assert.deepEqual(await actOn({ home, item: it, action: 'remove', ...bad }), { ok: false, error: 'failed', detail: 'not found' });
  assert.deepEqual(listRemoved({ home, now: Date.now() }), []);
  const thrown = { ...f, run: async () => { throw new Error('spawn claude ENOENT'); } };
  assert.deepEqual(await actOn({ home, item: it, action: 'off', ...thrown }), { ok: false, error: 'failed', detail: 'spawn claude ENOENT' });
});

test('unsupported things say so', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const it = item(home, repo, i => i.kind === 'plugin');
  assert.equal((await actOn({ home, item: { ...it, agents: ['gemini'], source: 'extension' }, action: 'off', ...f })).error, 'unsupported');
  assert.equal((await actOn({ home, item: it, action: 'explode', ...f })).error, 'unsupported');
  // a plugin's own skill cannot be moved on its own
  put(join(home, '.claude/plugins/cache/market/demo/1.0.0/skills/plug-skill/SKILL.md'), '---\nname: plug-skill\n---\n');
  const ps = item(home, repo, i => i.name === 'plug-skill');
  assert.equal((await actOn({ home, item: ps, action: 'off', ...f })).error, 'unsupported');
  assert.ok(existsSync(ps.path));
  assert.deepEqual(f.calls, { trash: [], run: [] });
});

test('removed list expires', () => {
  const { home } = fixture();
  const now = Date.now();
  put(join(home, '.roca/skillbook-removed.json'), { v: 1, entries: [
    { id: 'old', kind: 'mcp', agent: 'claude', name: 'old-srv', at: now - 31 * DAY, how: 'config', json: { command: 'x' } },
    { id: 'new', kind: 'plugin', agent: 'claude', name: 'p', at: now - 29 * DAY, how: 'plugin', plugin: { name: 'p', marketplace: 'm' } }] });
  assert.deepEqual(listRemoved({ home, now }), [{ id: 'new', kind: 'plugin', name: 'p', removedAt: now - 29 * DAY, how: 'plugin' }]);
  assert.deepEqual(listRemoved({ home: join(home, 'nowhere'), now }), []);
});

// ---- fix round 1 ----
test('stored entries never overwrite each other', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  const first = json(cj).mcpServers['user-srv'];
  const it = item(home, repo, i => i.name === 'user-srv');
  assert.deepEqual(await actOn({ home, item: it, action: 'off', ...f }), { ok: true });
  // the user adds a server of the same name again and turns it off too
  const c = json(cj); c.mcpServers['user-srv'] = { command: 'second' }; put(cj, c);
  const again = item(home, repo, i => i.name === 'user-srv' && i.on === true);
  assert.deepEqual(await actOn({ home, item: again, action: 'off', ...f }), { ok: true });
  assert.equal(json(join(home, '.roca/skillbook-parked.json')).entries.length, 2);
  const parked = scan(home, repo).filter(i => i.name === 'user-srv' && i.on === false);
  assert.equal(parked.length, 2);
  assert.equal(new Set(parked.map(i => i.id)).size, 2);
  const [p1, p2] = parked;
  assert.deepEqual(await actOn({ home, item: p1, action: 'on', ...f }), { ok: true });
  assert.deepEqual(json(cj).mcpServers['user-srv'], first);
  assert.deepEqual(await actOn({ home, item: p2, action: 'on', ...f }), { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(json(join(home, '.roca/skillbook-parked.json')).entries.length, 1);
  // removed store: two removals of the same name both stay restorable
  const live = item(home, repo, i => i.name === 'user-srv' && i.on === true);
  await actOn({ home, item: live, action: 'remove', ...f });
  const p2b = item(home, repo, i => i.name === 'user-srv' && i.on === false);
  await actOn({ home, item: p2b, action: 'remove', ...f });
  const rows = listRemoved({ home, now: Date.now() }).filter(r => r.name === 'user-srv');
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(r => r.id)).size, 2);
  assert.deepEqual(await actOn({ home, item: rows[0], action: 'restore', ...f }), { ok: true });
  assert.deepEqual(await actOn({ home, item: rows[1], action: 'restore', ...f }), { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(listRemoved({ home, now: Date.now() }).length, 1);
});

test('toml restore keeps lines apart and refuses an unparsable target', async () => {
  const { home } = fixture();
  const f = fakes();
  const cf = join(home, '.codex/config.toml');
  const entry = (id, toml, before) => ({ id, sid: id, kind: 'mcp', agent: 'codex', name: 'x', loc: { file: cf, where: 'codex' }, at: Date.now(), toml, ...(before ? { before } : {}) });
  put(cf, '[a]\r\nk = 1\r\n[b]\r\nm = 2');
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [entry('p1', '[mcp_servers.x]\r\ncommand = "c"', '[b]')] });
  assert.deepEqual(await actOn({ home, item: { id: 'p1', kind: 'mcp', name: 'x', on: false }, action: 'on', ...f }), { ok: true });
  assert.equal(readFileSync(cf, 'utf8'), '[a]\r\nk = 1\r\n[mcp_servers.x]\r\ncommand = "c"\r\n[b]\r\nm = 2');
  // appended at the end of a file without a final newline
  put(cf, '[a]\nk = 1');
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [entry('p2', '[mcp_servers.x]\ncommand = "c"\n')] });
  assert.deepEqual(await actOn({ home, item: { id: 'p2', kind: 'mcp', name: 'x', on: false }, action: 'on', ...f }), { ok: true });
  assert.equal(readFileSync(cf, 'utf8'), '[a]\nk = 1\n[mcp_servers.x]\ncommand = "c"\n');
  // a target with a value that never closes is not touched
  const open = '[a]\nargs = [\n  "q",\n[b]\n';
  put(cf, open);
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [entry('p3', '[mcp_servers.x]\ncommand = "c"\n', '[b]')] });
  assert.deepEqual(await actOn({ home, item: { id: 'p3', kind: 'mcp', name: 'x', on: false }, action: 'on', ...f }), { ok: false, error: 'failed', detail: 'unparsed' });
  assert.equal(readFileSync(cf, 'utf8'), open);
});

test('on / restore into a missing or empty ~/.claude.json refuses', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  for (const name of ['user-srv', 'proj-srv']) {
    const it = item(home, repo, i => i.name === name);
    await actOn({ home, item: it, action: 'off', ...f });
  }
  const parked = scan(home, repo).filter(i => i.on === false);
  assert.equal(parked.length, 2);
  for (const content of [null, '', '  \n']) {
    if (content === null) rmSync(cj); else writeFileSync(cj, content);
    for (const p of parked) assert.deepEqual(await actOn({ home, item: p, action: 'on', ...f }), { ok: false, error: 'failed', detail: 'missing' });
    if (content === null) assert.ok(!existsSync(cj)); else assert.equal(readFileSync(cj, 'utf8'), content);
  }
  assert.equal(json(join(home, '.roca/skillbook-parked.json')).entries.length, 2);
});

test('a symlinked config stays a symlink', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const cj = join(home, '.claude.json');
  const real = join(home, 'dotfiles', 'claude.json');
  mkdirSync(join(home, 'dotfiles'), { recursive: true });
  renameSync(cj, real); symlinkSync(real, cj);
  const cf = join(home, '.codex/config.toml');
  const realT = join(home, 'dotfiles', 'config.toml');
  renameSync(cf, realT); symlinkSync(realT, cf);
  const before = json(real);
  for (const name of ['user-srv', 'codex-srv']) {
    const it = item(home, repo, i => i.name === name);
    assert.deepEqual(await actOn({ home, item: it, action: 'off', ...f }), { ok: true }, name);
  }
  assert.ok(lstatSync(cj).isSymbolicLink()); assert.ok(lstatSync(cf).isSymbolicLink());
  assert.equal(json(real).mcpServers['user-srv'], undefined);
  assert.ok(!readFileSync(realT, 'utf8').includes('codex-srv'));
  assert.ok(backups(home).some(b => b.startsWith('claude.json.')));
  for (const p of scan(home, repo).filter(i => i.on === false && i.kind === 'mcp')) assert.deepEqual(await actOn({ home, item: p, action: 'on', ...f }), { ok: true });
  assert.ok(lstatSync(cj).isSymbolicLink()); assert.ok(lstatSync(cf).isSymbolicLink());
  assert.deepEqual(json(real), before);
  assert.equal(readFileSync(realT, 'utf8'), CODEX);
});

test('skill remove only takes folders the scan reads', async () => {
  const { home, repo } = fixture();
  const f = fakes();
  const forged = join(home, 'x', 'skills', 'y');
  put(join(forged, 'SKILL.md'), '---\nname: y\n---\n');
  for (const it of [
    { id: 'skill:user:claude::y', kind: 'skill', name: 'y', agents: ['claude'], path: forged },
    { id: 'skill:project:claude:alpha:y', kind: 'skill', name: 'y', agents: ['claude'], repo: 'alpha', path: forged },
    { id: 'skill:project:claude:x:y', kind: 'skill', name: 'y', agents: ['claude'], repo: 'x', path: join(home, 'x', '.claude', 'skills', 'y') }]) {
    assert.deepEqual(await actOn({ home, item: it, action: 'remove', repos: [repo], ...f }), { ok: false, error: 'unsupported', detail: 'location' });
  }
  assert.ok(existsSync(forged));
  assert.deepEqual(f.calls.trash, []);
  // a repo skill (from the scan) and a Codex skill are accepted
  put(join(repo, '.claude/skills/proj-skill/SKILL.md'), '---\nname: proj-skill\n---\n');
  put(join(home, '.codex/skills/cx-skill/SKILL.md'), '---\nname: cx-skill\n---\n');
  for (const name of ['proj-skill', 'cx-skill']) assert.deepEqual(await actOn({ home, item: item(home, repo, i => i.name === name), action: 'remove', repos: [repo], ...f }), { ok: true }, name);
  assert.equal(f.calls.trash.length, 2);
});
