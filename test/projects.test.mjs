// core/projects.js — sessions grouped into projects (a project is a folder), in an order that stays put.
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../core/projects.js');
const P = globalThis.AgentDeskProjects;
const NOW = 1e12, s = (id, cwd, o = {}) => ({ id, cwd, status: 'running', time: NOW, ...o });
const names = g => g.projects.map(p => [p.name, p.kind, p.sessions.map(x => x.id)]);

test('paths: under by whole segments, parent, common parent', () => {
  assert.equal(P.norm('/a/b/'), '/a/b'); assert.equal(P.norm('relative'), ''); assert.equal(P.norm(null), '');
  assert.equal(P.under('/a/bc', '/a/b'), false, 'a prefix of a name is not a parent');
  assert.equal(P.under('/a/b/c', '/a/b'), true); assert.equal(P.under('/a/b', '/a/b'), true);
  assert.equal(P.parentOf('/a/b/c'), '/a/b'); assert.equal(P.parentOf('/a'), '');
  assert.equal(P.commonParent('/w/etc/roca', '/w/etc/office'), '/w/etc');
  assert.equal(P.commonParent('/x/a', '/y/b'), '');
});

test('group: a folder is a project, git or not; an Orca repository takes in its worktrees and sessions started beside them', () => {
  const g = P.group([
    s('o1', '/h/orca/workspaces/etc/roca', { orca: 'r1', repoName: 'etc' }),
    s('o2', '/h/orca/workspaces/etc/office-dev', { orca: 'r1', repoName: 'etc' }),
    s('own', '/h/orca/workspaces/etc/office-dev'),          // started by hand in the same worktree
    s('new', '/h/orca/workspaces/etc/scratch'),             // another folder beside the worktrees
    s('n1', '/h/notes'), s('n2', '/h/notes'),               // no git, no Orca: its own folder
    s('x', '/h/other/api'),
  ], {}, NOW);
  assert.deepEqual(g.projects.map(p => [p.name, p.kind]), [['api', 'folder'], ['etc', 'orca'], ['notes', 'folder']]);
  assert.deepEqual(g.projects[2].sessions.map(x => x.id), ['n1', 'n2']);
  assert.deepEqual(g.projects[1].sessions.map(x => x.id).sort(), ['new', 'o1', 'o2', 'own']);
  assert.deepEqual(g.projects[1].folders.length, 3);
  assert.deepEqual([g.projects[1].id, g.projects[1].path], ['orca:r1', '/h/orca/workspaces/etc'], 'the repository\'s folder is where its worktrees live');
});

test('group: the order stays — known projects keep their place, a new one goes last', () => {
  const a = [s('1', '/h/zeta'), s('2', '/h/alpha')];
  const g1 = P.group(a, {}, NOW);
  assert.deepEqual(g1.projects.map(p => p.name), ['alpha', 'zeta'], 'first sight: by name');
  const g2 = P.group([...a, s('3', '/h/beta', { needsInput: true })], { order: g1.order }, NOW);
  assert.deepEqual(g2.projects.map(p => p.name), ['alpha', 'zeta', 'beta'], 'an urgent new project does not jump the list');
  const g3 = P.group([s('1', '/h/zeta')], { order: g2.order }, NOW);
  assert.deepEqual(g3.projects.map(p => p.name), ['zeta']);
  assert.deepEqual(g3.order, g2.order, 'a project with no session now keeps its place for when it is back');
});

test('group: live and old sessions; within a project what needs me comes first', () => {
  const g = P.group([s('done', '/h/p', { status: 'done', time: NOW - 2 * P.OLD_MS }), s('kept', '/h/p', { status: 'done', time: NOW - 2 * P.OLD_MS, keep: true }),
    s('run', '/h/p'), s('ask', '/h/p', { status: 'waiting', needsInput: true })], {}, NOW);
  const p = g.projects[0];
  assert.deepEqual(p.live.map(x => x.id), ['ask', 'run', 'kept'], 'a session kept (an AgentDesk terminal) is never old');
  assert.deepEqual(p.old.map(x => x.id), ['done']);
});

test('widen / merge / unmake: user projects are folders; the deepest one wins; never the top of the disk', () => {
  const list = [s('a', '/h/work/api/src'), s('b', '/h/work/web'), s('c', '/h/play')];
  const g = P.group(list, {}, NOW), api = g.projects.find(p => p.name === 'src'), web = g.projects.find(p => p.name === 'web');
  let cfg = P.widen({ order: g.order }, api);
  assert.deepEqual(names(P.group(list, cfg, NOW)).map(x => x[0]), ['play', 'api', 'web'], 'the widened project keeps the old one\'s place');
  cfg = P.merge(cfg, { id: 'user:/h/work/api', path: '/h/work/api' }, web);
  const g2 = P.group(list, cfg, NOW);
  assert.deepEqual(names(g2), [['play', 'folder', ['c']], ['work', 'user', ['a', 'b']]]);
  assert.deepEqual(cfg.user.map(u => u.path), ['/h/work'], 'the wider project takes in the one inside it');
  assert.deepEqual(names(P.group(list, P.unmake(cfg, 'user:/h/work'), NOW)).map(x => x[0]).sort(), ['play', 'src', 'web']);
  assert.equal(P.widen({}, { id: 'folder:/h', path: '/h' }), null, 'not wider than a top-level folder');
  assert.equal(P.merge({}, { id: 'a', path: '/x/a' }, { id: 'b', path: '/y/b' }), null, 'nothing in common but the disk');
  assert.deepEqual(P.cleanCfg({ user: [{ path: '/' }, { path: '/Users' }, { path: 'rel' }, { path: '/a/b' }] }).user, [{ path: '/a/b' }]);
});

test('names, folding, reorder', () => {
  const list = [s('a', '/h/aa'), s('b', '/h/bb'), s('c', '/h/cc')];
  const g = P.group(list, { names: { 'folder:/h/bb': '  My B  ' }, folded: { 'folder:/h/cc': true } }, NOW);
  assert.deepEqual(g.projects.map(p => p.path), ['/h/aa', '/h/cc', '/h/bb'], 'ordered by the shown name: aa, cc, My B');
  assert.equal(g.projects.find(p => p.id === 'folder:/h/bb').name, 'My B');
  assert.equal(g.projects.find(p => p.id === 'folder:/h/cc').folded, true);
  const c = P.reorder({}, g.order, 'folder:/h/cc', 'folder:/h/aa');
  assert.deepEqual(P.group(list, c, NOW).projects.map(p => p.path), ['/h/cc', '/h/aa', '/h/bb']);
  assert.deepEqual(P.reorder({}, g.order, 'folder:/h/aa', null).order.slice(-1), ['folder:/h/aa'], 'no target: last');
});

test('nowList: questions first (oldest first), then sessions that just stopped for input', () => {
  const l = P.nowList([s('r', '/a'), s('w', '/a', { status: 'waiting', since: NOW - 60000 }), s('stale', '/a', { status: 'waiting', since: NOW - 2 * P.NOW_MS }),
    s('q2', '/a', { needsInput: true, askSince: NOW - 1000 }), s('q1', '/a', { needsInput: true, askSince: NOW - 9000 })], NOW);
  assert.deepEqual(l.map(x => x.id), ['q1', 'q2', 'w']);
});

test('worktrees AgentDesk makes: a name that is a folder and a branch; a session in one belongs to its repository\'s project', async () => {
  for (const n of ['feat-login', 'fix_1.2', 'a']) assert.equal(P.worktreeName(` ${n} `), n);
  for (const n of ['', '-x', '../up', 'a/b', 'a b', 'x..y', 'end.', 'x.lock', 'a;rm', 'ㅁ', 'x'.repeat(61), null]) assert.equal(P.worktreeName(n), '', String(n));
  const links = { '/h/agentdesk/worktrees/api/feat-login': '/h/code/api' };
  assert.equal(P.homeOf('/h/agentdesk/worktrees/api/feat-login/src', links), '/h/code/api');
  assert.equal(P.homeOf('/h/agentdesk/worktrees/api/feat-loginx', links), '');
  assert.equal(P.homeOf('/h/elsewhere', links), ''); assert.equal(P.homeOf('/h/x', null), '');
  const g = P.group([s('main', '/h/code/api'), s('wt', '/h/agentdesk/worktrees/api/feat-login', { home: '/h/code/api' })], {}, NOW);
  assert.deepEqual(g.projects.map(p => [p.name, p.sessions.map(x => x.id).sort(), p.folders.length]), [['api', ['main', 'wt'], 2]], 'one project, two folders');
  const { readFileSync } = await import('node:fs');
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), main = read('main.mjs'), git = read('diff/git.mjs'), html = read('widget.html');
  assert.match(main, /const name = AgentDeskProjects\.worktreeName\(req && req\.name\);\n\s+if \(!name\) return \{ ok: false, error: "invalid name" \};/, 'main checks the name itself');
  assert.match(main, /const path = join\(OWN_WT_DIR, basename\(root\)[^\n]*, name\);\n\s+if \(existsSync\(path\)\) return/, 'the worktree goes under AgentDesk\'s own folder, never over an existing one');
  assert.match(git, /\["worktree", "add", "-b", branch, "--", path\]/, 'the path is passed after --');
  assert.match(html, /home: AgentDeskProjects\.homeOf\(c\.cwd, otLinks\)/);
});

test('main: nothing at module top level reads ROCA_DIR before it is declared (the app would not start)', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8').split('\n');
  const decl = main.findIndex(l => /^const ROCA_DIR = /.test(l));
  assert.ok(decl > 0);
  const early = main.slice(0, decl).map((l, i) => [i + 1, l]).filter(([, l]) => /^(const|let|var) [^=]*= [^\n]*\bROCA_DIR\b/.test(l) && !/=>\s|function/.test(l));
  assert.deepEqual(early.map(([n]) => n), [], 'a top-level value above the declaration uses ROCA_DIR');
});
