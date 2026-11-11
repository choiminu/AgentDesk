#!/usr/bin/env node
// The office's "town" look (assets/pixel/town/*.png): our own drawings, made here pixel by pixel — round-headed
// characters with dot eyes, pale floors and soft furniture, for a bright virtual-office feel. Nothing is copied from
// another product's art. Same file names, sizes and frame layout as assets/pixel, so the office draws either set.
//
//   node scripts/office-town.mjs            # writes assets/pixel/town/
//
// Character sheet (112 x 96): 7 frames x 3 rows of 16 x 32 — rows: facing down, up, right (left is the right row mirrored);
// frames: 0-2 walk (1 = standing), 3-4 typing (seated), 5-6 reading (seated, glasses and a sheet of paper).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./make-icon.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "pixel", "town");

// ── a tiny canvas ──
const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const dark = (c, t = 0.22) => mix(c, [38, 26, 52], t);     // shade towards a cool dark, not black
const light = (c, t = 0.25) => mix(c, [255, 250, 235], t);
const INK = rgb("#352b3d");                                  // the outline
function canvas(w, h) {
  const px = Buffer.alloc(w * h * 4);
  const api = {
    w, h, px,
    set(x, y, c, a = 255) { if (x < 0 || y < 0 || x >= w || y >= h || !c) return; const i = (y * w + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a; },
    get(x, y) { if (x < 0 || y < 0 || x >= w || y >= h) return null; const i = (y * w + x) * 4; return px[i + 3] ? [px[i], px[i + 1], px[i + 2], px[i + 3]] : null; },
    clear(x, y) { if (x < 0 || y < 0 || x >= w || y >= h) return; px[(y * w + x) * 4 + 3] = 0; },
    rect(x, y, rw, rh, c, a) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) api.set(x + i, y + j, c, a); },
    row(y, x0, x1, c) { for (let x = x0; x <= x1; x++) api.set(x, y, c); },
    col(x, y0, y1, c) { for (let y = y0; y <= y1; y++) api.set(x, y, c); },
    // a 1px outline around whatever is drawn inside the box (4-neighbours), kept inside the box
    outline(x0, y0, bw, bh, c = INK) {
      const add = [];
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
        if (api.get(x, y)) continue;
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X >= x0 && X < x0 + bw && Y >= y0 && Y < y0 + bh && api.get(X, Y); });
        if (n) add.push([x, y]);
      }
      for (const [x, y] of add) api.set(x, y, c);
    },
    blit(src, dx, dy) { for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const p = src.get(x, y); if (p) api.set(dx + x, dy + y, p, p[3]); } },
    save(name) { writeFileSync(join(OUT, `${name}.png`), encodePng(w, h, px)); },
  };
  return api;
}

// ── characters ──
const SKIN = { fair: "#f6d3b3", tan: "#e3ab7e", brown: "#b97a52", deep: "#8f5d40" };
const HAIRC = { black: "#33303f", brown: "#6b4530", chestnut: "#9a5a34", blonde: "#e8c36a", red: "#c8553a", pink: "#ee8fb2", blue: "#5b8fd8", silver: "#c9ccd6", green: "#58b08a", purple: "#8a68c8" };
// style: fringe 'full' | 'part' | 'none'; side = last row the hair covers beside the face (cell rows, 13 = ear-high … 21 = long);
// top: '' | 'bun' | 'spiky' | 'cap' | 'beanie' | 'tuft'
const CHARS = [
  { skin: "fair", hair: "brown", fringe: "full", side: 15, top: "", shirt: "#4f8fe0", pants: "#3b4a6b", detail: "collar" },
  { skin: "tan", hair: "black", fringe: "part", side: 19, top: "", shirt: "#ef8a5b", pants: "#4a4458", detail: "" },
  { skin: "fair", hair: "blonde", fringe: "full", side: 21, top: "", shirt: "#e86f9a", pants: "#5a4a7a", detail: "stripe" },
  { skin: "brown", hair: "black", fringe: "none", side: 13, top: "spiky", shirt: "#47b58a", pants: "#3f4a52", detail: "" },
  { skin: "fair", hair: "red", fringe: "part", side: 16, top: "bun", shirt: "#f2c14e", pants: "#5b4636", detail: "overall" },
  { skin: "deep", hair: "black", fringe: "none", side: 14, top: "", shirt: "#f4f1ea", pants: "#3c4a66", detail: "collar" },
  { skin: "tan", hair: "chestnut", fringe: "full", side: 14, top: "cap", cap: "#e0574f", shirt: "#5b6ee0", pants: "#44475c", detail: "" },
  { skin: "fair", hair: "pink", fringe: "full", side: 19, top: "", shirt: "#8fd0c8", pants: "#5c5470", detail: "stripe" },
  { skin: "brown", hair: "silver", fringe: "part", side: 15, top: "", shirt: "#9a6fd8", pants: "#3f3a52", detail: "collar" },
  { skin: "fair", hair: "blue", fringe: "full", side: 16, top: "tuft", shirt: "#f08a3c", pants: "#39506a", detail: "" },
  { skin: "tan", hair: "green", fringe: "none", side: 14, top: "beanie", cap: "#f2c14e", shirt: "#5aa9e6", pants: "#4a4458", detail: "overall" },
  { skin: "deep", hair: "purple", fringe: "part", side: 21, top: "", shirt: "#ef6f6f", pants: "#3b4a6b", detail: "" },
];

// one 16 x 32 frame. view: 'down' | 'up' | 'side'; pose: 'stand' | 'walkA' | 'walkB' | 'typeA' | 'typeB' | 'readA' | 'readB'
function drawChar(g, ox, oy, c, view, pose) {
  const skin = rgb(SKIN[c.skin]), skinD = dark(skin, 0.18), hair = rgb(HAIRC[c.hair]), hairD = dark(hair, 0.25), hairL = light(hair, 0.3);
  const shirt = rgb(c.shirt), shirtD = dark(shirt, 0.2), pants = rgb(c.pants), pantsD = dark(pants, 0.25), shoe = rgb("#4a3b45");
  const capC = c.cap ? rgb(c.cap) : null, capD = capC && dark(capC, 0.2);
  const seated = /^(type|read)/.test(pose), s = seated ? 3 : 0;   // a seated body sits 3px lower; its legs are tucked away
  const P = (x, y, col) => g.set(ox + x, oy + y, col);
  const R = (y, x0, x1, col) => { for (let x = x0; x <= x1; x++) P(x, y, col); };
  const blush = mix(skin, [240, 120, 130], 0.35);

  if (view === "side") {
    // legs first (the body overlaps them)
    if (!seated) {
      if (pose === "stand") { for (let y = 26; y <= 28; y++) R(y, 6, 9, y === 28 ? pantsD : pants); R(29, 6, 10, shoe); }
      else {   // a stride: one leg forward, one back; A and B swap which foot is planted
        const a = pose === "walkA";
        for (let y = 26; y <= 27; y++) { R(y, 4, 6, pantsD); R(y, 8, 10, pants); }
        R(28, a ? 3 : 4, a ? 5 : 6, a ? shoe : pantsD); R(28, a ? 9 : 9, a ? 11 : 11, a ? pants : shoe);
        if (a) R(29, 9, 12, shoe); else R(29, 3, 6, shoe);
      }
    } else { R(29, 7, 11, pants); R(30, 10, 12, shoe); }
    // body
    for (let y = 20 + s; y <= 25 + s; y++) R(y, 6, 10, y === 25 + s ? shirtD : shirt);
    if (c.detail === "overall") for (let y = 23 + s; y <= 25 + s; y++) R(y, 6, 10, pants);
    if (c.detail === "stripe") R(22 + s, 6, 10, light(shirt, 0.5));
    // head
    for (let y = 11 + s; y <= 19 + s; y++) R(y, y === 11 + s || y === 19 + s ? 5 : 4, y === 11 + s || y === 19 + s ? 11 : 12, skin);
    R(19 + s, 5, 11, skinD);
    P(10, 15 + s, INK); P(10, 16 + s, INK);                 // one eye
    P(11, 17 + s, blush);
    // hair: the top and the back of the head
    R(10 + s, 5, 11, hair); R(11 + s, 4, 12, hair); R(12 + s, 4, 12, hair);
    if (c.fringe !== "none") R(13 + s, 4, 12, hair); else R(13 + s, 4, 8, hair);
    for (let y = 13 + s; y <= Math.min(c.side + 2, 22) + s; y++) R(y, y > 19 + s ? 5 : 4, 7, y >= c.side + 1 + s ? hairD : hair);
    R(11 + s, 6, 8, hairL);
    hat(g, ox, oy + s, c, "side", hair, hairD, capC, capD);
    // the near arm
    if (pose === "typeA" || pose === "typeB") { const y = (pose === "typeA" ? 24 : 25) + s; R(y, 8, 11, shirtD); P(12, y, skin); }
    else if (pose === "readA" || pose === "readB") {
      const y = (pose === "readA" ? 23 : 22) + s;
      R(y + 1, 8, 11, shirtD); P(12, y + 1, skin);
      for (let k = 0; k < 5; k++) { P(13, y - 2 + k, rgb("#ffffff")); P(14, y - 2 + k, rgb("#d9dde6")); }
      P(10, 15 + s, rgb("#bfe3ff")); P(11, 15 + s, INK); P(9, 15 + s, INK);   // glasses
    } else { const sw = pose === "walkA" ? 1 : pose === "walkB" ? -1 : 0; for (let y = 20; y <= 23; y++) P(8 + (y > 21 ? sw : 0), y, shirtD); P(8 + sw, 24, skin); }
    g.outline(ox, oy, 16, 32);
    return;
  }

  const back = view === "up";
  // legs
  if (!seated) {
    const lUp = pose === "walkA" ? 1 : 0, rUp = pose === "walkB" ? 1 : 0;
    for (let y = 26; y <= 28 - lUp; y++) { R(y, 5, 7, pants); P(7, y, pantsD); }
    for (let y = 26; y <= 28 - rUp; y++) { R(y, 8, 10, pants); }
    R(29 - lUp, 5, 7, shoe); R(29 - rUp, 8, 10, shoe);
  } else { R(29, 5, 6, shoe); R(29, 9, 10, shoe); }
  // body and arms
  for (let y = 20 + s; y <= 25 + s; y++) R(y, 5, 10, y === 25 + s ? shirtD : shirt);
  if (c.detail === "collar" && !back) { P(7, 20 + s, rgb("#ffffff")); P(8, 20 + s, rgb("#ffffff")); }
  if (c.detail === "stripe") R(22 + s, 5, 10, light(shirt, 0.5));
  if (c.detail === "overall") { for (let y = 23 + s; y <= 25 + s; y++) R(y, 5, 10, pants); if (!back) { P(6, 21 + s, pants); P(9, 21 + s, pants); P(6, 22 + s, pants); P(9, 22 + s, pants); } else { P(6, 21 + s, pants); P(9, 21 + s, pants); P(6, 22 + s, pants); P(9, 22 + s, pants); } }
  if (pose === "typeA" || pose === "typeB") {
    const l = pose === "typeA" ? 0 : 1;   // the hands tap in turn
    for (let y = 21 + s; y <= 23 + s; y++) { P(4, y, shirtD); P(11, y, shirtD); }
    if (!back) { P(3, 24 + s - (1 - l), shirtD); P(3, 25 + s - (1 - l), skin); P(12, 24 + s - l, shirtD); P(12, 25 + s - l, skin); }
    else { P(4, 24 + s, shirtD); P(11, 24 + s, shirtD); }
  } else if (pose === "readA" || pose === "readB") {
    for (let y = 21 + s; y <= 24 + s; y++) { P(4, y, shirtD); P(11, y, shirtD); }
    if (!back) {
      const y = (pose === "readA" ? 24 : 23) + s;
      for (let j = 0; j < 5; j++) R(y + j, 5, 10, rgb("#ffffff"));
      R(y + 1, 6, 9, rgb("#aab2c2")); R(y + 3, 6, 8, rgb("#aab2c2"));
      P(4, y + 2, skin); P(11, y + 2, skin);
    }
  } else {
    const lUp = pose === "walkB" ? 1 : 0, rUp = pose === "walkA" ? 1 : 0;   // the arm swings with the other leg
    for (let y = 20; y <= 23 - lUp; y++) P(4, y, shirtD); P(4, 24 - lUp, skin);
    for (let y = 20; y <= 23 - rUp; y++) P(11, y, shirtD); P(11, 24 - rUp, skin);
  }
  // head
  for (let y = 11 + s; y <= 19 + s; y++) R(y, y === 11 + s || y === 19 + s ? 4 : 3, y === 11 + s || y === 19 + s ? 11 : 12, skin);
  R(19 + s, 4, 11, skinD);
  if (!back) {
    P(5, 15 + s, INK); P(5, 16 + s, INK); P(10, 15 + s, INK); P(10, 16 + s, INK);
    P(4, 17 + s, blush); P(11, 17 + s, blush);
    if (pose === "readA" || pose === "readB") {   // glasses
      for (const x of [4, 6, 7, 8, 9, 11]) P(x, 15 + s, INK);
      P(5, 15 + s, rgb("#bfe3ff")); P(10, 15 + s, rgb("#bfe3ff"));
    }
    // hair
    R(10 + s, 4, 11, hair); R(11 + s, 3, 12, hair); R(12 + s, 3, 12, hair);
    if (c.fringe === "full") { R(13 + s, 3, 12, hair); P(6, 14 + s, hair); P(7, 14 + s, hair); P(8, 14 + s, hair); P(3, 14 + s, hair); P(12, 14 + s, hair); }
    else if (c.fringe === "part") { R(13 + s, 3, 6, hair); R(13 + s, 10, 12, hair); P(3, 14 + s, hair); P(4, 14 + s, hair); P(12, 14 + s, hair); }
    else { P(3, 13 + s, hair); P(12, 13 + s, hair); }
    for (let y = 13 + s; y <= Math.min(c.side, 19) + s; y++) { P(3, y, hair); P(12, y, hair); }
    if (c.side > 19) for (let y = 14 + s; y <= c.side + s; y++) { P(2, y, y >= c.side - 1 + s ? hairD : hair); P(13, y, y >= c.side - 1 + s ? hairD : hair); if (y >= 20 + s) { P(3, y, hairD); P(12, y, hairD); } }
    R(11 + s, 5, 7, hairL);
  } else {
    R(10 + s, 4, 11, hair);
    for (let y = 11 + s; y <= Math.min(Math.max(c.side + 2, 17), 19) + s; y++) R(y, y === 11 + s || y === 19 + s ? 4 : 3, y === 11 + s || y === 19 + s ? 11 : 12, hair);
    const end = Math.min(Math.max(c.side + 2, 17), 19) + s;
    R(end, end === 19 + s ? 4 : 3, end === 19 + s ? 11 : 12, hairD);
    if (c.side > 19) for (let y = 14 + s; y <= c.side + s; y++) { R(y, 2, 13, y >= c.side - 1 + s ? hairD : hair); }
    R(12 + s, 5, 7, hairL);
  }
  hat(g, ox, oy + s, c, back ? "up" : "down", hair, hairD, capC, capD);
  g.outline(ox, oy, 16, 32);
}
function hat(g, ox, oy, c, view, hair, hairD, capC, capD) {
  const P = (x, y, col) => g.set(ox + x, oy + y, col);
  const R = (y, x0, x1, col) => { for (let x = x0; x <= x1; x++) P(x, y, col); };
  const x0 = view === "side" ? 4 : 3, x1 = 12;
  if (c.top === "bun") { R(8, 6, 9, hair); R(9, 6, 9, hair); P(6, 8, hairD); }
  else if (c.top === "spiky") { for (const x of [4, 6, 8, 10]) { P(x, 9, hair); P(x + 1, 9, hair); P(x, 8, hair); } }
  else if (c.top === "tuft") { P(8, 9, hair); P(9, 8, hair); P(9, 9, hair); }
  else if (c.top === "cap") {
    R(9, x0 + 2, x1 - 2, capC); R(10, x0 + 1, x1 - 1, capC); R(11, x0, x1, capC); R(12, x0, x1, capD);
    if (view === "down") R(13, 2, 13, capD); else if (view === "side") R(12, 11, 14, capD);
  } else if (c.top === "beanie") {
    R(9, x0 + 2, x1 - 2, capC); R(10, x0 + 1, x1 - 1, capC); R(11, x0, x1, capC); R(12, x0, x1, capD); P(8, 8, capD); P(7, 8, capD);
  }
}
function charSheet(c) {
  const g = canvas(112, 96), poses = ["walkA", "stand", "walkB", "typeA", "typeB", "readA", "readB"], views = ["down", "up", "side"];
  for (let r = 0; r < 3; r++) for (let f = 0; f < 7; f++) drawChar(g, f * 16, r * 32, c, views[r], poses[f]);
  return g;
}

// ── floors (16 x 16, pale: the office multiplies a tint over them) ──
function floors() {
  const out = {};
  const base = (c) => { const g = canvas(16, 16); g.rect(0, 0, 16, 16, rgb(c)); return g; };
  let g = base("#f7ecd6");                                   // planks: two boards per tile, joints staggered
  for (const y of [7, 15]) g.row(y, 0, 15, rgb("#e6d3b0"));
  g.col(4, 0, 6, rgb("#ead9b8")); g.col(11, 8, 14, rgb("#ead9b8"));
  for (const [x, y] of [[8, 2], [9, 2], [1, 11], [2, 11], [13, 4]]) g.set(x, y, rgb("#f0e1c2"));
  out.floor_plank = g;
  g = base("#f6f2ea"); g.row(15, 0, 15, rgb("#e3ddd0")); g.col(15, 0, 15, rgb("#e3ddd0")); g.row(0, 0, 14, rgb("#fbf9f4")); out.floor_tiles = g;
  g = base("#f7f3ee"); g.rect(0, 0, 8, 8, rgb("#ece4dc")); g.rect(8, 8, 8, 8, rgb("#ece4dc")); out.floor_checker = g;
  g = base("#f1f3f1");                                       // carpet: a quiet weave
  for (let y = 0; y < 16; y += 2) for (let x = (y / 2) % 2 ? 1 : 0; x < 16; x += 4) g.set(x, y, rgb("#e2e7e3"));
  out.floor_grid = g;
  g = base("#f6ead8");                                       // parquet: blocks turned in pairs
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const q = (x < 8) === (y < 8); if (q ? (y % 4 === 3) : (x % 4 === 3)) g.set(x, y, rgb("#e7d6bb")); }
  out.floor_brick = g;
  g = base("#f3ede2"); for (const [x, y] of [[3, 4], [11, 9], [6, 13]]) g.set(x, y, rgb("#e8dfd0")); out.floor = g;
  return out;
}

// ── furniture ──
function furniture() {
  const out = {};
  const W = rgb("#ffffff"), wood = rgb("#f0d6a8"), woodL = rgb("#f9e6c2"), woodD = rgb("#d3b07e"), leg = rgb("#e9ebf0"), legD = rgb("#b9bfcc");
  // desk 48 x 32: the top at rows 11-26, legs below
  let g = canvas(48, 32);
  g.rect(3, 12, 42, 11, wood); g.row(12, 3, 44, woodL); g.rect(3, 23, 42, 3, woodD);
  for (const [x, y] of [[3, 12], [44, 12]]) g.clear(x, y);
  g.rect(8, 17, 6, 1, woodD); g.rect(30, 15, 9, 1, woodD);            // grain
  g.rect(5, 26, 2, 5, leg); g.rect(41, 26, 2, 5, leg); g.col(6, 26, 30, legD); g.col(42, 26, 30, legD);
  g.outline(0, 0, 48, 32);
  g.rect(8, 28, 32, 3, [60, 45, 70], 38);                              // a soft shadow under it
  out.desk = g;
  // monitor + keyboard + mouse, 16 x 32
  const pc = (on, f) => {
    const m = canvas(16, 32), bezel = rgb("#f2f4f8"), bezelD = rgb("#c9cfdb");
    m.rect(2, 1, 12, 10, bezel); m.rect(3, 2, 10, 7, on ? rgb("#34406a") : rgb("#3a3f4c"));
    if (on) {
      const lines = [["#7fe0b0", 4], ["#ffd27a", 6], ["#8fc4ff", 3], ["#f29ab8", 5], ["#7fe0b0", 2]];
      for (let r = 0; r < 3; r++) { const [c, n] = lines[(r + f) % lines.length]; m.row(3 + r * 2, 4 + (r % 2), Math.min(11, 4 + (r % 2) + n), rgb(c)); }
      m.set(4 + ((f * 3) % 7), 8, W);                                    // the cursor moves
    } else m.set(11, 3, rgb("#565c6c"));
    m.row(10, 2, 13, bezelD); m.rect(7, 11, 2, 3, bezelD); m.rect(5, 14, 6, 1, bezel);
    m.outline(0, 0, 16, 17);
    m.rect(1, 19, 9, 3, bezel); for (let x = 2; x < 9; x += 2) { m.set(x, 20, bezelD); } m.row(21, 1, 9, bezelD);
    m.rect(13, 19, 2, 3, bezel); m.set(13, 19, on ? rgb("#8fc4ff") : bezelD);
    m.outline(0, 17, 16, 7);
    return m;
  };
  out.pc_off = pc(false, 0); out.pc_on_1 = pc(true, 0); out.pc_on_2 = pc(true, 1); out.pc_on_3 = pc(true, 2);
  // chair back 16 x 16 (drawn in front of the seated agent)
  g = canvas(16, 16);
  const ch = rgb("#7d8fe6"), chL = light(ch, 0.3), chD = dark(ch, 0.22);
  g.rect(3, 5, 10, 10, ch); g.row(5, 4, 11, chL); g.clear(3, 5); g.clear(12, 5); g.row(14, 3, 12, chD); g.rect(5, 8, 6, 1, chL);
  g.outline(0, 3, 16, 13);
  out.chair_back = g;
  // sofa 32 x 16, seen from the front: arms, two cushions, a darker front edge (rows 12-15 are drawn over whoever sits)
  g = canvas(32, 16);
  const so = rgb("#7fcdc2"), soL = light(so, 0.3), soD = dark(so, 0.2);
  g.rect(1, 1, 30, 14, so); g.row(1, 2, 29, soL); g.rect(1, 3, 3, 12, soD); g.rect(28, 3, 3, 12, soD); g.row(3, 1, 3, soL); g.row(3, 28, 30, soL);
  g.col(15, 4, 11, soD); g.col(16, 4, 11, soL); g.rect(4, 12, 24, 3, soD); g.row(12, 4, 27, so);
  g.outline(0, 0, 32, 16);
  out.sofa_front = g;
  // coffee table 32 x 32: a rounded pale top with a mug ring of colour
  g = canvas(32, 32);
  g.rect(3, 7, 26, 19, woodL); g.rect(3, 23, 26, 3, woodD); g.row(7, 4, 27, W);
  for (const [x, y] of [[3, 7], [28, 7], [3, 25], [28, 25]]) g.clear(x, y);
  g.rect(5, 26, 2, 4, leg); g.rect(25, 26, 2, 4, leg);
  g.rect(18, 11, 4, 3, rgb("#f29a8a")); g.set(22, 12, rgb("#f29a8a")); g.rect(8, 16, 7, 4, rgb("#ffffff")); g.row(17, 9, 13, rgb("#aab2c2")); g.row(18, 9, 12, rgb("#aab2c2"));
  g.outline(0, 0, 32, 32);
  out.coffee_table = g;
  return out;
}

// ── run ──
mkdirSync(OUT, { recursive: true });
const made = [];
CHARS.forEach((c, i) => { charSheet(c).save(`char_${i}`); made.push(`char_${i}`); });
for (const [n, g] of Object.entries({ ...floors(), ...furniture() })) { g.save(n); made.push(n); }
writeFileSync(join(OUT, "names.json"), JSON.stringify(made.sort()) + "\n");
console.log(`town: ${made.length} files → ${OUT}`);
