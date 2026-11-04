// Skillbook inventory scan: skillbook/scan.mjs over a temp home (made-up names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanInventory } from '../skillbook/scan.mjs';

const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); };
const skill = (dir, name, desc) => put(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
const SECRET_SRV = { command: '/usr/local/bin/demo-srv', args: ['--key', 'sk-SECRET2'], env: { API_TOKEN: 'sk-SECRET1' } };
const SECRET_HTTP = { type: 'http', url: 'https://h/mcp?token=sk-SECRET4', headers: { Authorization: 'Bearer sk-SECRET3' } };

function fixture({ brokenClaudeJson = false, withCodex = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sb-scan-'));
  const repo = join(home, 'work', 'alpha');
  const other = join(home, 'work', 'beta');
  skill(join(home, '.claude/skills'), 'user-skill', 'Does a thing. Use when "say hi".');
  skill(join(home, '.claude/skills-disabled'), 'off-skill', 'Parked.');
  skill(join(home, '.agents/skills'), 'shared-skill', 'Shared one.');
  skill(join(repo, '.claude/skills'), 'proj-skill', 'Project one.');
  put(join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: {
    'demoplug@mkt': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/mkt/demoplug/1.0.0'), version: '1.0.0' }],
    'idleplug@mkt': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/mkt/idleplug/2.0.0'), version: '2.0.0' }] } });
  skill(join(home, '.claude/plugins/cache/mkt/demoplug/1.0.0/skills'), 'plug-skill', 'From plugin.');
  put(join(home, '.claude/settings.json'), { enabledPlugins: { 'demoplug@mkt': true } });
  put(join(home, '.claude.json'), brokenClaudeJson ? '{not json' : { mcpServers: { 'user-srv': SECRET_SRV, 'user-http': SECRET_HTTP },
    projects: { [repo]: { mcpServers: { 'proj-srv': { command: 'node', args: ['x'] } } }, [other]: { mcpServers: { 'beta-srv': { command: 'node' } } } } });
  put(join(repo, '.mcp.json'), { mcpServers: { 'file-srv': { command: 'npx', env: { K1: 'v' } } } });
  if (withCodex) put(join(home, '.codex/config.toml'), '[mcp_servers.codex-srv]\ncommand = "/opt/bin/cx"\nargs = ["--key", "sk-SECRET2"]\n[mcp_servers.codex-srv.env]\nCX_TOKEN = "sk-SECRET1"\n');
  put(join(home, '.gemini/settings.json'), { mcpServers: { 'gem-srv': { command: 'gem', env: { G_TOKEN: 'sk-SECRET1' } } } });
  put(join(home, '.gemini/extensions/gem-ext/gemini-extension.json'), { name: 'gem-ext', description: 'An extension.' });
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [{ id: 'mcp:user:claude::parked-srv', kind: 'mcp', agent: 'claude', name: 'parked-srv', loc: { file: join(home, '.claude.json'), where: 'claude-user' }, at: 1, json: { command: 'x', env: { T: 'sk-SECRET1' } } }] });
  return { home, repo, other };
}
const find = (r, f) => r.items.find(f);

test('finds every kind', () => {
  const { home, repo } = fixture();
  const r = scanInventory({ home, repos: [repo] });
  const us = find(r, i => i.name === 'user-skill');
  assert.equal(us.kind, 'skill'); assert.equal(us.source, 'user'); assert.deepEqual(us.agents, ['claude']); assert.deepEqual(us.triggers, ['say hi']);
  assert.equal(find(r, i => i.name === 'off-skill').on, false);
  const ps = find(r, i => i.kind === 'skill' && i.source === 'plugin');
  assert.equal(ps.usageKey, 'demoplug:plug-skill'); assert.equal(ps.on, true);
  assert.deepEqual(find(r, i => i.name === 'shared-skill').agents, ['claude', 'codex', 'gemini']);
  const pj = find(r, i => i.name === 'proj-skill');
  assert.equal(pj.repo, 'alpha'); assert.equal(pj.source, 'project');
  assert.equal(find(r, i => i.kind === 'plugin' && i.name === 'demoplug').on, true);
  assert.equal(find(r, i => i.kind === 'plugin' && i.name === 'idleplug').on, false);
  const u = find(r, i => i.name === 'user-srv');
  assert.equal(u.mcp.scope, 'user'); assert.equal(u.mcp.command, 'demo-srv'); assert.equal(u.loc.where, 'claude-user'); assert.equal(u.loc.file, join(home, '.claude.json'));
  assert.equal(find(r, i => i.name === 'user-http').mcp.transport, 'http');
  const ps2 = find(r, i => i.name === 'proj-srv');
  assert.equal(ps2.mcp.scope, 'project'); assert.equal(ps2.repo, 'alpha'); assert.equal(ps2.loc.where, 'claude-project');
  assert.equal(find(r, i => i.name === 'file-srv').loc.where, 'mcpjson');
  const cx = find(r, i => i.name === 'codex-srv');
  assert.deepEqual(cx.agents, ['codex']); assert.equal(cx.loc.where, 'codex'); assert.deepEqual(cx.mcp.envKeys, ['CX_TOKEN']); assert.equal(cx.mcp.command, 'cx');
  assert.deepEqual(find(r, i => i.name === 'gem-srv').agents, ['gemini']);
  assert.equal(find(r, i => i.kind === 'plugin' && i.source === 'extension').name, 'gem-ext');
  const pk = find(r, i => i.id === 'mcp:user:claude::parked-srv');
  assert.equal(pk.on, false); assert.equal(pk.name, 'parked-srv'); assert.equal(pk.loc.where, 'claude-user');
  assert.equal(new Set(r.items.map(i => i.id)).size, r.items.length);
});

test('scan never returns secret values', () => {
  const { home, repo } = fixture();
  const r = scanInventory({ home, repos: [repo] });
  assert.ok(!JSON.stringify(r).includes('sk-SECRET'));
  assert.deepEqual(find(r, i => i.name === 'user-srv').mcp.envKeys, ['API_TOKEN']);
  assert.ok(!/token=|Bearer|--key/.test(JSON.stringify(r)));
});

test('a broken source does not hide the others', () => {
  const { home, repo } = fixture({ brokenClaudeJson: true, withCodex: false });
  const snap = () => [home, join(home, '.claude'), join(home, '.claude.json')].map(p => statSync(p).mtimeMs).concat(readdirSync(home).length);
  const before = snap();
  const r = scanInventory({ home, repos: [repo] });
  assert.equal(r.sources.find(s => s.id === 'claude-mcp').ok, false);
  assert.equal(r.sources.find(s => s.id === 'codex-mcp').ok, false);
  assert.ok(find(r, i => i.name === 'user-skill'));
  assert.ok(find(r, i => i.name === 'gem-srv'));
  assert.deepEqual(snap(), before);
});

test('only listed repos', () => {
  const { home, repo } = fixture();
  const r = scanInventory({ home, repos: [repo] });
  assert.equal(find(r, i => i.name === 'beta-srv'), undefined);
  assert.ok(find(scanInventory({ home, repos: [repo, join(home, 'work', 'beta')] }), i => i.name === 'beta-srv'));
});

test('parse errors never leak file text', () => {
  const { home, repo } = fixture();
  put(join(home, '.claude.json'), '{"mcpServers":{"x":{"env":{"API_TOKEN":sk-SECRET9}}}}');
  const r = scanInventory({ home, repos: [repo] });
  assert.equal(r.sources.find(s => s.id === 'claude-mcp').error, 'invalid JSON');
  assert.ok(!JSON.stringify(r).includes('sk-SECRET'));
});

test('command shows only the first token basename', () => {
  const { home, repo } = fixture();
  put(join(home, '.claude.json'), { mcpServers: { a: { command: 'npx -y pkg --token=a/b' }, b: { command: 'node /p/server.js' } } });
  const r = scanInventory({ home, repos: [repo] });
  assert.equal(find(r, i => i.name === 'a').mcp.command, 'npx');
  assert.equal(find(r, i => i.name === 'b').mcp.command, 'node');
  assert.ok(!JSON.stringify(r.items.filter(i => i.name === 'a' || i.name === 'b')).includes('token'));
});

test('parked entries show their stored mcp summary, never json/toml', () => {
  const { home, repo } = fixture();
  const e = (id, mcp, extra = {}) => ({ id, kind: 'mcp', agent: 'codex', name: id, loc: { file: '/x', where: 'codex' }, at: 1, ...(mcp ? { mcp } : {}), ...extra });
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [
    e('full', { transport: 'http', command: 'cx', envKeys: ['A_TOKEN'], headerKeys: ['Authorization'], scope: 'user' }, { toml: '[mcp_servers.full]\nurl = "https://h/?token=sk-SECRET7"\n' }),
    e('odd', { transport: 'ftp', command: 42, envKeys: ['OK', 7, 'sk-SECRET8 x'], headerKeys: 'nope', scope: 'weird' }),
    e('none')] });
  const r = scanInventory({ home, repos: [repo] });
  const get = id => find(r, i => i.id === id).mcp;
  assert.deepEqual(get('full'), { transport: 'http', command: 'cx', envKeys: ['A_TOKEN'], headerKeys: ['Authorization'], scope: 'user' });
  assert.deepEqual(get('odd'), { transport: 'stdio', envKeys: ['OK'], scope: 'user' });
  assert.deepEqual(get('none'), { transport: 'stdio', envKeys: [], scope: 'user' });
  assert.ok(!JSON.stringify(r).includes('sk-SECRET'));
});

test('claude project mcp items carry the exact projects key', () => {
  const { home, repo } = fixture();
  assert.equal(find(scanInventory({ home, repos: [repo] }), i => i.name === 'proj-srv').loc.project, repo);
});

test('the same mcp name in claude project and .mcp.json are two items', () => {
  const { home, repo } = fixture();
  put(join(repo, '.mcp.json'), { mcpServers: { 'proj-srv': { command: 'npx' } } });
  const both = scanInventory({ home, repos: [repo] }).items.filter(i => i.name === 'proj-srv');
  assert.deepEqual(both.map(i => i.loc.where).sort(), ['claude-project', 'mcpjson']);
  assert.equal(new Set(both.map(i => i.id)).size, 2);
});

test('parked entries are listed by their store id', () => {
  const { home, repo } = fixture();
  const e = (sid, at) => ({ id: 'mcp:same', sid, kind: 'mcp', agent: 'claude', name: 'twin', loc: { file: '/x', where: 'codex' }, at });
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [e('mcp:same@1', 1), e('mcp:same@2', 2)] });
  const r = scanInventory({ home, repos: [repo] });
  assert.deepEqual(r.items.filter(i => i.name === 'twin').map(i => i.id), ['mcp:same@1', 'mcp:same@2']);
});

test('parked entries with an invalid loc are dropped', () => {
  const { home, repo } = fixture();
  const e = (id, loc) => ({ id, kind: 'mcp', agent: 'claude', name: id, loc, at: 1 });
  put(join(home, '.roca/skillbook-parked.json'), { v: 1, entries: [e('bad-where', { file: '/x', where: 'nope' }), e('no-file', { where: 'codex' }), e('no-loc'), e('ok', { file: '/x', where: 'codex' })] });
  const r = scanInventory({ home, repos: [repo] });
  assert.deepEqual(r.items.filter(i => i.on === false && i.kind === 'mcp').map(i => i.id), ['ok']);
});

test('gemini url is sse, httpUrl is http', () => {
  const { home, repo } = fixture();
  put(join(home, '.gemini/settings.json'), { mcpServers: { s: { url: 'https://h/x' }, h: { httpUrl: 'https://h/y' }, c: { command: 'gem' } } });
  const r = scanInventory({ home, repos: [repo] });
  assert.equal(find(r, i => i.name === 's').mcp.transport, 'sse');
  assert.equal(find(r, i => i.name === 'h').mcp.transport, 'http');
  assert.equal(find(r, i => i.name === 'c').mcp.transport, 'stdio');
});

test('same repo basename in two places gets distinct ids', () => {
  const { home } = fixture();
  const a = join(home, 'a', 'app'), b = join(home, 'b', 'app');
  skill(join(a, '.claude/skills'), 'same', 'A'); skill(join(b, '.claude/skills'), 'same', 'B');
  const r = scanInventory({ home, repos: [a, b] });
  const hits = r.items.filter(i => i.name === 'same');
  assert.equal(hits.length, 2); assert.equal(hits[0].repo, 'app');
  assert.notEqual(hits[0].id, hits[1].id);
  assert.equal(new Set(r.sources.map(s => s.id)).size, r.sources.length);
});
