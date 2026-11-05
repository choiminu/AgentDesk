// Shop pasted links: shop/repo.mjs (made-up names, temp dirs only, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoLink, fetchRepo, detectRepo, inCloneOf } from '../shop/repo.mjs';

const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); };
const skillMd = (dir, name, desc) => put(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);

test('only plain GitHub links are accepted', () => {
  const bad = [
    'https://evil.com/x', 'https://evil.com/a/b', 'git@github.com:a/b', 'ssh://git@github.com/a/b', 'http://github.com/a/b',
    '--upload-pack=x', '--upload-pack=x/y', 'owner/../repo', '../a/b', './a', 'a/.', 'a/..', '-a/b', 'a/b/c',
    'https://github.com/a/b/tree/-x/p', 'https://github.com/a/b/tree/a..b/p', 'https://github.com/a/b/tree/main/../x',
    'https://github.com.evil.com/a/b', 'https://user@github.com/a/b', 'https://github.com:444/a/b', 'https://github.com/a/b?x=1',
    'https://github.com/a/b#x', 'https://github.com/a', 'https://github.com/a/b/blob/main/x', 'file:///etc/passwd',
    'a/b c', 'a/b;rm', 'a/b$(x)', '', '   ', null, undefined, 42, 'a/b\nc/d', 'https://github.com/a/b/tree/', 'https://github.com/a/b/tree/main/%2e%2e/x',
    '.a/b', 'a/.b', 'https://github.com/.a/b', 'https://github.com/a/.git', 'https://github.com/a/.b/tree/main',
  ];
  for (const t of bad) assert.equal(parseRepoLink(t), null, JSON.stringify(t));
  assert.deepEqual(parseRepoLink('own-er/re.po'), { owner: 'own-er', repo: 're.po' });
  assert.deepEqual(parseRepoLink(' https://github.com/a/b '), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/tree/v1.2'), { owner: 'a', repo: 'b', ref: 'v1.2' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/tree/main/skills/x'), { owner: 'a', repo: 'b', ref: 'main', path: 'skills/x' });
});

const OPTS = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
const mkRun = (calls, code = 0) => async (cmd, args, opts) => { calls.push([cmd, args, opts]); if (code === 0) mkdirSync(args[args.length - 1], { recursive: true }); return { code, stdout: '', stderr: '' }; };

test('clone command is fixed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const calls = [];
  const run = mkRun(calls);
  const dir = join(home, '.roca', 'shop', 'a__b');
  const tmp = join(home, '.roca', 'shop', '.tmp-a__b');
  let r = await fetchRepo({ home, link: 'a/b', run });
  assert.deepEqual(r, { ok: true, dir });
  assert.deepEqual(calls[0][1], [...OPTS, 'clone', '--depth', '1', '--no-tags', '--', 'https://github.com/a/b.git', tmp]);
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0][2], { env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' }, timeout: 60000 });
  assert.ok(existsSync(dir) && !existsSync(tmp));
  r = await fetchRepo({ home, link: 'https://github.com/a/b/tree/v2/sub', run });
  assert.deepEqual(r, { ok: true, dir: join(home, '.roca', 'shop', 'a__b@v2') });   // a ref gets its own folder
  assert.deepEqual(calls[1][1], [...OPTS, 'clone', '--depth', '1', '--no-tags', '--branch', 'v2', '--', 'https://github.com/a/b.git', join(home, '.roca', 'shop', '.tmp-a__b@v2')]);
  const n = calls.length;
  assert.deepEqual(await fetchRepo({ home, link: '--upload-pack=x', run }), { ok: false, error: 'bad link' });
  assert.equal(calls.length, n);
  assert.deepEqual(await fetchRepo({ home, link: 'a/b', run: async () => ({ code: 128 }) }), { ok: false, error: 'clone failed' });
  assert.deepEqual(await fetchRepo({ home, link: 'a/b', run: async () => { throw new Error('x'); } }), { ok: false, error: 'clone failed' });
});

test('older clone is replaced on success and kept on failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const dir = join(home, '.roca', 'shop', 'a__b');
  put(join(dir, 'old.txt'), 'x');
  assert.equal((await fetchRepo({ home, link: 'a/b', run: mkRun([], 128) })).ok, false);
  assert.ok(existsSync(join(dir, 'old.txt')));
  assert.equal((await fetchRepo({ home, link: 'a/b', run: async () => { throw new Error('t'); } })).ok, false);
  assert.ok(existsSync(join(dir, 'old.txt')));
  assert.equal((await fetchRepo({ home, link: 'a/b', run: mkRun([]) })).ok, true);
  assert.equal(existsSync(join(dir, 'old.txt')), false);
});

test('symlinked manifest dirs and oversized manifests are ignored', () => {
  const outside = mkdtempSync(join(tmpdir(), 'shop-out-'));
  put(join(outside, 'plugin.json'), { name: 'evil' });
  put(join(outside, 'marketplace.json'), { name: 'evil' });
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  symlinkSync(outside, join(d, '.claude-plugin'));
  assert.deepEqual(detectRepo(d), []);
  const e = mkdtempSync(join(tmpdir(), 'shop-det-'));
  mkdirSync(join(e, 'sub'));
  symlinkSync(outside, join(e, 'sub', 'link'));
  put(join(outside, 'sub-plugin', '.claude-plugin', 'plugin.json'), { name: 'evil2' });
  assert.deepEqual(detectRepo(e, 'sub/link'), []);
  const big = mkdtempSync(join(tmpdir(), 'shop-det-'));
  put(join(big, 'server.json'), JSON.stringify({ name: 'big', pad: 'x'.repeat(1024 * 1024 + 10) }));
  put(join(big, '.claude-plugin', 'plugin.json'), { name: 'ok' });
  assert.deepEqual(detectRepo(big).map(x => x.name), ['ok']);
});

test('hasScripts fails closed on big or deep folders', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  skillMd(join(d, 'deep'), 'deep', 'x');
  put(join(d, 'deep', 'a', 'b', 'c', 'd', 'note.txt'), 'x');
  skillMd(join(d, 'many'), 'many', 'x');
  for (let i = 0; i < 520; i++) put(join(d, 'many', `f${i}.txt`), 'x');
  const r = Object.fromEntries(detectRepo(d).map(x => [x.name, x.hasScripts]));
  assert.deepEqual(r, { deep: true, many: true });
});

test('skills under .claude/skills are found', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  skillMd(join(d, '.claude', 'skills', 'hidden'), 'hidden', 'h');
  assert.deepEqual(detectRepo(d).map(x => x.name), ['hidden']);
});

test('detection order and several matches', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  put(join(d, '.claude-plugin', 'marketplace.json'), { name: 'demo-mkt', description: 'a market', plugins: [{ name: 'p1' }] });
  skillMd(join(d, 'skills', 'alpha'), 'alpha', 'does alpha');
  put(join(d, 'server.json'), { name: 'io.example/demo', description: 'srv' });
  const r = detectRepo(d);
  assert.deepEqual(r.map(x => x.kind), ['marketplace', 'skill', 'mcp']);
  assert.equal(r[0].name, 'demo-mkt');
  assert.equal(r[0].manifest.plugins[0].name, 'p1');
  assert.equal(r[1].name, 'alpha');
  assert.equal(r[1].description, 'does alpha');
  assert.equal(r[1].path, join(d, 'skills', 'alpha'));
  assert.equal(r[2].name, 'io.example/demo');
  const e = mkdtempSync(join(tmpdir(), 'shop-det-'));
  put(join(e, '.claude-plugin', 'plugin.json'), { name: 'plug', description: 'pd', version: '1.0.0' });
  assert.deepEqual(detectRepo(e).map(x => [x.kind, x.name]), [['plugin', 'plug']]);
  assert.deepEqual(detectRepo(mkdtempSync(join(tmpdir(), 'shop-det-'))), []);
});

test('path selects a subfolder and cannot escape', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  skillMd(join(d, 'a', 'one'), 'one', '1');
  skillMd(join(d, 'b', 'two'), 'two', '2');
  assert.deepEqual(detectRepo(d, 'b').map(x => x.name), ['two']);
  assert.deepEqual(detectRepo(d, '../..'), []);
  assert.deepEqual(detectRepo(d, 'nope'), []);
});

test('skill with scripts is flagged', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  skillMd(join(d, 'plain'), 'plain', 'p');
  skillMd(join(d, 'withpy'), 'withpy', 'w');
  put(join(d, 'withpy', 'tool.py'), 'print(1)');
  skillMd(join(d, 'withexec'), 'withexec', 'e');
  put(join(d, 'withexec', 'run'), '#!/bin/sh\n'); chmodSync(join(d, 'withexec', 'run'), 0o755);
  const r = Object.fromEntries(detectRepo(d).map(x => [x.name, x.hasScripts]));
  assert.deepEqual(r, { plain: false, withpy: true, withexec: true });
});

test('skill name falls back to folder; root SKILL.md is found', () => {
  const d = mkdtempSync(join(tmpdir(), 'shop-det-'));
  put(join(d, 'noname', 'SKILL.md'), '---\ndescription: x\n---\n');
  assert.equal(detectRepo(d)[0].name, 'noname');
  const e = mkdtempSync(join(tmpdir(), 'shop-det-'));
  skillMd(e, 'rootskill', 'r');
  assert.equal(detectRepo(e)[0].name, 'rootskill');
});

test('clone folders never collide: acme-tools/kit and acme/tools-kit, and an owner with "_" is no GitHub account', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const run = mkRun([]);
  const a = await fetchRepo({ home, link: 'acme-tools/kit', run }), b = await fetchRepo({ home, link: 'acme/tools-kit', run });
  assert.notEqual(a.dir, b.dir);
  assert.equal(parseRepoLink('ac_me/kit'), null);
  assert.equal(parseRepoLink('-acme/kit'), null);
  assert.ok(inCloneOf(join(home, '.roca', 'shop', 'acme__kit@v2', 'sub'), home, 'acme', 'kit'));
  assert.ok(!inCloneOf(join(home, '.roca', 'shop', 'acme__kit2'), home, 'acme', 'kit'));
  assert.ok(!inCloneOf(join(home, '.roca', 'shop', 'acme__kit@..', 'x'), home, 'acme', 'kit'));
  rmSync(home, { recursive: true, force: true });
});

test('a preview never replaces a folder Claude Code registered as a marketplace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const calls = [], run = mkRun(calls);
  const first = await fetchRepo({ home, link: 'acme/kit', run });
  writeFileSync(join(first.dir, 'mark'), 'installed');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ kit: { source: { source: 'directory', path: first.dir } } }));
  const again = await fetchRepo({ home, link: 'acme/kit', run });
  assert.deepEqual(again, { ok: true, dir: first.dir, kept: true });
  assert.equal(calls.length, 1, 'no second clone');
  assert.equal(readFileSync(join(first.dir, 'mark'), 'utf8'), 'installed');
  rmSync(home, { recursive: true, force: true });
});
