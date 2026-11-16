// Indoor walls, 16 wide and 32 tall, seen from the front: a moulding at the top, paint, a skirting board at the
// bottom. They repeat left to right. A window piece (32 x 32) sits in the same wall, so it joins a plain one.

import { Canvas } from "../core/canvas.js";
import { hex, shade, tint, RAMP, WHITE } from "../core/color.js";

const paint = (color) => hex(color);

function shell(g, x0, w, c) {
  const top = 2, base = 28;
  g.rect(x0, top, w, base - top, c);
  g.rect(x0, top, w, 3, shade(c, 0.1), (u, v) => 0.75 - v * 0.55);      // the ceiling's shadow, dithered away
  g.hline(0, x0, x0 + w - 1, WHITE); g.hline(1, x0, x0 + w - 1, hex("#e4dfd6"));   // moulding
  g.hline(base, x0, x0 + w - 1, WHITE); g.rect(x0, base + 1, w, 2, hex("#f3efe8")); g.hline(31, x0, x0 + w - 1, hex("#d9d2c6"));   // skirting
}

export const WALLS = {
  plain(g, c) { shell(g, 0, g.w, c); },
  // boards up to a rail at half height
  panel(g, c) {
    shell(g, 0, g.w, c);
    const d = shade(c, 0.1);
    g.rect(0, 17, g.w, 11, d);
    g.hline(15, 0, g.w - 1, WHITE); g.hline(16, 0, g.w - 1, hex("#e4dfd6"));
    for (let x = 3; x < g.w; x += 4) g.vline(x, 17, 27, shade(c, 0.2));
    for (let x = 0; x < g.w; x += 4) g.vline(x, 17, 27, tint(d, 0.25));
  },
  // pale bricks in a running bond
  brick(g, c) {
    shell(g, 0, g.w, c);
    const mortar = tint(c, 0.45), dark = shade(c, 0.09);
    for (let y = 5; y < 28; y += 4) {
      g.hline(y, 0, g.w - 1, mortar);
      const off = ((y - 5) / 4) % 2 ? 4 : 0;
      for (let x = off + 7; x < g.w + off; x += 8) g.vline(x % g.w, y + 1, Math.min(27, y + 3), mortar);
      for (let x = off + 2; x < g.w + off; x += 8) if (y + 3 < 28) for (let i = 0; i < 3; i++) g.set((x + i) % g.w, y + 3, dark);
    }
  },
};

/** A wall piece, 16 x 32. kind: a key of WALLS; opts: { color (hex) }. */
export function wall(kind = "plain", { color = "#f3e6cf" } = {}) {
  if (!WALLS[kind]) throw new Error(`tile: unknown wall "${kind}"`);
  const g = new Canvas(16, 32);
  WALLS[kind](g, paint(color));
  return g;
}

/** A plain wall with a window in it, 32 x 32. opts: { color, sky: a ramp name ("sky" | "dusk" | "night") }. */
export function wallWindow({ color = "#f3e6cf", sky = "sky" } = {}) {
  const g = new Canvas(32, 32), c = paint(color), r = RAMP[sky];
  if (!r) throw new Error(`tile: unknown sky "${sky}"`);
  shell(g, 0, 32, c);
  g.rect(5, 6, 22, 16, WHITE);                                   // frame
  g.bands(6, 7, 20, 14, r, { soft: 2 });                         // glass: the sky outside
  for (let i = 0; i < 5; i++) { g.set(9 + i, 12 - i, tint(r[3], 0.6)); g.set(10 + i, 12 - i, tint(r[3], 0.6)); }   // a glint
  g.vline(15, 7, 20, WHITE); g.vline(16, 7, 20, WHITE);          // the bar between the panes
  g.hline(22, 4, 27, WHITE); g.hline(23, 4, 27, hex("#d9d2c6")); // sill
  g.hline(24, 5, 26, shade(c, 0.1));
  return g;
}
