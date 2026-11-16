// Colors are unsigned 32-bit integers laid out like ImageData bytes (R, G, B, A in memory), so a canvas buffer
// can be handed to a PNG encoder or to new ImageData(...) as is. 0 means "nothing": fully transparent.
//
// The integer layout and hex / mix / scale / luma / ramp / fit / at are adapted from pixelfx (src/core/color.js,
// MIT) — see ../NOTICE.md. shade / tint and the office palette are pixelkit's own.

import { clamp } from "./math.js";

export const rgba = (r, g, b, a = 255) => (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
export const rgb = (r, g, b) => rgba(r, g, b, 255);
export const red = (c) => c & 255;
export const green = (c) => (c >>> 8) & 255;
export const blue = (c) => (c >>> 16) & 255;
export const alpha = (c) => c >>> 24;
/** The same color at another alpha (0..255). */
export const withAlpha = (c, a) => ((c & 0xffffff) | ((a & 255) << 24)) >>> 0;

/** "#rgb", "#rrggbb" or "#rrggbbaa" (or a color number, passed through) to a color number. */
export function hex(h) {
  if (typeof h === "number") return h >>> 0;
  let s = h.replace("#", "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s.slice(0, 6), 16), a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return rgba((v >> 16) & 255, (v >> 8) & 255, v & 255, a);
}
export const toHex = (c) => "#" + [red(c), green(c), blue(c)].map((v) => v.toString(16).padStart(2, "0")).join("");

/** Linear mix of two colors (alpha is kept from a). */
export function mix(a, b, t) {
  a = hex(a); b = hex(b); t = clamp(t);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return rgba(m(red(a), red(b)), m(green(a), green(b)), m(blue(a), blue(b)), alpha(a));
}
/** Multiply a color's brightness by k. */
export const scale = (c, k) => rgba(Math.min(255, red(c) * k), Math.min(255, green(c) * k), Math.min(255, blue(c) * k), alpha(c));
/** Perceived brightness 0..1. */
export const luma = (c) => (0.299 * red(c) + 0.587 * green(c) + 0.114 * blue(c)) / 255;
/** How far apart two colors look, 0 (same) .. about 1 (black against white). */
export function distance(a, b) {
  const dr = red(a) - red(b), dg = green(a) - green(b), db = blue(a) - blue(b), da = alpha(a) - alpha(b);
  return Math.sqrt((dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + da * da) / (255 * 255 * 2));
}

// Shadows lean towards a cool plum and highlights towards a warm cream, never towards black and white: that is
// what keeps the bright office look from going muddy.
const COOL = rgb(38, 26, 52), WARM = rgb(255, 250, 235);
/** A darker step of c. */
export const shade = (c, t = 0.22) => mix(c, COOL, t);
/** A lighter step of c. */
export const tint = (c, t = 0.25) => mix(c, WARM, t);
/** Three steps from one base color: { d: shadow, m: base, l: highlight }. */
export const steps = (c, d = 0.22, l = 0.28) => ({ d: shade(hex(c), d), m: hex(c), l: tint(hex(c), l) });

/** A list of hex strings (dark to bright) to color numbers. */
export const ramp = (list) => list.map(hex);
/** Resample a ramp to exactly n steps, keeping its ends. */
export function fit(r, n) {
  r = r.map(hex);
  if (r.length === n) return r;
  return Array.from({ length: n }, (_, i) => r[Math.round((i * (r.length - 1)) / Math.max(1, n - 1))]);
}
/** The ramp step for t in 0..1, no blending: pixel art picks a color, it does not fade between two. */
export const at = (r, t) => r[clamp(Math.floor(t * r.length), 0, r.length - 1)];

export const WHITE = hex("#ffffff");
/** The outline color: a soft plum-black. */
export const INK = hex("#352b3d");
/** A lighter line for inner edges and UI borders. */
export const LINE = hex("#6d6478");

// The office palette, each ramp dark to bright. Pale, warm and low in contrast on purpose.
export const PAL = {
  wood: ["#b98f5e", "#d3b07e", "#f0d6a8", "#f9e6c2"],
  cream: ["#d9cdb6", "#e9dfcb", "#f6f0e2", "#fffaf0"],
  paper: ["#aab2c2", "#d9dde6", "#f2f4f8", "#ffffff"],
  slate: ["#3b4257", "#565f7a", "#8790a8", "#b9bfcc"],
  mint: ["#4f9c8f", "#7fcdc2", "#a9e2d6", "#d6f4ec"],
  sky: ["#6fa8e0", "#9cc8f2", "#c4e0fa", "#e6f3ff"],
  dusk: ["#5b4a86", "#8a68b8", "#e08a9a", "#ffc79a"],
  night: ["#1c1f3a", "#272c52", "#343a6b", "#454c85"],
  coral: ["#c8553a", "#ef8a5b", "#f7b08a", "#fcd6bd"],
  sun: ["#d99a2b", "#f2c14e", "#f8da86", "#fdf0c4"],
  leaf: ["#3f8a5a", "#58b08a", "#8fd0a8", "#c8ecd0"],
  lilac: ["#6c5ab0", "#8a7fe0", "#b3abf0", "#dcd8fb"],
  rose: ["#c2567c", "#e86f9a", "#f4a3bf", "#fbd5e2"],
  brick: ["#b8705a", "#d68d74", "#eab09a", "#f6d3c4"],
};
/** The same ramps as color numbers. */
export const RAMP = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, ramp(v)]));
