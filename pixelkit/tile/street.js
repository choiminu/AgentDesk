// The dock's street: a strip 72 px tall drawn at the characters' own scale (1 picture pixel = 1 screen pixel).
//
//   y  0-39   ground floors of shops and houses on transparency (the sky shows above and between them);
//             doors are 28 px tall, a character's height
//   y 40-67   pavement: characters stand with their feet near y 46, their name tags below
//   y 68-71   the kerb and the edge of the road
//
// street({ lit }) draws the same strip twice: by day, and with the windows, shop fronts and door lamps lit. Both
// come from one pass over one list of buildings, so they differ only inside LIT_REGIONS.

import { Canvas } from "../core/canvas.js";
import { hex, shade, tint, withAlpha, RAMP, WHITE, INK } from "../core/color.js";
import { Rng } from "../core/math.js";
import { cloud } from "./sky.js";

export const STREET = { w: 512, h: 72, ground: 40, feet: 46, skyW: 64 };
const GROUND = STREET.ground, SPILL = 4;

// ── sky ──
const SKIES = {
  day: ["#6fb0ea", "#93c8f4", "#b9defa", "#d9eefc"],
  dusk: ["#5b4f96", "#9a6fb4", "#e88f8f", "#fbc28e"],
  night: ["#141a3d", "#1c2350", "#262e62", "#323b78"],
};
/** A sky behind the street, 64 x 72, repeating left to right. kind: "day" | "dusk" | "night". */
export function streetSky(kind = "day", { seed = 1 } = {}) {
  if (!SKIES[kind]) throw new Error(`tile: unknown street sky "${kind}"`);
  const r = SKIES[kind].map(hex), g = new Canvas(STREET.skyW, STREET.h, r[3]);
  g.bands(0, 0, STREET.skyW, 48, r, { soft: 3 });           // the whole fade happens above the pavement
  if (kind === "night") {
    const rng = new Rng(seed * 2654435761), star = hex("#fff6c9"), dim = hex("#8f9be0");
    for (let n = 0; n < 16; n++) {
      const x = rng.int(2, STREET.skyW - 3), y = rng.int(2, 34);
      if (n < 4) { g.hline(y, x - 1, x + 1, star); g.vline(x, y - 1, y + 1, star); } else g.set(x, y, dim);
    }
  }
  return g;
}

// ── the front ──
// Everything that lights up goes through one of these three, which also note where it is.
function painter(g, lit, regions) {
  const mark = (x, y, w, h) => regions.push([x, y, w, h]);
  return {
    /** A pane of glass: sky-blue by day, warm when lit. */
    glass(x, y, w, h) {
      mark(x, y, w, h);
      const r = lit ? RAMP.sun : RAMP.sky;
      g.rect(x, y, w, h, lit ? r[2] : r[1]);
      g.rect(x, y, w, Math.max(1, Math.round(h / 3)), lit ? r[3] : r[2]);
      if (lit) g.hline(y + h - 1, x, x + w - 1, r[1]);
      else for (let i = 0; i < Math.min(4, w - 2, h - 1); i++) g.set(x + 1 + i, y + Math.min(h - 1, 3) - Math.min(i, h - 1), r[3]);   // a glint
    },
    /** A small lamp on the wall: grey by day, bright when lit. */
    lamp(x, y) {
      mark(x, y, 3, 4);
      g.hline(y, x, x + 2, RAMP.slate[1]);
      g.rect(x, y + 1, 3, 2, lit ? hex("#fff3b8") : RAMP.paper[1]);
      g.set(x + 1, y + 3, RAMP.slate[1]);
    },
    /** Light spilling from a window or a door onto the pavement in front of it: two solid rows, two dithered. */
    spill(x, w) {
      mark(x, GROUND, w, SPILL);
      if (lit) { g.rect(x, GROUND, w, 2, hex("#f8edc6")); g.rect(x + 1, GROUND + 2, w - 2, 2, hex("#f8edc6"), 0.5); }
    },
  };
}

const wallOf = (name) => { if (!RAMP[name]) throw new Error(`tile: unknown ramp "${name}"`); return RAMP[name]; };

// a door 12 px wide and 28 tall (y 12..39): a frame, a light above it, a leaf with a pane and a sunk panel
function door(g, p, x, color) {
  const d = wallOf(color);
  g.rect(x, 11, 12, 29, WHITE);
  p.glass(x + 1, 12, 10, 4);
  g.rect(x + 1, 17, 10, 23, d[1]);
  g.vline(x + 1, 17, 39, d[2]); g.vline(x + 10, 17, 39, d[0]);
  g.rect(x + 2, 19, 8, 9, WHITE); p.glass(x + 3, 20, 6, 7);
  g.rect(x + 3, 31, 6, 6, d[0]); g.hline(31, x + 3, x + 8, shade(d[0], 0.15));
  g.rect(x + 8, 28, 2, 2, RAMP.sun[2]);                              // the handle
  p.spill(x, 12);
}
// a window with a sill; box: a flower box under it
function windowAt(g, p, x, y, w, h, { box = false, bars = true } = {}) {
  g.rect(x, y, w, h, WHITE);
  p.glass(x + 1, y + 1, w - 2, h - 2);
  if (bars) { g.vline(x + (w >> 1), y + 1, y + h - 2, WHITE); g.hline(y + (h >> 1), x + 1, x + w - 2, WHITE); }
  g.hline(y + h, x - 1, x + w, WHITE); g.hline(y + h + 1, x - 1, x + w, hex("#d9d2c6"));
  if (box) {
    g.rect(x, y + h + 1, w, 3, RAMP.wood[1]); g.hline(y + h + 3, x, x + w - 1, RAMP.wood[0]);
    for (let i = 1; i + 2 < w; i += 4) { g.rect(x + i, y + h - 1, 3, 2, RAMP.leaf[1]); g.rect(x + i + 1, y + h - 2, 2, 2, i % 8 === 1 ? RAMP.coral[1] : RAMP.rose[1]); }
  }
}
// a striped awning: the top row at y, six rows and a scalloped hem
function awning(g, x, y, w, stripe, gap) {
  const s = wallOf(stripe);
  for (let i = 0; i < w; i++) {
    const on = (i >> 2) & 1, c = on ? s[1] : WHITE, d = on ? s[0] : hex("#dfe3ea");
    g.vline(x + i, y, y + 5, c); g.set(x + i, y, on ? s[2] : WHITE); g.set(x + i, y + 5, d);
    g.set(x + i, y + 6, (i & 3) !== 3 ? d : gap);               // a scalloped hem, the wall in shadow between the scallops
  }
}

// A shop: plaster, a cornice, a sign board (a blank one: the place for a name), an awning over a display
// window, a door beside it. o: { x, w, top, wall, stripe, door, flip (door on the right) }
function shop(g, p, o) {
  const r = wallOf(o.wall), { x, w, top } = o;
  g.rect(x, top, w, GROUND - top, r[2]);
  g.rect(x, top, w, 2, r[3]); g.hline(top + 2, x, x + w - 1, r[1]);          // cornice
  g.vline(x, top + 3, 39, r[3]); g.vline(x + w - 1, top + 3, 39, r[1]);
  g.rect(x, 37, w, 3, r[0]); g.hline(37, x, x + w - 1, r[1]);                // plinth
  const dx = o.flip ? x + w - 17 : x + 5, wx = o.flip ? x + 5 : x + 21, ww = w - 26;
  const s = wallOf(o.stripe), rows = 10 - (top + 4);
  if (rows >= 4) {                                                            // the sign board
    g.rect(wx, top + 4, ww, rows, s[0]); g.rect(wx + 1, top + 5, ww - 2, rows - 2, s[1]);
    g.rect(wx + 4, top + 6, ww - 8, rows - 4, s[3]);
  } else {                                                                    // too low for a board: a sign hung on a bracket by the door
    const hx = o.flip ? dx - 9 : dx + 14;
    g.hline(12, hx, hx + 6, RAMP.slate[0]); g.rect(hx + 1, 13, 6, 6, s[0]); g.rect(hx + 2, 14, 4, 4, s[3]);
  }
  g.rect(wx, 19, ww, 17, WHITE);                                              // the display window
  p.glass(wx + 1, 20, ww - 2, 15);
  for (let i = 0, n = Math.floor((ww - 6) / 9); i < n; i++) {                 // things on a shelf inside
    const ix = wx + 4 + i * 9, c = [RAMP.coral, RAMP.leaf, RAMP.lilac, RAMP.sun][(i + (x >> 4)) % 4];
    g.rect(ix, 29, 5, 4, c[1]); g.rect(ix + 1, 28, 3, 1, c[2]); g.hline(32, ix, ix + 4, c[0]);
  }
  g.hline(33, wx + 1, wx + ww - 2, RAMP.wood[1]); g.hline(34, wx + 1, wx + ww - 2, RAMP.wood[0]);
  g.hline(36, wx - 1, wx + ww, WHITE);
  awning(g, wx - 2, 11, ww + 4, o.stripe, r[1]);
  g.rect(wx - 2, 18, ww + 4, 1, r[1]);                                        // the awning's shadow
  door(g, p, dx, o.door);
  p.spill(wx, ww);
}

// A house: siding under a pitched roof with a chimney, a door with a lamp beside it, a window with a flower box.
// o: { x, w, peak (the ridge's y), eave, wall, roof, door, flip }
function house(g, p, o) {
  const r = wallOf(o.wall), t = wallOf(o.roof), { x, w, peak, eave } = o, mid = x + w / 2;
  g.rect(x + 1, eave, w - 2, GROUND - eave, r[2]);
  for (let y = eave + 3; y < 37; y += 4) g.hline(y, x + 1, x + w - 2, r[1]);
  g.rect(x + 1, 37, w - 2, 3, r[0]);
  const cx = o.flip ? x + 9 : x + w - 14;                                     // chimney, behind the roof
  g.rect(cx, peak - 3, 5, eave - peak + 3, RAMP.brick[1]); g.hline(peak - 3, cx - 1, cx + 5, RAMP.brick[0]); g.vline(cx + 4, peak - 2, eave, RAMP.brick[0]);
  for (let px = x; px < x + w; px++) {                                        // the roof: a gable, tiled in courses
    const top = Math.round(peak + (Math.abs(px + 0.5 - mid) / (w / 2)) * (eave - peak));
    for (let y = top; y <= eave + 1; y++) g.set(px, y, y === top ? t[3] : y >= eave ? t[0] : (y - peak) % 3 === 2 ? t[0] : ((px + (((y - peak) / 3) | 0) * 3) % 6) < 2 && (y - peak) % 3 === 1 ? t[2] : t[1]);
  }
  g.hline(eave + 2, x + 1, x + w - 2, shade(r[1], 0.12));
  const dx = o.flip ? x + w - 19 : x + 7, wx = o.flip ? x + 8 : x + w - 22;
  door(g, p, dx, o.door);
  p.lamp(o.flip ? dx - 5 : dx + 14, 15);
  windowAt(g, p, wx, 17, 14, 12, { box: true });
}

// A taller building whose upper floors run off the top: a band between the floors, the sills of the windows
// above, a wide entrance under a slab, a window each side. o: { x, w, wall, door }
function block(g, p, o) {
  const r = wallOf(o.wall), { x, w } = o;
  g.rect(x, 0, w, GROUND, r[2]);
  for (let y = 11; y < 37; y += 4) for (let px = x + ((y >> 2) & 1 ? 2 : 6); px < x + w - 2; px += 8) g.hline(y, px, px + 2, r[1]);   // a few courses of brick
  g.vline(x, 0, 39, r[3]); g.vline(x + w - 1, 0, 39, r[1]);
  g.rect(x, 6, w, 2, r[3]); g.hline(8, x, x + w - 1, r[1]);                   // the band between the floors
  for (let i = 0; i < 3; i++) {                                               // the windows above, cut by the bar's top edge
    const ux = x + 8 + Math.round((i * (w - 30)) / 2);
    g.rect(ux, 0, 14, 4, WHITE); p.glass(ux + 1, 0, 12, 3); g.vline(ux + 7, 0, 2, WHITE); g.hline(4, ux - 1, ux + 14, WHITE);
  }
  g.rect(x, 36, w, 4, r[0]); g.hline(36, x, x + w - 1, r[1]);
  const dx = x + (w >> 1) - 12;
  g.rect(dx - 3, 9, 30, 2, RAMP.slate[1]); g.hline(10, dx - 3, dx + 26, RAMP.slate[0]);   // the slab over the entrance
  door(g, p, dx, o.door); door(g, p, dx + 12, o.door);
  windowAt(g, p, x + 7, 15, 14, 16); windowAt(g, p, x + w - 21, 15, 14, 16);
  p.lamp(dx - 6, 14); p.lamp(dx + 27, 14);
}

// between the buildings
function hedge(g, x, w) {
  const l = RAMP.leaf;
  for (let i = 0; i < w; i++) { const top = 31 + (i === 0 || i === w - 1 ? 2 : (i % 5 === 2 ? 0 : 1)); g.vline(x + i, top, 39, l[1]); g.set(x + i, top, l[2]); }
  for (let i = 1; i + 1 < w; i += 3) g.hline(36, x + i, x + i + 1, l[0]);
  g.hline(39, x, x + w - 1, l[0]);
}
function tree(g, x) {
  const l = RAMP.leaf, t = RAMP.wood;
  g.rect(x - 1, 24, 3, 16, t[1]); g.vline(x + 1, 24, 39, t[0]);
  g.circle(x, 14, 8.5, l[1]); g.circle(x - 5, 19, 5, l[1]); g.circle(x + 5, 19, 5.5, l[1]);
  g.circle(x - 2, 11, 4.5, l[2]); g.circle(x + 5, 20, 3.5, l[0]); g.circle(x - 5, 21, 2.5, l[0]);
  g.rect(x - 3, 8, 3, 2, l[3]); g.rect(x - 5, 10, 2, 2, l[3]);
}
function fence(g, x, w) {
  for (let i = 0; i < w; i += 3) { g.vline(x + i, 30, 39, WHITE); g.vline(x + i + 1, 31, 39, hex("#e4dfd6")); }
  g.hline(33, x, x + w - 1, WHITE); g.hline(37, x, x + w - 1, hex("#e4dfd6"));
}

// The row, left to right. Widths add up to 512, with a gap at each end so the strip meets itself.
const ROW = [
  ["gap", 6, "none"],
  ["shop", 72, { top: 2, wall: "cream", stripe: "coral", door: "coral" }],
  ["gap", 8, "tree"],
  ["house", 58, { peak: 1, eave: 9, wall: "sky", roof: "slate", door: "sun" }],
  ["gap", 6, "fence"],
  ["block", 78, { wall: "brick", door: "leaf" }],
  ["gap", 10, "none"],
  ["shop", 70, { top: 5, wall: "mint", stripe: "sun", door: "wood", flip: true }],
  ["gap", 8, "hedge"],
  ["house", 54, { peak: 4, eave: 10, wall: "rose", roof: "lilac", door: "mint", flip: true }],
  ["gap", 6, "none"],
  ["shop", 72, { top: 0, wall: "lilac", stripe: "mint", door: "rose" }],
  ["gap", 8, "tree"],
  ["house", 50, { peak: 2, eave: 9, wall: "cream", roof: "coral", door: "sky" }],
  ["gap", 6, "none"],
];

function pavement(g) {
  const base = hex("#ece9e3"), joint = hex("#dcd8d0"), W = STREET.w;
  g.rect(0, GROUND, W, STREET.h - GROUND, base);
  g.hline(GROUND, 0, W - 1, hex("#cfcac1")); g.hline(GROUND + 1, 0, W - 1, joint);   // where the walls stand
  [50, 59].forEach((y, row) => {                                             // big slabs in a running bond, kept faint
    g.hline(y, 0, W - 1, joint);
    for (let x = row ? 16 : 0; x < W; x += 32) g.vline(x, y + 1, row ? 66 : 58, joint);
  });
  for (let x = 16; x < W; x += 32) g.vline(x, GROUND + 2, 49, joint);
  g.hline(67, 0, W - 1, hex("#f7f5f0")); g.hline(68, 0, W - 1, hex("#cfcac1")); g.hline(69, 0, W - 1, hex("#aaa69e"));   // kerb
  g.rect(0, 70, W, 2, hex("#8f95a3"));                                       // the road's edge
  for (let x = 4; x < W; x += 16) g.hline(71, x, x + 5, hex("#a3a9b6"));
}

function build(lit) {
  const g = new Canvas(STREET.w, STREET.h), regions = [], p = painter(g, lit, regions);
  let x = 0;
  const later = [];
  for (const [kind, w, o] of ROW) {
    if (kind === "shop") shop(g, p, { x, w, ...o });
    else if (kind === "house") house(g, p, { x, w, ...o });
    else if (kind === "block") block(g, p, { x, w, ...o });
    else if (o === "hedge") hedge(g, x + 1, w - 2);
    else if (o === "fence") fence(g, x + 1, w - 2);
    else if (o === "tree") later.push(x + (w >> 1));
    x += w;
  }
  if (x !== STREET.w) throw new Error(`street: the row is ${x} px wide, not ${STREET.w}`);
  later.forEach((tx) => tree(g, tx));                                          // trees stand in front of the walls
  g.outline(INK, 0, 0, STREET.w, GROUND);                                    // one line round everything against the sky
  // the pavement goes under the spill, so draw it on a second canvas and put the fronts back over it
  const out = new Canvas(STREET.w, STREET.h);
  pavement(out);
  const q = painter(out, lit, []);
  for (const [rx, ry, rw, rh] of regions) if (ry === GROUND && rh === SPILL) q.spill(rx, rw);
  out.blit(g);
  return { canvas: out, regions };
}

/** The street's front, 512 x 72, repeating left to right. opts: { lit: windows, shop fronts and lamps on }. */
export const street = ({ lit = false } = {}) => build(lit).canvas;
/** Where the lit strip may differ from the day one: [[x, y, w, h], ...]. Everywhere else they are the same. */
export const LIT_REGIONS = build(false).regions;

// ── things the app places itself ──
/** A street lamp on transparency, 16 x 36, its foot on the bottom row. opts: { lit }: the same lamp, on, with a soft halo. */
export function streetLamp({ lit = false } = {}) {
  const g = new Canvas(16, 36), m = RAMP.slate;
  g.rect(7, 3, 2, 1, m[1]); g.rect(6, 4, 4, 1, m[0]); g.rect(5, 5, 6, 1, m[0]);              // the cap
  g.rect(5, 6, 6, 6, m[1]);
  g.rect(6, 6, 4, 6, lit ? hex("#ffe08a") : hex("#c9d3e6")); g.rect(6, 6, lit ? 4 : 1, lit ? 3 : 6, lit ? hex("#fff6cf") : hex("#e6ecf7"));   // the glass
  g.rect(5, 12, 6, 1, m[0]); g.rect(7, 13, 2, 2, m[1]);
  g.vline(7, 15, 31, m[2]); g.vline(8, 15, 31, m[1]);                                        // the post
  g.rect(6, 21, 4, 1, m[1]);
  g.rect(6, 32, 4, 2, m[1]); g.rect(5, 34, 6, 1, m[0]);
  g.outline(INK);
  if (!lit) return g;
  const out = new Canvas(16, 36), glow = hex("#ffe9a8");                                    // the halo is the one translucent thing here: it is light
  for (let y = 0; y < 18; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 8.5); if (d <= 7.6) out.set(x, y, withAlpha(glow, d <= 5.2 ? 132 : 70)); }
  return out.blit(g);
}
/** A cloud to drift over the street. */
export const streetCloud = () => cloud({ w: 36, seed: 9 });
