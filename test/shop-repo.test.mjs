// Shop pasted links: shop/repo.mjs (made-up names, temp dirs only, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRepoLink, fetchRepo, detectRepo } from '../shop/repo.mjs';

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
  ];
  for (const t of bad) assert.equal(parseRepoLink(t), null, JSON.stringify(t));
  assert.deepEqual(parseRepoLink('own-er/re.po'), { owner: 'own-er', repo: 're.po' });
  assert.deepEqual(parseRepoLink(' https://github.com/a/b '), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/tree/v1.2'), { owner: 'a', repo: 'b', ref: 'v1.2' });
  assert.deepEqual(parseRepoLink('https://github.com/a/b/tree/main/skills/x'), { owner: 'a', repo: 'b', ref: 'main', path: 'skills/x' });
});

test('clone command is fixed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; };
  const dir = join(home, '.roca', 'shop', 'a-b');
  let r = await fetchRepo({ home, link: 'a/b', run });
  assert.deepEqual(r, { ok: true, dir });
  assert.deepEqual(calls[0], ['git', ['clone', '--depth', '1', '--', 'https://github.com/a/b.git', dir]]);
  r = await fetchRepo({ home, link: 'https://github.com/a/b/tree/v2/sub', run });
  assert.deepEqual(calls[1], ['git', ['clone', '--depth', '1', '--branch', 'v2', '--', 'https://github.com/a/b.git', dir]]);
  const n = calls.length;
  assert.deepEqual(await fetchRepo({ home, link: '--upload-pack=x', run }), { ok: false, error: 'bad link' });
  assert.equal(calls.length, n);
  assert.deepEqual(await fetchRepo({ home, link: 'a/b', run: async () => ({ code: 128 }) }), { ok: false, error: 'clone failed' });
  assert.deepEqual(await fetchRepo({ home, link: 'a/b', run: async () => { throw new Error('x'); } }), { ok: false, error: 'clone failed' });
});

test('older clone of the same repo is replaced', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shop-home-'));
  const dir = join(home, '.roca', 'shop', 'a-b');
  put(join(dir, 'old.txt'), 'x');
  await fetchRepo({ home, link: 'a/b', run: async () => ({ code: 0 }) });
  assert.equal(existsSync(join(dir, 'old.txt')), false);
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
