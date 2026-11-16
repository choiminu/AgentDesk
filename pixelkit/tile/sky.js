// The sky outside: bands of color that repeat left to right, clouds to float over them, a far skyline.

import { Canvas } from "../core/canvas.js";
import { hex, tint, RAMP, WHITE } from "../core/color.js";
import { Rng } from "../core/math.js";

/**
 * A sky strip that repeats left to right. kind: "sky" (day) | "dusk" | "night"; opts: { w (a multiple of 4),
 * h, seed (where the night's stars are) }.
 */
export function sky(kind = "sky", { w = 32, h = 64, seed = 1 } = {}) {
  const r = RAMP[kind];
  if (!r || !["sky", "dusk", "night"].includes(kind)) throw new Error(`tile: unknown sky "${kind}"`);
  if (w % 4) throw new Error("tile: a sky's width must be a multiple of 4, or its dither will not repeat");
  const g = new Canvas(w, h).bands(0, 0, w, h, r, { soft: 3 });
  if (kind === "night") {
    const rng = new Rng(seed * 2654435761), star = hex("#fff6c9"), dim = hex("#aab4e8");
    for (let n = 0; n < Math.round((w * h) / 170); n++) {
      const x = rng.int(1, w - 2), y = rng.int(1, Math.floor(h * 0.7));
      if (rng.chance(0.3)) { g.hline(y, x - 1, x + 1, star); g.vline(x, y - 1, y + 1, star); }   // a bright one is a small cross
      else g.set(x, y, dim);
    }
  }
  return g;
}

/** A cloud on transparency: round puffs on a flat base. opts: { w (12..48), seed }. */
export function cloud({ w = 28, seed = 1 } = {}) {
  const rng = new Rng(seed * 40503 + w), h = Math.max(8, Math.round(w * 0.42)), g = new Canvas(w, h);
  const base = h - 1, puffs = Math.max(2, Math.round(w / 8));
  for (let i = 0; i < puffs; i++) {
    const u = puffs === 1 ? 0.5 : i / (puffs - 1), mid = 1 - Math.abs(u - 0.5) * 2;
    const r = Math.max(2.5, (h * 0.28 + h * 0.3 * mid) * rng.range(0.85, 1.05)), cx = Math.round(r + u * (w - 1 - 2 * r));
    g.circle(cx, Math.round(base - r), r, WHITE);
  }
  for (let x = 0; x < w; x++) for (let y = base; y >= 0; y--) if (!g.get(x, y) && g.get(x, y - 1) && y > base - 3) g.set(x, y, WHITE);   // fill under the puffs
  g.rect(2, base - 1, w - 4, 2, WHITE);
  const shadeC = hex("#d5e6f7");
  for (let x = 0; x < w; x++) { let y = h - 1; while (y >= 0 && !g.get(x, y)) y--; if (y >= 0) g.set(x, y, shadeC); }   // the underside
  for (let x = 3; x < w - 3; x++) if ((x & 3) < 2) g.set(x, base - 1, shadeC);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)   // a shaded pixel with no shaded neighbour would be a speck
    if (g.get(x, y) === shadeC && ![-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && g.get(x + dx, y + dy) === shadeC))) g.set(x, y, WHITE);
  return g;
}

/**
 * A far skyline on transparency that repeats left to right: two rows of pale blocks, the nearer one lower.
 * No windows: at this distance they would be lone pixels.
 * opts: { w, h, seed, color (the nearer row) }.
 */
export function skyline({ w = 64, h = 24, seed = 1, color = "#aebfe2" } = {}) {
  const g = new Canvas(w, h), near = hex(color), far = tint(near, 0.45), rng = new Rng(seed * 69069 + w);
  const row = (c, lo, hi, minW, maxW) => {
    let x = 0;
    while (x < w) {
      const bw = Math.min(w - x, rng.int(minW, maxW)), bh = rng.int(lo, hi);
      g.rect(x, h - bh, bw, bh, c);
      if (bw >= 5 && rng.chance(0.4)) g.rect(x + 1, h - bh - 2, bw - 3, 2, c);   // something on the roof
      x += bw;
    }
  };
  row(far, Math.round(h * 0.55), h - 3, 5, 9);
  row(near, Math.round(h * 0.25), Math.round(h * 0.6), 6, 11);
  return g;
}
