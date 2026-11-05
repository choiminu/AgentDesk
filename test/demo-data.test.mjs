// README screenshots use demo data only: the demo Skillbook comes from a fake home (scripts/demo-data.mjs), the demo
// Jira board is made up, and neither reads this PC (no skill scan, no Jira call, no quest file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const fn = (name) => { const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return html.slice(i, html.indexOf('\n}\n', i)); };

test('demo Skillbook: generated, made-up names, no real home path', () => {
  const m = /^const DEMO_SKILLBOOK = (\{.*\});$/m.exec(html);
  assert.ok(m, 'node scripts/demo-data.mjs wrote it');
  const d = JSON.parse(m[1]);
  assert.equal(d.ok, true);
  assert.ok(d.items.some(i => i.name === 'code-review') && d.items.some(i => i.kind === 'mcp' && i.name === 'github'));
  const paths = [...m[1].matchAll(/\/Users\/[^/"]+/g)].map(x => x[0]);
  assert.deepEqual([...new Set(paths)], ['/Users/demo']);
  assert.ok(!/tmp|agentdesk-demo-home/.test(m[1]), 'the temp folder name is replaced');
});

test('demo mode reads nothing from this PC on the Skillbook, Jira and quest paths', () => {
  assert.match(fn('skillbookLoad'), /if \(DEMO_MODE\) r = DEMO_SKILLBOOK;[^\n]*\n\s*else try \{ r = await window\.orca\.skillbook\(\); \}/);
  const jl = fn('jiraLoad'), demo = jl.slice(jl.indexOf('if (DEMO_MODE) {'), jl.indexOf('return;', jl.indexOf('if (DEMO_MODE) {')));
  assert.ok(demo.length > 0 && !/window\.orca\./.test(demo), 'no IPC in the demo branch');
  assert.ok(jl.indexOf('if (DEMO_MODE) {') < jl.indexOf('await jiraOAuthRefresh()'), 'before any Jira call');
  assert.match(fn('questLoad'), /if \(!DEMO_MODE\) try \{ const f = await window\.orca\.questState\(\);/);
  assert.match(fn('demoJira'), /accountId: 'demo-me', displayName: 'Alex Kim'/);
});
