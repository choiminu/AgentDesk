// widget.html OFFICE_FX ↔ assets/pixel/fx/*.png: the table scripts/office-fx.mjs prints must match the baked sheets,
// or the office draws the wrong cells (or nothing). Also pins the hooks that play them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
const FX = JSON.parse(html.match(/^const OFFICE_FX = (\{.*\});$/m)[1]);
const pngSize = file => { const b = readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('office fx: every sheet exists and its size matches the table', () => {
  assert.deepEqual(Object.keys(FX).sort(), ['act_agents', 'act_code', 'act_docs', 'act_mcp', 'act_read', 'act_shell', 'act_skill', 'act_think', 'act_web', 'blinkIn', 'blinkOut', 'boss', 'bossDown', 'clash', 'coffee', 'collect', 'exclaim', 'jobHats', 'rackA', 'rackB', 'revive', 'skillCast', 'skillCastDock', 'skyDay', 'skyDusk', 'skyNight', 'sleep', 'steam', 'sweat']);
  for (const [key, f] of Object.entries(FX)) {
    const file = new URL(`../assets/pixel/${f.src}.png`, import.meta.url);
    assert.ok(existsSync(file), `${key}: ${f.src}.png missing`);
    assert.deepEqual(pngSize(file), [f.cols * f.w, Math.ceil(f.n / f.cols) * f.h], `${key}: sheet size`);
    assert.ok(f.px >= 0 && f.px <= f.w && f.py >= 0 && f.py <= f.h, `${key}: pivot inside the frame`);
  }
  for (const k of ['sleep', 'steam', 'rackA', 'rackB', 'skyDay', 'skyDusk', 'skyNight']) assert.equal(FX[k].loop, true, `${k} loops`);
  for (const k of ['act_code', 'act_docs', 'act_read', 'act_web', 'act_shell', 'act_agents', 'act_think', 'act_skill', 'act_mcp']) assert.deepEqual([FX[k].loop, FX[k].w, FX[k].h, FX[k].px, FX[k].py], [true, 56, 56, 28, 38], `${k}: a loop the size of a dock tile, feet on the sprite's`);
  for (const k of ['collect', 'blinkIn', 'blinkOut', 'exclaim', 'skillCast', 'bossDown', 'clash', 'revive']) assert.equal(FX[k].loop, false, `${k} is a one-shot`);
  for (const k of ['boss', 'sweat', 'coffee']) assert.deepEqual([FX[k].loop, FX[k].w, FX[k].py], [true, 56, 38], `${k}: a dock tile loop`);
  assert.deepEqual([FX.jobHats.w, FX.jobHats.h, FX.jobHats.n, FX.jobHats.cols], [16, 8, 8, 2], 'eight 16 x 8 hats, two per row (dockPlaySync picks the frame)');
});

test('office fx: wired to finish, question, arrival, departure, rest and error', () => {
  assert.match(html, /officeBeep\('done'\); officeFxPlay\('collect'/);
  assert.match(html, /officeBeep\('ask'\); officeFxPlay\('exclaim', \.\.\.officeFeet\(ch\), ch\)/);
  assert.match(html, /if \(now - officeStartedAt > 1500\) officeFxPlay\('blinkIn'/);
  assert.match(html, /officeFxPlay\('blinkOut'/);
  assert.match(html, /officeDrawSleep\(ctx, ch\.sid/);
  assert.match(html, /st === 'error' && ch\.alpha >= 1\) officeDrawGlitch\(/);
  // one-shots raise the frame rate while they play; the sleep loop does not (it reads fine at 10 fps)
  assert.match(html, /\|\| officeFx\.length > 0 \|\|/);
  assert.doesNotMatch(html, /officeBurst|officeParticles|drawBubble\(ctx, [^;]*'zz'\)/);
});

test('office fx: ambient loops on the windows, coffee cups and rack cabinets', () => {
  assert.match(html, /officeFxDraw\(ctx, night \? 'skyNight' : dusk \? 'skyDusk' : 'skyDay'/);
  assert.match(html, /officeFxDraw\(ctx, 'steam'/);
  assert.match(html, /officeFxDraw\(ctx, key === 'k_rack_a' \? 'rackA' : 'rackB'/);
});

test('dock fx: finish sparkle, arrival blink, zzz and the error glitch, all behind the dock animation setting', () => {
  assert.match(html, /const dockFxAllowed = \(\) => dockAnimAllowed\(\);/);
  assert.match(html, /c\.from === 'run' && \(c\.to === 'input' \|\| c\.to === 'done'\)\) dockFxPlay\(c\.key, 'collect'\)/);
  assert.match(html, /if \(dockFxPrimed\) dockFxPlay\(k, 'blinkIn'\)/);
  // a redraw of the tiles (a minute label, a new tile) puts a one-shot back where it was, not from the start
  assert.match(html, /if \(!b\.querySelector\(`\.dock-fx\[data-t0="\$\{e\.t0\}"\]`\)\) dockFxEl\(b, e\.kind, false, e\.t0\)/);   // not for the tiles already there on the first draw
  assert.match(html, /dockFxEl\(b, 'sleep', true\)/);
  assert.match(html, /\.dock-tiles\.fx \.dock-tile\.st-err \.dock-spr \{ animation: dockGlitch/);
  assert.match(html, /prefers-reduced-motion: no-preference\) \{\n\s+\.dock-tiles\.fx/);
  assert.match(html, /dockFxSync\(changes\);/);
});

test('dock activity loops: the tool a working session uses picks its loop (dockActKind), redrawn when it changes', async () => {
  const vm = await import('node:vm');
  const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(readFileSync(new URL('../core/play.js', import.meta.url), 'utf8') + '\n' + html.match(/^function dockActKind\(s\) \{.*\}$/m)[0] + '\nglobalThis.k = dockActKind;', sb);
  const k = (tool, toolInput = '') => sb.k({ tool, toolInput });
  assert.equal(k('Edit', 'src/app.ts'), 'act_code');
  assert.equal(k('Write', 'docs/guide.md'), 'act_docs', 'edits to docs files');
  assert.equal(k('MultiEdit', 'README.md'), 'act_docs');
  assert.equal(k('Grep', 'auth'), 'act_read');
  assert.equal(k('Read', 'src/a.ts'), 'act_read');
  assert.equal(k('WebSearch'), 'act_web');
  assert.equal(k('Bash', 'npm test'), 'act_shell');
  assert.equal(k('Task'), 'act_agents');
  assert.equal(k(null), 'act_think', 'working with no tool: thinking');
  assert.equal(k('mcp__slack__send'), 'act_mcp', 'an MCP tool');
  assert.equal(k('Skill', 'pixelfx'), 'act_skill', 'a skill');
  assert.equal(k('TodoWrite'), 'act_think');
  assert.equal(sb.k(null), '');
  const sync = cut('function dockFxSync(changes) {', '\n}\n');
  assert.match(sync, /const want = rp \|\| \(b\.classList\.contains\('st-run'\) \? dockActKind\(dockLocal\(dockTileOf\(k\)\)\) : ''\), cur = b\.querySelector\('\.dock-fx\[data-fx\^="act_"\]'\);/);
  assert.match(sync, /if \(cur && cur\.dataset\.fx !== want\) cur\.remove\(\);/);
  assert.match(sync, /if \(want && \(!cur \|\| cur\.dataset\.fx !== want\)\) dockFxEl\(b, want, true\);/);
  const bake = readFileSync(new URL('../scripts/office-fx.mjs', import.meta.url), 'utf8');
  for (const kind of ['code', 'docs', 'read', 'web', 'shell', 'agents', 'think', 'skill', 'mcp']) assert.match(bake, new RegExp(`key: "act_${kind}", id: "office/activity", file: "act-${kind}", options: \\{ kind: "${kind}" \\}`));
});

// the town look (scripts/office-town.mjs): every file the widget swaps in exists, with the size of the sheet it replaces
test('office town look: each swapped file exists at the size of its classic sheet', () => {
  const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');
  const m = /const OFFICE_TOWN = new Set\(\[([^\]]+)\]\)/.exec(html);
  assert.ok(m, 'OFFICE_TOWN list');
  const names = m[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.ok(names.length >= 26);
  const size = u => { const b = readFileSync(u); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const n of names) assert.deepEqual(size(new URL(`../assets/pixel/town/${n}.png`, import.meta.url)), size(new URL(`../assets/pixel/${n}.png`, import.meta.url)), n);
  for (let i = 0; i < 12; i++) assert.match(html, new RegExp(`\\.look-town \\.dock-spr\\.k${i} \\{ background-image: url\\('assets/pixel/town/char_${i}\\.png'\\)`));
});
