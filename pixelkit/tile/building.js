// Outdoor building pieces, 16 px modules that stack: a facade, a window, a roof, an awning, a door (16 x 32).
// Every piece keeps the facade's own edge columns and rows, so any two can sit side by side or one above the
// other. building() puts a whole front together from a seed.

import { Canvas } from "../core/canvas.js";
import { hex, shade, tint, RAMP, WHITE, INK } from "../core/color.js";
import { Rng } from "../core/math.js";

const ramp = (name) => { if (!RAMP[name]) throw new Error(`tile: unknown ramp "${name}"`); return RAMP[name]; };

function siding(g, x, y, w, h, r) {
  g.rect(x, y, w, h, r[2]);
  for (let j = 3; j < h; j += 4) g.hline(y + j, x, x + w - 1, r[1]);
}

/** Plain siding, 16 x 16. Repeats in both directions. */
export function facade({ color = "cream" } = {}) {
  const g = new Canvas(16, 16);
  siding(g, 0, 0, 16, 16, ramp(color));
  return g;
}

/** Siding with a window, 16 x 16. opts: { color, lit (a warm light inside) }. */
export function windowPiece({ color = "cream", lit = false } = {}) {
  const g = facade({ color }), glass = lit ? RAMP.sun : RAMP.sky;
  g.rect(3, 2, 10, 10, WHITE);
  g.rect(4, 3, 8, 8, glass[1]);
  g.rect(4, 3, 8, 3, glass[2]);
  for (let i = 0; i < 3; i++) g.set(5 + i, 7 - i, glass[3]).set(6 + i, 7 - i, glass[3]);
  g.vline(7, 3, 10, WHITE); g.vline(8, 3, 10, WHITE);
  g.hline(12, 2, 13, WHITE); g.hline(13, 2, 13, ramp(color)[0]);
  return g;
}

/** Siding with a door, 16 x 32. opts: { color, door (a ramp name) }. */
export function doorPiece({ color = "cream", door = "coral" } = {}) {
  const g = new Canvas(16, 32), r = ramp(color), d = ramp(door);
  siding(g, 0, 0, 16, 32, r);
  g.rect(2, 5, 12, 27, WHITE);                                    // frame
  g.rect(3, 6, 10, 5, RAMP.sky[1]); g.hline(6, 3, 12, RAMP.sky[2]); g.vline(7, 6, 10, WHITE); g.vline(8, 6, 10, WHITE);   // a light above the door
  g.hline(11, 3, 12, WHITE);
  g.rect(3, 12, 10, 19, d[1]);
  g.vline(3, 12, 30, d[2]); g.vline(12, 12, 30, d[0]);
  g.rect(5, 14, 6, 6, d[0]); g.rect(5, 14, 6, 1, shade(d[0], 0.15)); g.rect(5, 22, 6, 7, d[0]); g.rect(5, 22, 6, 1, shade(d[0], 0.15));   // two sunk panels
  g.rect(10, 20, 2, 2, RAMP.sun[2]); g.set(11, 21, RAMP.sun[0]);  // knob
  g.hline(31, 0, 15, hex("#d8d5cf"));                             // step
  return g;
}

/** A row of roof, 16 x 16: three courses of round tiles over a shaded eave. Repeats left to right. */
export function roofPiece({ color = "coral" } = {}) {
  const g = new Canvas(16, 16), r = ramp(color);
  g.rect(0, 0, 16, 14, r[1]);
  g.hline(0, 0, 15, r[3]); g.hline(1, 0, 15, r[2]);
  for (let course = 0; course < 3; course++) {
    const y = 2 + course * 4, off = course % 2 ? 2 : 0;
    g.hline(y + 3, 0, 15, r[0]);
    for (let x = off; x < 16 + off; x += 4) { g.set((x + 3) % 16, y + 2, r[0]); g.set(x % 16, y, r[2]); g.set((x + 1) % 16, y, r[2]); }
  }
  g.hline(14, 0, 15, shade(r[0], 0.25)); g.hline(15, 0, 15, shade(r[0], 0.4));
  return g;
}

/** A striped awning over siding, 16 x 16. Repeats left to right. opts: { color (the wall), stripe (a ramp name) }. */
export function awningPiece({ color = "cream", stripe = "mint" } = {}) {
  const g = facade({ color }), s = ramp(stripe);
  for (let x = 0; x < 16; x++) {
    const on = (x >> 2) & 1, c = on ? s[1] : WHITE, d = on ? s[0] : hex("#dfe3ea");
    g.vline(x, 2, 9, c); g.set(x, 2, on ? s[2] : WHITE); g.set(x, 9, d);
    g.set(x, 10, (x & 3) !== 3 ? d : ramp(color)[0]);              // a scalloped hem, the wall in shadow between the scallops
  }
  g.hline(1, 0, 15, shade(ramp(color)[0], 0.2));
  g.hline(11, 0, 15, ramp(color)[0]); g.rect(0, 12, 16, 1, ramp(color)[0], 0.5);   // its shadow on the wall, the last row dithered
  return g;
}

/**
 * A whole building front from pieces, with one outline around it. opts: { cols (2..8), floors (upper floors,
 * 0..4), color, roof, stripe, door (ramp names), seed, lit (0..1: how many windows are lit) }.
 * Size: (cols * 16 + 2) x (16 + floors * 16 + 32 + 2).
 */
export function building({ cols = 4, floors = 2, color = "cream", roof = "coral", stripe = "mint", door = "coral", seed = 1, lit = 0.25 } = {}) {
  const rng = new Rng(seed * 48271 + cols * 7 + floors), W = cols * 16, H = 16 + floors * 16 + 32;
  const g = new Canvas(W + 2, H + 2), put = (piece, cx, y) => g.paste(piece, 1 + cx * 16, 1 + y);
  const doorCol = rng.int(0, cols - 1);
  for (let x = 0; x < cols; x++) {
    put(roofPiece({ color: roof }), x, 0);
    for (let f = 0; f < floors; f++) put(windowPiece({ color, lit: rng.chance(lit) }), x, 16 + f * 16);
    const y = 16 + floors * 16;
    if (x === doorCol) put(doorPiece({ color, door }), x, y);
    else { put(awningPiece({ color, stripe }), x, y); put(windowPiece({ color, lit: rng.chance(lit) }), x, y + 16); }
  }
  g.rect(1, 17, W, 2, shade(ramp(color)[0], 0.15), (u, v) => 0.8 - v * 0.4);   // the eave's shadow, dithered
  g.hline(H, 1, W, ramp(color)[0]);                                // where it meets the ground
  return g.outline(INK);
}
