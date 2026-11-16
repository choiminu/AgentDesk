# Notices

pixelkit is part of this repository and is covered by its MIT license (see `../LICENSE`).
Parts of it are adapted from other MIT-licensed work, listed here with their copyright notices.

## pixelfx

https://github.com/patch-gg/pixelfx — MIT License, Copyright (c) 2026 Patch, Copyright (c) 2026 Hugo Duprez.

Adapted from pixelfx:

| pixelkit file | from pixelfx | what was taken |
|---|---|---|
| `core/math.js` | `src/core/math.js` | `clamp`, `lerp`, `wrap`, `hash`, `rand`, the `Rng` class (mulberry32), `tileNoise` |
| `core/color.js` | `src/core/color.js` | the 32-bit color layout, `hex`, `toHex`, `mix`, `scale`, `luma`, `ramp`, `fit`, `at` |
| `core/canvas.js` | `src/core/painter.js` | the 4 x 4 ordered-dither thresholds and the dithered pixel write, the 1 px line, the string sprite, the outline-around-a-shape idea |
| `core/png.js` | `tools/lib/png.mjs` | `encodePNG` (the CRC table, chunk writer, Sub-filtered rows) |
| `tools/lib/sheet.mjs` | `tools/lib/fxlib.mjs` | the contact sheet: nearest-neighbour enlarging, a labelled grid of cells |
| `tools/check.mjs` | `tools/check.mjs` | the shape of the report (ok / warn / FAIL per item, exit code), the determinism and unseeded-randomness checks |
| `SKILL.md` | `skills/pixelfx/SKILL.md`, `docs/AUTHORING.md` | the method: say it in one line, find references, draft, render and look, fix the worst thing, check; the symptom-and-fix table format |

pixelfx credits its method to Hugo Duprez's article "How to make (good) pixel art effects with Claude"
(https://www.spritefusion.com/blog/how-to-make-good-pixel-art-effects-with-claude). No code from pixelfx's
`src/core/sim.js`, `src/core/act.js` or any effect file is used here.

Everything else is pixelkit's own: the `Canvas` shapes other than those listed, `shade` / `tint` and the office
palette, the label font, the PNG decoder, the character parts and poses, the tiles and the seam measure, nine-slice,
panels, buttons, icons, the catalog and the checks. The character proportions and the seven base poses follow this
repository's own `scripts/office-town.mjs`. No drawing is copied from, or traced over, another product's art.

```
MIT License

Copyright (c) 2026 Patch
Copyright (c) 2026 Hugo Duprez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
