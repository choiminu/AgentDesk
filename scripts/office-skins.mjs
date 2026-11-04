#!/usr/bin/env node
// Extra office characters (assets/pixel/char_6.png …) recolored from the six Metro City sheets (CC0): same frames and
// poses, new hair and clothes. Each source sheet names its own hair and clothes colors (skin, eyes, outlines and shoes are
// left alone; guessing them from hue mixed up dark skin and black hair), and those colors are mapped by brightness onto
// a new ramp, so the shading stays where it was. Hair is only recolored in the top rows of each 16 x 32 cell unless the
// hair is long (black trousers often share hair colors).
//
//   node scripts/office-skins.mjs        (then raise OFFICE.CHAR_COUNT and the .dock-spr.kN rules in widget.html)
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./make-icon.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIX = join(ROOT, "assets", "pixel");
const HAIR_ROWS = 13;   // cell rows 0..12: hair (and the hat line); below: clothes, hands, shoes

// ramps dark → bright
const HAIR = {
  blonde: ["#6b4a1c", "#a8792e", "#d8b25a", "#f2dc8c"],
  black: ["#0d0d12", "#1d1d26", "#33333f", "#4a4a58"],
  red: ["#4a140c", "#7e2716", "#b6442a", "#de7046"],
  silver: ["#5c5f6b", "#8d909c", "#bcbfc9", "#e2e4ea"],
  pink: ["#5a1c3c", "#93305f", "#cc5a8a", "#f08cb4"],
};
const CLOTHES = {
  green: ["#0b2416", "#174a2b", "#2a7a45", "#46a866", "#7ccf8e"],
  navy: ["#070b1f", "#121c45", "#22337a", "#3a52b0", "#6f88d8"],
  teal: ["#06201f", "#0e3f3c", "#1a6b64", "#2f9a8e", "#66c9b9"],
  purple: ["#170b26", "#2f1752", "#4c2a84", "#7046b6", "#a27edc"],
  maroon: ["#1f0608", "#430e14", "#6e1a22", "#9c2f36", "#c95e5e"],
  olive: ["#1a1a08", "#3a3a12", "#5f5f20", "#878734", "#b4b45c"],
};
// source sheet → its hair colors, its clothes colors, and how many rows of each cell the hair may reach
const SRC = {
  0: { hair: ["#b18649", "#8f6439", "#6f4a2a", "#6d4726"], clothes: ["#1164a9", "#114978", "#0f406a", "#071c2e"], rows: 13 },
  1: { hair: ["#f1c084", "#e39f5a", "#be7743", "#7e4b29"], clothes: ["#2b2b2b", "#252525", "#101010"], rows: 32 },
  2: { hair: ["#2b2827", "#282423", "#252120", "#231e1d", "#221e1e", "#1b1a19", "#181616"], clothes: ["#f67d20", "#e8741b", "#e87218", "#a91d18", "#8b1a16", "#741713", "#56110e"], rows: 12 },
  3: { hair: ["#fff1ef", "#f0e1de", "#e9d7d4", "#daccc9", "#bfb6b3", "#b0a6a3"], clothes: ["#eeeeee", "#d4d4d4", "#bdbdbd"], rows: 32 },
  4: { hair: ["#69451b", "#57351a", "#432415", "#421b19", "#2f160f"], clothes: ["#eeeeee", "#d4d4d4", "#bdbdbd"], rows: 13 },
  5: { hair: ["#454545", "#414141", "#373737", "#303030", "#282828", "#202020", "#131313", "#0e0e0e"], clothes: ["#e16451", "#b24737", "#9f3f31", "#640026"], rows: 18 },
};
// new sheet index → [source sheet, hair ramp, clothes ramp]
const SKINS = [
  [0, "blonde", "green"], [1, "black", "navy"], [2, "red", "teal"],
  [3, "black", "purple"], [4, "silver", "maroon"], [5, "pink", "olive"],
];

const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

for (const [k, [src, hairName, clothesName]] of SKINS.entries()) {
  const img = decodePng(readFileSync(join(PIX, `char_${src}.png`)));
  const { w, h, px } = img, out = Buffer.from(px);
  for (const [zone, ramp] of [["hair", HAIR[hairName]], ["clothes", CLOTHES[clothesName]]]) {
    const own = SRC[src][zone].map(hex), rows = SRC[src].rows;
    const inZone = y => zone === "clothes" || y % 32 < rows;
    // the named colors, darkest first, spread over the ramp by brightness
    const sorted = [...own].sort((a, b) => lum(a) - lum(b)), lo = lum(sorted[0]), hi = lum(sorted[sorted.length - 1]);
    const map = new Map(sorted.map(c => [c.join(","), hex(ramp[Math.min(ramp.length - 1, Math.floor(((lum(c) - lo) / Math.max(1e-6, hi - lo)) * ramp.length))])]));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 128 || !inZone(y)) continue;
      const m = map.get([px[i], px[i + 1], px[i + 2]].join(","));
      if (m) [out[i], out[i + 1], out[i + 2]] = m;
    }
  }
  const n = 6 + k;
  writeFileSync(join(PIX, `char_${n}.png`), encodePng(w, h, out));
  console.log(`char_${n}.png ← char_${src} (hair ${hairName}, clothes ${clothesName})`);
}
