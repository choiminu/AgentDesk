// pixel icons in place of the colour emoji: scripts/pixel-icons.mjs grids are well formed and the widget carries what
// the script generates; the widget swaps text emoji only where an image can go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../scripts/pixel-icons.mjs';

const html = readFileSync(new URL('../widget.html', import.meta.url), 'utf8');

test('pixel icons: every grid is 12 x 12 in the palette, every emoji has an icon', () => {
  assert.deepEqual(P.check(), []);
  assert.ok(Object.keys(P.ICONS).length >= 50);
  for (const e of ['⚙', '📖', '🗡', '🏪', '🔑', '💤', '🎫', '🛡', '⚠', '✉']) assert.ok(P.EMOJI[e], e);
  // terminal glyphs the status parser reads and typographic marks are never swapped
  for (const e of ['❯', '⏺', '✻', '✕', '✓', '★', '⇧']) assert.equal(P.EMOJI[e], undefined, e);
});

test('pixel icons: the widget holds exactly what the script generates (run node scripts/pixel-icons.mjs after editing)', () => {
  const css = html.slice(html.indexOf('/* pxi:css:start */') + '/* pxi:css:start */'.length, html.indexOf('  /* pxi:css:end */')).trim();
  assert.equal(css, P.css().trim());
  const map = html.slice(html.indexOf('// pxi:map:start') + '// pxi:map:start'.length, html.indexOf('// pxi:map:end')).trim();
  assert.equal(map, `const PXI_EMOJI = ${JSON.stringify(P.EMOJI)};`);
});

test('pixel icons: swapped only in drawn text, never in fields, options or terminal / chat screens; the dock is included', () => {
  const skip = /const PXI_SKIP = '([^']+)';/.exec(html)[1];
  for (const s of ['textarea', 'input', 'select', 'option', '[contenteditable]', '.pt-screen', '.chat-screen', 'pre']) assert.ok(skip.split(', ').includes(s), s);
  assert.ok(!skip.includes('data-verbatim'), 'the dock (#page-dock carries data-verbatim for the translator) gets its icons');
  assert.match(html, /<div class="page" id="page-dock" data-verbatim>/);
  assert.match(html, /new MutationObserver\(ms => \{[^\n]*characterData[^\n]*pxiText\(m\.target\)[^\n]*pxiDecorate\(n\)/);
  assert.match(html, /\.observe\(document\.body, \{ childList: true, subtree: true, characterData: true \}\);/);
  assert.match(html, /i\.className = `pxi pxi-\$\{PXI_EMOJI\[m\[1\]\]\}`; i\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(html, /\.pxi \{ display: inline-block; width: 1\.15em; height: 1\.15em;[^}]*image-rendering: pixelated;/);
});
