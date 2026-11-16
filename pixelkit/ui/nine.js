// Nine-slice: a small source picture whose corners stay as they are while its edges and middle repeat, so one
// drawing makes a panel or a button of any size. The middle is repeated, not stretched: stretching a pixel
// pattern smears it.

import { Canvas } from "../core/canvas.js";

const sides = (inset) => (typeof inset === "number" ? { l: inset, t: inset, r: inset, b: inset } : { l: 0, t: 0, r: 0, b: 0, ...inset });

/**
 * Draw src at w x h. inset: how many pixels at each side are fixed — a number, or { l, t, r, b }.
 * Throws when the target is smaller than the fixed corners, or the source has no middle left to repeat.
 */
export function nineSlice(src, inset, w, h) {
  const { l, t, r, b } = sides(inset), mw = src.w - l - r, mh = src.h - t - b;
  if (mw < 1 || mh < 1) throw new Error("nineSlice: the insets leave no middle in the source");
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < l + r || h < t + b) throw new Error(`nineSlice: ${w} x ${h} is smaller than the corners (${l + r} x ${t + b})`);
  const out = new Canvas(w, h);
  const at = (p, size, lo, hi, srcSize, mid) => (p < lo ? p : p >= size - hi ? srcSize - (size - p) : lo + ((p - lo) % mid));
  for (let y = 0; y < h; y++) {
    const sy = at(y, h, t, b, src.h, mh);
    for (let x = 0; x < w; x++) out.data[y * w + x] = src.data[sy * src.w + at(x, w, l, r, src.w, mw)];
  }
  return out;
}
