// Floors, 16 x 16, pale on purpose: the office multiplies a room's tint over them. Every one repeats in both
// directions; anything placed by the seed wraps around the edge, so the seam is never where a mark got cut.

import { Canvas } from "../core/canvas.js";
import { hex } from "../core/color.js";
import { Rng, wrap } from "../core/math.js";

export const TILE = 16;
const h = hex;
// a run of pixels that wraps around the tile's edges
const dash = (g, x, y, len, c, vertical = false) => { for (let i = 0; i < len; i++) g.set(wrap(vertical ? x : x + i, g.w), wrap(vertical ? y + i : y, g.h), c); };

export const FLOORS = {
  // four long boards a tile; only every other board has a joint here, so they read as planks, not bricks
  plank(g, r) {
    g.rect(0, 0, 16, 16, h("#f7ecd6"));
    for (let b = 0; b < 4; b++) {
      const y = b * 4;
      g.hline(y + 3, 0, 15, h("#e6d3b0"));
      const joint = b % 2 === 0 ? (b ? 12 : 4) : -1;
      if (joint >= 0) g.vline(joint, y, y + 2, h("#ecdcbd"));
      const len = r.int(3, 5), x = joint >= 0 ? joint + 2 + r.int(0, 6) : r.int(0, 15);   // grain: mid-board, clear of the joint
      dash(g, x, y + 1, len, h("#f1e3c6"));
    }
  },
  // one big slab: grout below and right, a lit edge above and left
  slab(g) {
    g.rect(0, 0, 16, 16, h("#f6f2ea"));
    g.hline(15, 0, 15, h("#e3ddd0")); g.vline(15, 0, 15, h("#e3ddd0"));
    g.hline(0, 0, 14, h("#fcfaf5")); g.vline(0, 0, 14, h("#fcfaf5"));
  },
  checker(g) {
    g.rect(0, 0, 16, 16, h("#f7f3ee"));
    g.rect(0, 0, 8, 8, h("#ece4dc")); g.rect(8, 8, 8, 8, h("#ece4dc"));
    g.hline(7, 0, 7, h("#e4dbd1")); g.hline(15, 8, 15, h("#e4dbd1"));
  },
  // carpet: a weave of short stitches, each two pixels so none stands alone, and a few longer threads
  carpet(g, r) {
    g.rect(0, 0, 16, 16, h("#eef3ee"));
    for (let y = 0; y < 16; y += 2) for (let x = (y % 4 ? 2 : 0); x < 16; x += 4) dash(g, x, y, 2, h("#e2e9e4"));
    for (let n = 0; n < 3; n++) dash(g, r.int(0, 15), 1 + n * 6, 3, h("#dde5df"));
  },
  // terrazzo: pastel chips set in a pale ground
  terrazzo(g, r) {
    g.rect(0, 0, 16, 16, h("#f5f1ea"));
    const chips = ["#f6d5c6", "#cfe9e0", "#d3e3f5", "#f6e7b8", "#e2daf0"].map(h);
    for (let cy = 0; cy < 4; cy++)
      for (let cx = 0; cx < 4; cx++) {
        if (r.chance(0.3)) continue;
        const x = cx * 4 + r.int(0, 1), y = cy * 4 + r.int(0, 1), c = r.pick(chips), v = r.chance(0.5);
        dash(g, x, y, 2, c, v);
        if (r.chance(0.4)) dash(g, x + (v ? 1 : 0), y + (v ? 0 : 1), 2, c, v);
      }
  },
  // pavement: half-tile slabs in a running bond
  pavement(g, r) {
    g.rect(0, 0, 16, 16, h("#eceae6"));
    for (const y of [7, 15]) g.hline(y, 0, 15, h("#d8d5cf"));
    g.vline(7, 0, 6, h("#d8d5cf")); g.vline(15, 0, 6, h("#d8d5cf")); g.vline(3, 8, 14, h("#d8d5cf")); g.vline(11, 8, 14, h("#d8d5cf"));
    for (const y of [0, 8]) g.hline(y, 0, 15, h("#f6f5f2"));
    g.set(7, 0, h("#d8d5cf")); g.set(15, 0, h("#d8d5cf")); g.set(3, 8, h("#d8d5cf")); g.set(11, 8, h("#d8d5cf"));
    for (let n = 0; n < 3; n++) dash(g, r.int(0, 15), r.pick([3, 4, 11, 12]), 2, h("#e2dfda"));
  },
  // grass: tufts two pixels tall, brighter flecks between them
  grass(g, r) {
    g.rect(0, 0, 16, 16, h("#c3e6ae"));
    for (let cy = 0; cy < 4; cy++)
      for (let cx = 0; cx < 4; cx++) {
        const x = cx * 4 + r.int(0, 2), y = cy * 4 + r.int(0, 1);
        if (r.chance(0.55)) { dash(g, x, y, 2, h("#a5d491"), true); g.set(wrap(x + 1, 16), wrap(y + 1, 16), h("#a5d491")); }
        else if (r.chance(0.5)) dash(g, x, y + 2, 2, h("#d6f0c2"));
      }
  },
};

/** A floor tile. kind: a key of FLOORS; opts: { seed }. */
export function floor(kind, { seed = 1 } = {}) {
  if (!FLOORS[kind]) throw new Error(`tile: unknown floor "${kind}"`);
  const g = new Canvas(TILE, TILE);
  FLOORS[kind](g, new Rng(typeof seed === "string" ? seed : (seed * 7919 + kind.length * 31) >>> 0));
  return g;
}
