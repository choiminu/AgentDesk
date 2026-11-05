// Shop installs: shop/install.mjs and addMcpEntry over a temp home with a fake runner (made-up names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, realpathSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planInstall } from '../shop/plan.mjs';
import { runInstall } from '../shop/install.mjs';
import { addMcpEntry } from '../skillbook/actions.mjs';

const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n'); };
const json = f => JSON.parse(readFileSync(f, 'utf8'));
const SECRET = 'sk-test-SECRET';
const home0 = (cfg = { numStartups: 1, mcpServers: { 'keep-srv': { command: 'a' } } }) => {
  const home = mkdtempSync(join(tmpdir(), 'shop-inst-'));
  if (cfg !== null) put(join(home, '.claude.json'), cfg);
  return home;
};
const fakeRun = (calls, answer = () => ({ code: 0, stdout: '', stderr: '' })) => async (cmd, args, opts) => {
  calls.push([cmd, ...args]);
  return answer(cmd, args, opts);
};
function allFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) allFiles(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}
const count = (text, s) => text.split(s).length - 1;

const npmItem = {
  kind: 'mcp', name: 'io.example/demo-srv',
  registry: { packages: [{ registryType: 'npm', identifier: '@example/demo-srv', version: '1.0.0', environmentVariables: [{ name: 'TOKEN', isSecret: true, isRequired: true }] }] },
};

test('env values only reach the config entry', async () => {
  const home = home0();
  const plan = planInstall(npmItem, { have: { npx: true } });
  assert.equal(plan.kind, 'mcp-write');
  assert.deepEqual(plan.needs, ['TOKEN']);
  const calls = [];
  const r = await runInstall({ home, plan, env: { TOKEN: SECRET }, run: fakeRun(calls) });
  assert.deepEqual(r, { ok: true, route: 'config' });
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.ok(!JSON.stringify(calls).includes(SECRET));
  const cfg = json(join(home, '.claude.json'));
  assert.equal(cfg.numStartups, 1);
  assert.deepEqual(cfg.mcpServers['keep-srv'], { command: 'a' });
  assert.deepEqual(cfg.mcpServers['demo-srv'], { command: 'npx', args: ['-y', '@example/demo-srv@1.0.0'], env: { TOKEN: SECRET } });
  assert.equal(count(readFileSync(join(home, '.claude.json'), 'utf8'), SECRET), 1);
  const files = allFiles(home);
  const backups = files.filter(f => f.includes(join('.roca', 'skillbook-backup')));
  assert.equal(backups.length, 1); // the previous config
  for (const f of files) if (f !== join(home, '.claude.json')) assert.ok(!readFileSync(f, 'utf8').includes(SECRET), f);
  // the plan object handed in keeps its placeholders
  assert.deepEqual(plan.entry.env, { TOKEN: '${TOKEN}' });
});

test('placeholders in env and headers are filled, other text is kept', async () => {
  const home = home0();
  const plan = {
    kind: 'mcp-write', show: ['~/.claude.json mcpServers.hdr-srv', '  API_KEY', '  PASS'], needs: ['API_KEY', 'PASS'],
    entry: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${API_KEY}', 'X-Other': '${NOT_NEEDED}' }, env: { P: '${PASS}' } },
  };
  const r = await runInstall({ home, plan, env: { API_KEY: 'k-1', PASS: 'p1' }, run: fakeRun([]) });
  assert.deepEqual(r, { ok: true, route: 'config' });
  assert.deepEqual(json(join(home, '.claude.json')).mcpServers['hdr-srv'], {
    type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k-1', 'X-Other': '${NOT_NEEDED}' }, env: { P: 'p1' },
  });
});

test('a needed placeholder outside env / headers is refused', async () => {
  const before = { mcpServers: {} };
  for (const entry of [
    { command: 'npx', args: ['-y', 'demo', '--key=${TOKEN}'], env: { TOKEN: '${TOKEN}' } },
    { type: 'http', url: 'https://example.test/${TOKEN}' },
  ]) {
    const home = home0(before);
    const plan = { kind: 'mcp-write', show: ['~/.claude.json mcpServers.arg-srv'], needs: ['TOKEN'], entry };
    assert.deepEqual(await runInstall({ home, plan, env: { TOKEN: SECRET }, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'bad request' });
    assert.deepEqual(json(join(home, '.claude.json')), before);
  }
});

test('typed values holding ${ are refused', async () => {
  const home = home0();
  const before = readFileSync(join(home, '.claude.json'), 'utf8');
  const plan = planInstall(npmItem, { have: { npx: true } });
  for (const v of ['${HOME}', 'a${PATH}b', 'x${']) {
    assert.deepEqual(await runInstall({ home, plan, env: { TOKEN: v }, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'needs' });
  }
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before);
});

test('missing env values refuse before anything is written', async () => {
  const home = home0();
  const before = readFileSync(join(home, '.claude.json'), 'utf8');
  const plan = planInstall(npmItem, { have: { npx: true } });
  for (const env of [undefined, {}, { TOKEN: '' }, { TOKEN: 5 }, { OTHER: 'x' }]) {
    assert.deepEqual(await runInstall({ home, plan, env, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'needs' });
  }
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before);
  assert.ok(!existsSync(join(home, '.roca')));
});

test('existing mcp name refuses', async () => {
  const home = home0({ mcpServers: { 'demo-srv': { command: 'old' } } });
  const before = readFileSync(join(home, '.claude.json'), 'utf8');
  const plan = planInstall(npmItem, { have: { npx: true } });
  const r = await runInstall({ home, plan, env: { TOKEN: SECRET }, run: fakeRun([]) });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before);
  assert.ok(!existsSync(join(home, '.roca')));
  assert.deepEqual(addMcpEntry({ home, name: 'demo-srv', entry: { command: 'x' } }), { ok: false, error: 'failed', detail: 'exists' });
});

test('missing ~/.claude.json refuses', async () => {
  const plan = planInstall(npmItem, { have: { npx: true } });
  let home = home0(null);
  assert.deepEqual(await runInstall({ home, plan, env: { TOKEN: SECRET }, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'missing' });
  assert.ok(!existsSync(join(home, '.claude.json')));
  home = home0(null);
  put(join(home, '.claude.json'), '  \n');
  assert.deepEqual(addMcpEntry({ home, name: 'a', entry: { command: 'x' } }), { ok: false, error: 'failed', detail: 'missing' });
  put(join(home, '.claude.json'), `{"mcpServers": {"x": "${SECRET}"`);
  const r = addMcpEntry({ home, name: 'a', entry: { command: 'x' } });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'invalid JSON' });
});

test('addMcpEntry adds mcpServers when absent, keeps the file mode and refuses odd names', () => {
  const home = home0({ numStartups: 2 });
  const f = join(home, '.claude.json');
  chmodSync(f, 0o640);
  assert.deepEqual(addMcpEntry({ home, name: 'new-srv', entry: { type: 'http', url: 'https://example.test/mcp' } }), { ok: true });
  assert.deepEqual(json(f), { numStartups: 2, mcpServers: { 'new-srv': { type: 'http', url: 'https://example.test/mcp' } } });
  assert.equal(statSync(f).mode & 0o777, 0o640);
  for (const name of ['__proto__', 'constructor', '', '-x', 'a b', 'a/b', null]) {
    assert.deepEqual(addMcpEntry({ home, name, entry: { command: 'x' } }), { ok: false, error: 'failed', detail: 'bad request' }, String(name));
  }
  assert.deepEqual(addMcpEntry({ home, name: 'ok', entry: null }), { ok: false, error: 'failed', detail: 'bad request' });
  assert.deepEqual(Object.keys(json(f).mcpServers), ['new-srv']);
});

test('mcp-cli runs its steps', async () => {
  const home = home0();
  const plan = planInstall({ kind: 'mcp', name: 'io.example/plain-srv', registry: { remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }] } });
  assert.equal(plan.kind, 'mcp-cli');
  const calls = [];
  assert.deepEqual(await runInstall({ home, plan, env: {}, run: fakeRun(calls) }), { ok: true, route: 'cli' });
  assert.deepEqual(calls, [['claude', ...plan.steps[0].args]]);
});

test('cli errors become fixed codes', async () => {
  const home = home0();
  const plan = planInstall({ kind: 'mcp', name: 'io.example/plain-srv', registry: { remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }] } });
  const leak = `error: token ${SECRET} at /Users/someone/x`;
  let r = await runInstall({ home, plan, env: {}, run: fakeRun([], () => ({ code: 1, stdout: leak, stderr: leak })) });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'cli' });
  r = await runInstall({ home, plan, env: {}, run: async () => { throw new Error(leak); } });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'cli' });
  // plugin with no fallback source: the same fixed code
  const pp = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market' }, { installed: { marketplaces: new Set(['market']) } });
  r = await runInstall({ home, plan: pp, run: fakeRun([], () => ({ code: 1, stderr: leak })) });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'cli' });
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('plugin installs through the marketplace', async () => {
  const home = home0();
  const plan = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', repo: 'someone/market-repo' });
  const calls = [];
  assert.deepEqual(await runInstall({ home, plan, run: fakeRun(calls) }), { ok: true, route: 'marketplace' });
  assert.deepEqual(calls, [['claude', 'plugin', 'marketplace', 'add', 'someone/market-repo'], ['claude', 'plugin', 'install', 'demo@market']]);
});

test('plugin falls back to a local marketplace', async () => {
  const home = home0();
  const plan = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', repo: 'someone/market-repo' });
  const calls = [];
  const run = fakeRun(calls, (cmd, args) => {
    if (cmd === 'git') { // the clone: make the temp folder with a marketplace manifest
      const dest = args[args.length - 1];
      put(join(dest, '.claude-plugin', 'marketplace.json'), { name: 'market', plugins: [{ name: 'demo', source: './demo' }] });
      return { code: 0 };
    }
    if (args[1] === 'marketplace' && args[3] === 'someone/market-repo') return { code: 1, stderr: 'boom' }; // the remote add fails
    return { code: 0 };
  });
  const r = await runInstall({ home, plan, run });
  assert.deepEqual(r, { ok: true, route: 'local' });
  const dir = join(home, '.roca', 'shop', 'someone__market-repo');
  assert.ok(existsSync(join(dir, '.claude-plugin', 'marketplace.json')));
  assert.deepEqual(calls.map(c => c[0] === 'git' ? 'git' : c.join(' ')), [
    'claude plugin marketplace add someone/market-repo',
    'git',
    `claude plugin marketplace add ${dir}`,
    'claude plugin install demo@market',
  ]);
  // the fallback fails too → fixed code, nothing more
  const calls2 = [];
  const r2 = await runInstall({ home, plan, run: fakeRun(calls2, cmd => (cmd === 'git' ? { code: 128 } : { code: 1 })) });
  assert.deepEqual(r2, { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls2.map(c => c[0]), ['claude', 'git']);
});

test('plugin fallback only for an unknown marketplace with the same name', async () => {
  const home = home0();
  const failInstall = calls => fakeRun(calls, (cmd, args) => {
    if (cmd === 'git') { put(join(args[args.length - 1], '.claude-plugin', 'marketplace.json'), { name: 'other-market', plugins: [] }); return { code: 0 }; }
    return { code: 1 };
  });
  // the marketplace is known (no add step): no clone, the failure stands
  const known = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market' }, { installed: { marketplaces: new Set(['market']) } });
  let calls = [];
  assert.deepEqual(await runInstall({ home, plan: known, run: failInstall(calls), choice: { link: 'https://github.com/other/mk' } }), { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls, [['claude', 'plugin', 'install', 'demo@market']]);
  // the clone's marketplace.json has another name: nothing is added
  const plan = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', repo: 'someone/market-repo' });
  calls = [];
  assert.deepEqual(await runInstall({ home, plan, run: failInstall(calls) }), { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls.map(c => c[0] === 'git' ? 'git' : c.slice(1, 3).join(' ')), ['plugin marketplace', 'git']);
});

test('plugin fallback runs only when the marketplace add step failed, not when only the install failed', async () => {
  const home = home0();
  const plan = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', repo: 'someone/market-repo' });
  const calls = [];
  const run = fakeRun(calls, (cmd, args) => {
    if (cmd === 'git') { put(join(args[args.length - 1], '.claude-plugin', 'marketplace.json'), { name: 'market', plugins: [] }); return { code: 0 }; }
    return { code: args[1] === 'install' ? 1 : 0 };
  });
  assert.deepEqual(await runInstall({ home, plan, run }), { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls.map(c => c.slice(0, 3).join(' ')), ['claude plugin marketplace', 'claude plugin install']);
});

test('a local-path marketplace installs from inside ~/.roca/shop only, with no clone fallback', async () => {
  const home = home0();
  const dir = join(home, '.roca', 'shop', 'acme__kit', 'sub');
  mkdirSync(dir, { recursive: true });
  const plan = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', marketplaceSource: 'acme/kit', marketplacePath: dir });
  assert.deepEqual(plan.show, [`claude plugin marketplace add ${dir}`, 'claude plugin install demo@market']);
  let calls = [];
  assert.deepEqual(await runInstall({ home, plan, run: fakeRun(calls) }), { ok: true, route: 'local' });
  assert.deepEqual(calls, [['claude', 'plugin', 'marketplace', 'add', dir], ['claude', 'plugin', 'install', 'demo@market']]);
  // add fails: no clone, a fixed code
  calls = [];
  assert.deepEqual(await runInstall({ home, plan, run: fakeRun(calls, () => ({ code: 1 })) }), { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls.map(c => c[0]), ['claude']);
  // outside ~/.roca/shop (also through a symlink, or the root itself): refused before anything runs
  const out = mkdtempSync(join(tmpdir(), 'shop-out-'));
  const link = join(home, '.roca', 'shop', 'sneaky');
  symlinkSync(out, link);
  for (const p of [out, link, join(home, '.roca', 'shop'), join(home, '.roca', 'shop', 'nope')]) {
    calls = [];
    const bad = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market', marketplacePath: p });
    assert.deepEqual(await runInstall({ home, plan: bad, run: fakeRun(calls) }), { ok: false, error: 'failed', detail: 'bad request' }, p);
    assert.equal(calls.length, 0);
  }
});

test('secret names with "-" or "." are filled (headers and env)', async () => {
  const home = home0();
  const item = { kind: 'mcp', name: 'io.example/hy-srv', registry: { remotes: [{ type: 'streamable-http', url: 'https://hy.example.test/mcp',
    headers: [{ name: 'X-API-Key', isRequired: true, isSecret: true }, { name: 'api.key', isSecret: true }] }] } };
  const plan = planInstall(item);
  assert.equal(plan.kind, 'mcp-write');
  assert.deepEqual(plan.needs, ['X-API-Key', 'api.key']);
  const r = await runInstall({ home, plan, env: { 'X-API-Key': SECRET, 'api.key': 'k2' }, run: fakeRun([]) });
  assert.deepEqual(r, { ok: true, route: 'config' });
  assert.deepEqual(json(join(home, '.claude.json')).mcpServers['hy-srv'].headers, { 'X-API-Key': SECRET, 'api.key': 'k2' });
  assert.ok(!readFileSync(join(home, '.claude.json'), 'utf8').includes('${'));
  // npm env names too
  const plan2 = { kind: 'mcp-write', show: ['~/.claude.json mcpServers.env-srv'], needs: ['MY-TOKEN'], entry: { command: 'npx', args: ['-y', 'x'], env: { 'MY-TOKEN': '${MY-TOKEN}' } } };
  assert.deepEqual(await runInstall({ home, plan: plan2, env: { 'MY-TOKEN': 'v' }, run: fakeRun([]) }), { ok: true, route: 'config' });
  assert.deepEqual(json(join(home, '.claude.json')).mcpServers['env-srv'].env, { 'MY-TOKEN': 'v' });
});

test('a needed placeholder left after filling is refused', async () => {
  const home = home0();
  const before = readFileSync(join(home, '.claude.json'), 'utf8');
  // "{" / "}" in a name: the pattern cannot match "${a}b}", so it would be written literally
  const plan = { kind: 'mcp-write', show: ['~/.claude.json mcpServers.left-srv'], needs: ['a}b'], entry: { type: 'http', url: 'https://l.example.test', headers: { H: '${a}b}' } } };
  assert.deepEqual(await runInstall({ home, plan, env: { 'a}b': SECRET }, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'bad request' });
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before);
});

test('plugin ref must be exactly name@marketplace', async () => {
  const home = home0();
  const calls = [];
  for (const ref of ['demo', 'demo@a@b', '@market', 'demo@', '-x@m']) {
    const plan = { kind: 'plugin', show: [], needs: [], steps: [{ cmd: 'claude', args: ['plugin', 'install', ref] }] };
    assert.deepEqual(await runInstall({ home, plan, run: fakeRun(calls) }), { ok: false, error: 'failed', detail: 'bad request' }, ref);
  }
  assert.equal(calls.length, 0);
});

// a skill folder inside a link clone (~/.roca/shop/<owner>__<repo>/...)
let srcN = 0;
function skillSrc(home, name = 'demo-skill', folder = 'demo-folder', md) {
  const src = join(home, '.roca', 'shop', `own-repo${++srcN}`, 'skills', folder);
  put(join(src, 'SKILL.md'), md ?? `---\nname: ${name}\ndescription: Demo.\n---\nbody\n`);
  put(join(src, 'ref', 'notes.md'), 'notes\n');
  return src;
}
const SKILL = { kind: 'skill', show: [], needs: [] };

test('skill copies into ~/.claude/skills under its SKILL.md name', async () => {
  const home = home0();
  const src = skillSrc(home);
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: src } }), { ok: true, route: 'claude' });
  assert.equal(readFileSync(join(home, '.claude/skills/demo-skill/ref/notes.md'), 'utf8'), 'notes\n');
  assert.ok(existsSync(join(home, '.claude/skills/demo-skill/SKILL.md')));
  assert.ok(existsSync(src)); // the source stays
  // no SKILL.md, or no path → refused
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: join(src, 'ref') } }), { ok: false, error: 'failed', detail: 'missing' });
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: {} }), { ok: false, error: 'failed', detail: 'bad request' });
});

test('skill source must be inside ~/.roca/shop', async () => {
  const home = home0();
  const outside = join(mkdtempSync(join(tmpdir(), 'shop-src-')), 'out-skill');
  put(join(outside, 'SKILL.md'), '---\nname: out-skill\n---\n');
  put(join(home, 'elsewhere', 'x-skill', 'SKILL.md'), '---\nname: x-skill\n---\n');
  mkdirSync(join(home, '.roca', 'shop'), { recursive: true });
  symlinkSync(outside, join(home, '.roca', 'shop', 'linked'));
  for (const path of [outside, join(home, 'elsewhere', 'x-skill'), join(home, '.roca', 'shop'), join(home, '.roca', 'shop', 'linked'), join(home, '.roca', 'shop', '..', '..', 'elsewhere', 'x-skill')]) {
    assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path } }), { ok: false, error: 'failed', detail: 'bad request' }, path);
  }
  assert.ok(!existsSync(join(home, '.claude', 'skills')));
});

test('skill copy refuses an existing folder', async () => {
  const home = home0();
  put(join(home, '.claude/skills/demo-skill/SKILL.md'), 'mine\n');
  const r = await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home) } });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(readFileSync(join(home, '.claude/skills/demo-skill/SKILL.md'), 'utf8'), 'mine\n');
  assert.deepEqual(readdirSync(join(home, '.claude/skills')), ['demo-skill']);
  // all agents: an existing ~/.claude/skills/<name> also refuses, and nothing is left in ~/.agents
  const r2 = await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home), allAgents: true } });
  assert.deepEqual(r2, { ok: false, error: 'failed', detail: 'exists' });
  assert.ok(!existsSync(join(home, '.agents/skills/demo-skill')));
});

test('a turned-off skill of the same name refuses too', async () => {
  for (const where of ['.claude/skills-disabled', '.agents/skills-disabled', '.agents/skills']) {
    for (const allAgents of [false, true]) {
      const home = home0();
      put(join(home, where, 'demo-skill', 'SKILL.md'), 'mine\n');
      assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home), allAgents } }), { ok: false, error: 'failed', detail: 'exists' }, where);
      assert.ok(!existsSync(join(home, '.claude/skills/demo-skill')));
    }
  }
});

test('all agents skill gets a symlink', async () => {
  const home = home0();
  const r = await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home, 'shared-skill'), allAgents: true } });
  assert.deepEqual(r, { ok: true, route: 'agents' });
  const target = join(home, '.agents/skills/shared-skill');
  const link = join(home, '.claude/skills/shared-skill');
  assert.ok(statSync(target).isDirectory() && !lstatSync(target).isSymbolicLink());
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(target));
  assert.equal(readlinkSync(link), target);
  assert.equal(readFileSync(join(link, 'ref/notes.md'), 'utf8'), 'notes\n');
});

test('skill name falls back to the folder name and must be safe', async () => {
  const home = home0();
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home, '', 'plain-folder', 'no front matter\n') } }), { ok: true, route: 'claude' });
  assert.ok(existsSync(join(home, '.claude/skills/plain-folder/SKILL.md')));
  // an unsafe `name:` falls back to the folder name
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home, '../escape', 'good-folder') } }), { ok: true, route: 'claude' });
  assert.ok(existsSync(join(home, '.claude/skills/good-folder/SKILL.md')));
  assert.ok(!existsSync(join(home, '.claude/escape')));
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home, 'a b', 'next-folder') } }), { ok: true, route: 'claude' });
  assert.ok(existsSync(join(home, '.claude/skills/next-folder')));
  // neither is safe → refused
  assert.deepEqual(await runInstall({ home, plan: SKILL, choice: { path: skillSrc(home, '../escape', 'bad..folder') } }), { ok: false, error: 'failed', detail: 'bad request' });
});

test('installed, manual and unknown plans run nothing', async () => {
  const home = home0();
  const calls = [];
  const run = fakeRun(calls);
  assert.deepEqual(await runInstall({ home, plan: { kind: 'installed', show: [], needs: [] }, run }), { ok: false, error: 'failed', detail: 'exists' });
  assert.deepEqual(await runInstall({ home, plan: { kind: 'manual', show: ['npx x'], needs: [] }, run }), { ok: false, error: 'unsupported', detail: 'manual' });
  assert.deepEqual(await runInstall({ home, plan: { kind: 'weird' }, run }), { ok: false, error: 'unsupported', detail: 'kind' });
  assert.deepEqual(await runInstall({ home, plan: null, run }), { ok: false, error: 'failed', detail: 'bad request' });
  // steps that are not `claude` are never run
  assert.deepEqual(await runInstall({ home, plan: { kind: 'mcp-cli', show: [], needs: [], steps: [{ cmd: 'sh', args: ['-c', 'x'] }] }, run }), { ok: false, error: 'failed', detail: 'bad request' });
  assert.equal(calls.length, 0);
});

test('config route refuses any $ outside env / headers, even with no typed value in it', async () => {
  const before = { numStartups: 1, mcpServers: { 'keep-srv': { command: 'a' } } };
  for (const entry of [{ type: 'http', url: 'https://evil.example.test/?t=${GITHUB_TOKEN}', headers: { X: '${X}' } }, { command: 'npx', args: ['-y', 'd', '${HOME}'], env: { X: '${X}' } }]) {
    const home = home0(before);
    const plan = { kind: 'mcp-write', show: ['~/.claude.json mcpServers.evil-srv'], needs: ['X'], entry };
    assert.deepEqual(await runInstall({ home, plan, env: { X: 'v' }, run: fakeRun([]) }), { ok: false, error: 'failed', detail: 'bad request' });
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')), before);
  }
});
