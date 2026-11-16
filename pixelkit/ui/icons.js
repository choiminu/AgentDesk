// Menu icons, 16 x 16: flat shapes in two or three steps of one ramp, lit from the top-left, inside one ink
// outline. Each is drawn by a few lines of code, so a new one is a new entry in ICONS.

import { Canvas } from "../core/canvas.js";
import { RAMP, INK, WHITE } from "../core/color.js";

export const ICON = 16;

export const ICONS = {
  /** Settings: a cog. */
  gear(g) {
    const m = RAMP.slate;
    g.circle(7.5, 7.5, 4.6, m[2]);
    for (const [x, y] of [[7, 1], [7, 13], [1, 7], [13, 7], [3, 3], [11, 3], [3, 11], [11, 11]]) g.rect(x, y, 2, 2, m[2]);
    g.rect(7, 1, 2, 1, m[3]); g.rect(1, 7, 1, 2, m[3]); g.set(3, 3, m[3]); g.set(4, 3, m[3]); g.set(3, 4, m[3]);
    for (const [x, y] of [[5, 4], [6, 4], [4, 5], [4, 6], [5, 5]]) g.set(x, y, m[3]);
    g.rect(7, 13, 2, 2, m[1]); g.rect(13, 7, 2, 2, m[1]); g.rect(11, 11, 2, 2, m[1]);
    for (const [x, y] of [[10, 11], [11, 10], [9, 11], [11, 9], [10, 10]]) g.set(x, y, m[1]);
    g.clear(6, 6, 4, 4); g.rect(6, 6, 4, 4, m[1]); g.clear(7, 7, 2, 2);
  },
  /** A book: the skill book, docs, a guide. */
  book(g) {
    const c = RAMP.coral, p = RAMP.paper;
    g.rect(3, 2, 10, 10, c[1]);
    g.vline(3, 2, 13, c[0]); g.hline(2, 4, 12, c[2]);
    g.rect(4, 12, 9, 2, p[3]); g.hline(13, 4, 12, p[1]); g.set(12, 12, p[1]);
    g.rect(6, 5, 5, 1, c[3]); g.rect(6, 7, 3, 1, c[3]);
    g.vline(10, 11, 14, RAMP.sun[1]);
  },
  /** A sword: quests, a challenge. */
  sword(g) {
    const p = RAMP.paper, s = RAMP.sun, w = RAMP.wood;
    for (let i = 0; i < 8; i++) { g.set(13 - i, 2 + i, p[3]); g.set(12 - i, 2 + i, p[2]); g.set(13 - i, 3 + i, p[0]); }
    g.set(14, 1, p[3]); g.set(13, 1, p[2]); g.set(14, 2, p[0]);
    for (const [x, y] of [[3, 7], [4, 8], [5, 9], [6, 10], [7, 11], [8, 12]]) g.set(x, y, s[1]);
    for (const [x, y] of [[3, 8], [4, 9], [6, 11], [7, 12]]) g.set(x, y, s[0]);
    g.set(4, 11, w[1]); g.set(3, 12, w[1]); g.set(4, 12, w[0]); g.set(5, 10, w[1]); g.set(5, 11, w[0]);
    g.rect(1, 13, 2, 2, s[1]); g.set(2, 14, s[0]);
  },
  /** A bell: notifications. */
  bell(g) {
    const s = RAMP.sun;
    g.rect(7, 1, 2, 2, s[1]);
    [[6, 9], [5, 10], [4, 11], [4, 11], [4, 11], [4, 11], [3, 12], [2, 13]].forEach(([x0, x1], i) => g.hline(3 + i, x0, x1, i === 7 ? s[0] : s[1]));
    for (let y = 4; y <= 8; y++) g.set(y < 5 ? 6 : 5, y, s[3]);
    for (let y = 4; y <= 9; y++) g.set(y < 5 ? 10 : y < 9 ? 11 : 12, y, s[0]);
    g.rect(7, 12, 2, 2, RAMP.coral[1]); g.set(8, 13, RAMP.coral[0]);
  },
  /** Add. */
  plus(g) {
    const c = RAMP.leaf;
    g.rect(6, 2, 4, 12, c[1]); g.rect(2, 6, 12, 4, c[1]);
    g.hline(2, 6, 9, c[2]); g.hline(6, 2, 5, c[2]); g.hline(6, 10, 13, c[2]); g.vline(6, 3, 5, c[2]); g.vline(2, 7, 9, c[2]);
    g.hline(13, 6, 9, c[0]); g.hline(9, 2, 5, c[0]); g.hline(9, 10, 13, c[0]); g.vline(13, 6, 8, c[0]); g.vline(9, 10, 12, c[0]);
  },
  /** Close. */
  close(g) {
    const c = RAMP.coral;
    for (let i = 0; i < 10; i++)
      for (const [x, y] of [[3 + i, 3 + i], [12 - i, 3 + i]]) for (const dx of [-1, 0, 1]) g.set(x + dx, y, y >= 10 ? c[0] : c[1]);
    for (let i = 0; i < 3; i++) { g.set(2 + i, 3 + i, c[2]); g.set(11 + i, 3 - i + 2 - 2 + i, c[1]); }
    g.set(11, 3, c[2]); g.set(10, 4, c[2]);
  },
  /** Refresh: an arrow going round. */
  refresh(g) {
    const c = RAMP.sky, cx = 7.5, cy = 8.5;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= 5.6 && d >= 3.4 && !(x >= 9 && y <= 7)) g.set(x, y, x + y < 14 ? c[1] : c[0]);
      }
    for (let i = 0; i < 4; i++) g.vline(9 + i, 1 + i, 7 - i, i === 3 ? c[0] : c[1]);   // the arrow's head
    g.hline(1, 9, 9, c[2]); g.set(10, 2, c[2]);
    g.hline(3, 5, 8, c[2]); g.set(4, 4, c[2]); g.set(3, 5, c[2]); g.set(2, 6, c[2]); g.set(2, 7, c[2]);
  },
  /** Play, start, run. */
  play(g) {
    const c = RAMP.mint;
    for (let y = 2; y <= 13; y++) {
      const d = Math.min(y - 2, 13 - y), x1 = 5 + Math.round(d * 1.6);
      g.hline(y, 4, x1, c[1]); g.set(4, y, c[2]);
      if (y > 7) g.set(x1, y, c[0]);
      if (y <= 7 && d > 0) g.set(x1, y, c[2]);
    }
    g.hline(13, 4, 5, c[0]);
  },
  /** Done, saved, approved. */
  check(g) {
    const c = RAMP.leaf;
    const stroke = (x0, y0, x1, y1) => { for (const dy of [-1, 0, 1]) g.line(x0, y0 + dy, x1, y1 + dy, dy < 0 ? c[2] : dy > 0 ? c[0] : c[1]); };
    stroke(3, 8, 6, 11); stroke(6, 11, 12, 5);
  },
  /** A folder: a project, files. */
  folder(g) {
    const s = RAMP.sun;
    g.rect(2, 3, 5, 2, s[0]); g.rect(2, 5, 12, 8, s[0]);
    g.rect(2, 7, 12, 6, s[1]); g.hline(7, 2, 13, s[3]); g.hline(12, 2, 13, s[0]);
    g.rect(8, 4, 5, 2, RAMP.paper[3]); g.hline(6, 8, 12, RAMP.paper[1]);
  },
  /** Search. */
  search(g) {
    const m = RAMP.slate, k = RAMP.sky;
    g.circle(6, 6, 4.3, m[2]); g.circle(6, 6, 2.9, k[2]);
    g.set(5, 4, WHITE); g.set(4, 5, WHITE);
    g.ring(6, 6, 4.3, m[2]); g.set(3, 3, m[3]); g.set(4, 2, m[3]); g.set(2, 4, m[3]);
    for (let i = 0; i < 4; i++) { g.set(10 + i, 10 + i, RAMP.wood[1]); g.set(9 + i, 10 + i, RAMP.wood[0]); g.set(10 + i, 9 + i, RAMP.wood[2]); }
  },
  /** A heart: a favourite, a life. */
  heart(g) {
    const c = RAMP.rose;
    [[3, 5, 9, 11], [2, 6, 8, 12], [2, 13], [2, 13], [3, 12], [4, 11], [5, 10], [6, 9], [7, 8]].forEach((r, i) => {
      for (let k = 0; k < r.length; k += 2) g.hline(3 + i, r[k], r[k + 1], c[1]);
    });
    g.set(4, 4, c[3]); g.set(3, 5, c[3]); g.set(4, 5, c[2]); g.set(3, 4, c[2]);
    for (const [x, y] of [[12, 6], [12, 7], [11, 8], [10, 9], [9, 10], [8, 11], [13, 6], [12, 5], [13, 5]]) g.set(x, y, c[0]);
  },
};
export const ICON_NAMES = Object.keys(ICONS);

/** One icon as a 16 x 16 canvas. */
export function icon(name) {
  if (!ICONS[name]) throw new Error(`ui: unknown icon "${name}"`);
  const g = new Canvas(ICON, ICON);
  ICONS[name](g);
  return g.outline(INK);
}
