#!/usr/bin/env node
// Demo data for README screenshots (widget.html DEMO_MODE): a Skillbook payload made by the real scan and payload code
// from a fake home folder (made-up skills, plugins and MCP servers; nothing from this PC), written between the
// "demo:skillbook" markers in widget.html. Run `node scripts/demo-data.mjs` after changing the scan or payload shape.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanInventory } from '../skillbook/scan.mjs';
import { skillbookPayload } from '../skillbook/payload.mjs';
import { createUsageStore } from '../skillbook/usage.mjs';

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);   // a fixed clock: the same file every run
const home = mkdtempSync(join(tmpdir(), 'agentdesk-demo-home-'));
const put = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const SKILLS = [
  ['deploy-checklist', 'Walk through a release: build, migrations, feature flags and rollback. Use when the user says "ship it" or "deploy to prod".'],
  ['code-review', 'Review a diff for bugs, risky changes and missing tests. Use for "review this PR" or "check my changes".'],
  ['write-tests', 'Add focused unit tests for the code just changed, boundary values first. Use for "add tests" or "cover this".'],
  ['release-notes', 'Draft user-facing release notes from recent commits. Use for "release notes" or "changelog".'],
  ['api-design', 'Shape a REST endpoint: resources, status codes, errors, pagination. Use for "design an API".'],
  ['sql-explain', 'Read a slow query plan and suggest indexes. Use for "why is this query slow".'],
  ['incident-postmortem', 'Write a blameless postmortem: timeline, impact, causes, actions. Use for "postmortem".'],
  ['refactor-plan', 'Break a large refactor into safe, reviewable steps. Use for "plan this refactor".'],
  ['ui-polish', 'Tighten spacing, type and states of a UI component. Use for "make it feel better".'],
  ['docs-writer', 'Turn notes into a clear README section. Use for "write the docs".'],
];
for (const [n, d] of SKILLS) put(join(home, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\n\n# ${n}\n`);
const PLUGINS = [['frontend-kit', 'demo-market', ['component-gen', 'a11y-check']], ['data-tools', 'demo-market', ['csv-clean']]];
const installed = { version: 2, plugins: {} }, enabled = {};
for (const [p, m, skills] of PLUGINS) {
  const dir = join(home, '.claude', 'plugins', 'cache', m, p, '1.2.0');
  for (const s of skills) put(join(dir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: ${s.replace('-', ' ')} helper from ${p}.\n---\n`);
  installed.plugins[`${p}@${m}`] = [{ scope: 'user', installPath: dir, version: '1.2.0' }];
  enabled[`${p}@${m}`] = true;
}
put(join(home, '.claude', 'plugins', 'installed_plugins.json'), installed);
put(join(home, '.claude', 'settings.json'), { enabledPlugins: enabled });
put(join(home, '.claude.json'), { mcpServers: {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'demo' } },
  postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
  'error-tracker': { type: 'http', url: 'https://mcp.example.com/mcp' },
} });
put(join(home, '.codex', 'config.toml'), '# demo\n');   // the other agents' config files exist (empty): no "could not read" note
put(join(home, '.gemini', 'settings.json'), {});
const store = createUsageStore({ file: join(home, 'usage.json'), now: () => NOW });
const H = 3600e3, use = (key, kind, n, hoursAgo) => { for (let i = 0; i < n; i++) store.add({ key, kind, agent: 'claude', at: NOW - (hoursAgo + i * 5) * H, repo: 'web-app' }); };
use('code-review', 'skill', 14, 1); use('deploy-checklist', 'skill', 9, 3); use('write-tests', 'skill', 7, 2); use('github', 'mcp', 22, 1);
use('sql-explain', 'skill', 3, 20); use('release-notes', 'skill', 2, 30); use('postgres', 'mcp', 4, 6); use('frontend-kit:component-gen', 'skill', 5, 4);
const payload = skillbookPayload({ inventory: scanInventory({ home, repos: [] }), store, removed: [], now: NOW });
payload.backfill = 'done';
const json = JSON.stringify(payload).split(home).join('/Users/demo');
rmSync(home, { recursive: true, force: true });
const file = new URL('../widget.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const a = '// demo:skillbook:start', b = '// demo:skillbook:end', i = html.indexOf(a), j = html.indexOf(b);
if (i < 0 || j < i) throw new Error('demo:skillbook markers not found');
html = html.slice(0, i + a.length) + `\nconst DEMO_SKILLBOOK = ${json};\n` + html.slice(j);
writeFileSync(file, html);
console.log(`demo skillbook: ${payload.items.length} items → widget.html`);
