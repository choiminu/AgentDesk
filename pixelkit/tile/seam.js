// Does a tile meet itself, or its neighbour, without a visible break?
//
// The measure: how much the picture changes across the boundary, against how much it changes between
// neighbouring columns (or rows) inside the tile. A boundary that changes more than anything inside does is a
// seam the eye will find. A joint between boards inside a floor tile is a big change too, so a tile is allowed
// to be as busy at its edge as it is anywhere else — but not busier.
//
// What it cannot see: a tile whose inside is as broken as its edge (hard stripes that restart at the wrap pass),
// and a single line that stops at the edge when lines also stop inside. Look at tiled() for those.

import { Canvas } from "../core/canvas.js";
import { distance } from "../core/color.js";

// The change between two columns (axis "x") or two rows ("y"), possibly of different canvases:
// { n: how many pixels differ, d: how far apart they are on average }.
function step(a, ia, b, ib, axis) {
  const len = axis === "x" ? a.h : a.w;
  let n = 0, sum = 0;
  for (let i = 0; i < len; i++) {
    const p = axis === "x" ? a.get(ia, i) : a.get(i, ia), q = axis === "x" ? b.get(ib, i) : b.get(i, ib);
    if (p !== q) { n++; sum += distance(p, q); }
  }
  return { n, d: sum / len };
}
// the biggest change between neighbours inside one canvas
function busiest(c, axis) {
  const len = axis === "x" ? c.w : c.h, max = { n: 0, d: 0 };
  for (let i = 0; i + 1 < len; i++) { const s = step(c, i, c, i + 1, axis); max.n = Math.max(max.n, s.n); max.d = Math.max(max.d, s.d); }
  return max;
}
const round = (v) => +v.toFixed(4);
// A seam passes when no more pixels change across it than across the busiest place inside, and the change is
// not much stronger either (twice as strong is where a line starts to show).
const verdict = (seam, inner) => ({
  seam: seam.n, inner: inner.n, contrast: round(seam.d), innerContrast: round(inner.d),
  ok: seam.n <= inner.n && seam.d <= inner.d * 2 + 0.004,
});

/**
 * Check a tile laid next to copies of itself. opts: { x: check left-right (default true), y: check up-down
 * (default true) }. Returns { ok, x?, y? } where each axis is { seam, inner, contrast, innerContrast,
 * ok }: pixels that change across the wrap, the most that change between neighbours inside, and how strong
 * those two changes are.
 */
export function seamReport(c, { x = true, y = true } = {}) {
  const out = { ok: true };
  if (x) out.x = verdict(step(c, c.w - 1, c, 0, "x"), busiest(c, "x"));
  if (y) out.y = verdict(step(c, c.h - 1, c, 0, "y"), busiest(c, "y"));
  out.ok = (out.x?.ok ?? true) && (out.y?.ok ?? true);
  return out;
}

/**
 * Check two different pieces placed side by side: b to the "right" of a, or "below" it. They must be the same
 * height (right) or width (below). Returns { seam, inner, ok }.
 */
export function joinReport(a, b, side = "right") {
  const axis = side === "right" ? "x" : "y";
  if (axis === "x" ? a.h !== b.h : a.w !== b.w) return { seam: 0, inner: 0, contrast: 0, innerContrast: 0, ok: false, why: "the two pieces are not the same size along the joint" };
  const seam = axis === "x" ? step(a, a.w - 1, b, 0, "x") : step(a, a.h - 1, b, 0, "y");
  const ia = busiest(a, axis), ib = busiest(b, axis);
  return verdict(seam, { n: Math.max(ia.n, ib.n), d: Math.max(ia.d, ib.d) });
}

/** The tile repeated nx by ny times: the picture to look at when judging a seam by eye. */
export function tiled(c, nx = 3, ny = 3) {
  const out = new Canvas(c.w * nx, c.h * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.paste(c, i * c.w, j * c.h);
  return out;
}
