// Shop installs: shop/install.mjs and addMcpEntry over a temp home with a fake runner (made-up names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, realpathSync, statSync, chmodSync } from 'node:fs';
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

test('placeholders in headers and args are filled, other text is kept', async () => {
  const home = home0();
  const plan = {
    kind: 'mcp-write', show: ['~/.claude.json mcpServers.hdr-srv', '  API_KEY', '  PASS'], needs: ['API_KEY', 'PASS'],
    entry: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${API_KEY}', 'X-Other': '${NOT_NEEDED}' }, args: ['--pass=${PASS}'] },
  };
  // a value that itself looks like a placeholder is not expanded again
  const r = await runInstall({ home, plan, env: { API_KEY: 'k-${PASS}', PASS: 'p1' }, run: fakeRun([]) });
  assert.deepEqual(r, { ok: true, route: 'config' });
  assert.deepEqual(json(join(home, '.claude.json')).mcpServers['hdr-srv'], {
    type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer k-${PASS}', 'X-Other': '${NOT_NEEDED}' }, args: ['--pass=p1'],
  });
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
  let installs = 0;
  const run = fakeRun(calls, (cmd, args) => {
    if (cmd === 'git') { // the clone: make the temp folder with a marketplace manifest
      const dest = args[args.length - 1];
      put(join(dest, '.claude-plugin', 'marketplace.json'), { name: 'market', plugins: [{ name: 'demo', source: './demo' }] });
      return { code: 0 };
    }
    if (args[1] === 'install' && ++installs === 1) return { code: 1, stderr: 'boom' };
    return { code: 0 };
  });
  const r = await runInstall({ home, plan, run });
  assert.deepEqual(r, { ok: true, route: 'local' });
  const dir = join(home, '.roca', 'shop', 'someone-market-repo');
  assert.ok(existsSync(join(dir, '.claude-plugin', 'marketplace.json')));
  assert.deepEqual(calls.map(c => c[0] === 'git' ? 'git' : c.join(' ')), [
    'claude plugin marketplace add someone/market-repo',
    'claude plugin install demo@market',
    'git',
    `claude plugin marketplace add ${dir}`,
    'claude plugin install demo@market',
  ]);
  // the fallback fails too → fixed code, nothing more
  const calls2 = [];
  const r2 = await runInstall({ home, plan, run: fakeRun(calls2, cmd => (cmd === 'git' ? { code: 128 } : { code: 1 })) });
  assert.deepEqual(r2, { ok: false, error: 'failed', detail: 'cli' });
  assert.deepEqual(calls2.map(c => c[0]), ['claude', 'git']);
  // a link given by the caller (pasted link) is used for the clone when the plan has no add step
  const known = planInstall({ kind: 'plugin', name: 'demo', marketplace: 'market' }, { installed: { marketplaces: new Set(['market']) } });
  const calls3 = [];
  installs = 0;
  const r3 = await runInstall({ home, plan: known, run: fakeRun(calls3, (cmd, args) => {
    if (cmd === 'git') { put(join(args[args.length - 1], '.claude-plugin', 'marketplace.json'), { name: 'market', plugins: [] }); return { code: 0 }; }
    if (args[1] === 'install' && ++installs === 1) return { code: 1 };
    return { code: 0 };
  }), choice: { link: 'https://github.com/other/mk' } });
  assert.deepEqual(r3, { ok: true, route: 'local' });
  assert.ok(calls3.some(c => c[0] === 'git' && c.includes('https://github.com/other/mk.git')));
});

function skillSrc(name = 'demo-skill', folder = 'demo-folder') {
  const root = mkdtempSync(join(tmpdir(), 'shop-src-'));
  const src = join(root, folder);
  put(join(src, 'SKILL.md'), `---\nname: ${name}\ndescription: Demo.\n---\nbody\n`);
  put(join(src, 'ref', 'notes.md'), 'notes\n');
  return src;
}

test('skill copies into ~/.claude/skills under its SKILL.md name', async () => {
  const home = home0();
  const src = skillSrc();
  assert.deepEqual(await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: src } }), { ok: true, route: 'claude' });
  assert.equal(readFileSync(join(home, '.claude/skills/demo-skill/ref/notes.md'), 'utf8'), 'notes\n');
  assert.ok(existsSync(join(home, '.claude/skills/demo-skill/SKILL.md')));
  assert.ok(existsSync(src)); // the source stays
  // no SKILL.md, or a path that is not a folder → refused
  assert.deepEqual(await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: join(src, 'ref') } }), { ok: false, error: 'failed', detail: 'missing' });
  assert.deepEqual(await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: {} }), { ok: false, error: 'failed', detail: 'bad request' });
});

test('skill copy refuses an existing folder', async () => {
  const home = home0();
  put(join(home, '.claude/skills/demo-skill/SKILL.md'), 'mine\n');
  const r = await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: skillSrc() } });
  assert.deepEqual(r, { ok: false, error: 'failed', detail: 'exists' });
  assert.equal(readFileSync(join(home, '.claude/skills/demo-skill/SKILL.md'), 'utf8'), 'mine\n');
  assert.deepEqual(readdirSync(join(home, '.claude/skills')), ['demo-skill']);
  // all agents: an existing ~/.claude/skills/<name> also refuses, and nothing is left in ~/.agents
  const r2 = await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: skillSrc(), allAgents: true } });
  assert.deepEqual(r2, { ok: false, error: 'failed', detail: 'exists' });
  assert.ok(!existsSync(join(home, '.agents/skills/demo-skill')));
});

test('all agents skill gets a symlink', async () => {
  const home = home0();
  const r = await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: skillSrc('shared-skill'), allAgents: true } });
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
  const root = mkdtempSync(join(tmpdir(), 'shop-src-'));
  const src = join(root, 'plain-folder');
  put(join(src, 'SKILL.md'), 'no front matter\n');
  assert.deepEqual(await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: src } }), { ok: true, route: 'claude' });
  assert.ok(existsSync(join(home, '.claude/skills/plain-folder/SKILL.md')));
  const bad = skillSrc('../escape');
  assert.deepEqual(await runInstall({ home, plan: { kind: 'skill', show: [], needs: [] }, choice: { path: bad } }), { ok: false, error: 'failed', detail: 'bad request' });
  assert.ok(!existsSync(join(home, '.claude/escape')));
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
