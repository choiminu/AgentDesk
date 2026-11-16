// The canvas: one buffer of colors, w x h, where 0 is "nothing". Pixels are opaque by default and are never
// blended: a fade is an ordered dither (a 4 x 4 grid of thresholds), which is what keeps the result pixel art.
// All coordinates are whole pixels; (0, 0) is the top-left.
//
// The Bayer thresholds, the dithered write and the string-sprite idea are adapted from pixelfx
// (src/core/painter.js, MIT) — see ../NOTICE.md. The rest is pixelkit's own.

import { hex, alpha, red, green, blue, rgba, INK } from "./color.js";
import { rasterText, textWidth, FONT_H } from "./font.js";

// 4 x 4 ordered thresholds: a pixel at coverage a is drawn when a is above its cell's threshold.
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const call = (v, ...args) => (typeof v === "function" ? v(...args) : v);
const col = (c) => (typeof c === "string" ? hex(c) : c >>> 0);

export class Canvas {
  constructor(w, h, fill = 0) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`bad canvas size ${w} x ${h}`);
    this.w = w; this.h = h; this.data = new Uint32Array(w * h);
    if (fill) this.data.fill(col(fill));
  }

  // ---- single pixels
  inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  /** The color at (x, y); 0 when empty or outside. */
  get(x, y) { return this.inside(x, y) ? this.data[y * this.w + x] : 0; }
  /** One pixel. A color of 0 draws nothing: it never erases what is there (use clear for that). */
  set(x, y, c) {
    if (!c || !this.inside(x, y)) return this;
    this.data[y * this.w + x] = col(c);
    return this;
  }
  /** One pixel at coverage a (0..1), kept or dropped by the 4 x 4 dither grid. */
  dot(x, y, c, a = 1) {
    if (a >= 1 || a > BAYER[((y & 3) << 2) | (x & 3)]) this.set(x, y, c);
    return this;
  }
  /** Blend a translucent color over what is there (soft shadows under furniture). The one non-pixel-art write. */
  blend(x, y, c) {
    if (!this.inside(x, y)) return this;
    c = col(c);
    const sa = alpha(c) / 255, d = this.data[y * this.w + x], da = alpha(d) / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return this;
    const ch = (s, t) => Math.round((s * sa + t * da * (1 - sa)) / oa);
    this.data[y * this.w + x] = rgba(ch(red(c), red(d)), ch(green(c), green(d)), ch(blue(c), blue(d)), Math.round(oa * 255));
    return this;
  }
  clear(x = 0, y = 0, w = this.w, h = this.h) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.data[j * this.w + i] = 0;
    return this;
  }

  // ---- shapes
  /** Row y from x0 to x1, both included. */
  hline(y, x0, x1, c) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, c); return this; }
  /** Column x from y0 to y1, both included. */
  vline(x, y0, y1, c) { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, c); return this; }
  /** 1 px line between two pixels, both included. */
  line(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return this;
  }
  /** Filled rectangle. a < 1 dithers it; a may be a function of (u, v), each 0..1 across the rectangle. */
  rect(x, y, w, h, c, a = 1) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = typeof a === "function" ? a(w > 1 ? i / (w - 1) : 0, h > 1 ? j / (h - 1) : 0) : a;
        this.dot(x + i, y + j, call(c, i, j), k);
      }
    return this;
  }
  /** The 1 px border of a rectangle. */
  frame(x, y, w, h, c) {
    this.hline(y, x, x + w - 1, c).hline(y + h - 1, x, x + w - 1, c);
    return this.vline(x, y, y + h - 1, c).vline(x + w - 1, y, y + h - 1, c);
  }
  /** Rectangle with its four corner pixels left out (r = 1) or cut in a small step (r = 2). */
  roundRect(x, y, w, h, c, r = 1) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const ex = Math.min(i, w - 1 - i), ey = Math.min(j, h - 1 - j);
        if (ex + ey < r) continue;
        this.set(x + i, y + j, call(c, i, j));
      }
    return this;
  }
  /** Filled disc: every pixel whose center is within r of the center of pixel (cx, cy). r may end in .5. */
  circle(cx, cy, r, c, a = 1) { return this.ellipse(cx, cy, r, r, c, a); }
  /** Filled ellipse. */
  ellipse(cx, cy, rx, ry, c, a = 1) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / (rx || 1), dy = (y - cy) / (ry || 1);
        if (dx * dx + dy * dy <= 1.0001) this.dot(x, y, call(c, x - cx, y - cy), a);
      }
    return this;
  }
  /** 1 px circle line: the rim of circle(cx, cy, r). */
  ring(cx, cy, r, c) {
    const inDisc = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.0001;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if (inDisc(x, y) && !(inDisc(x - 1, y) && inDisc(x + 1, y) && inDisc(x, y - 1) && inDisc(x, y + 1))) this.set(x, y, c);
    return this;
  }
  /**
   * Bands of a ramp (dark to bright or any order) down a rectangle (dir "v") or across it ("h"), with a dithered
   * transition of `soft` pixels between neighbours. No blending: every pixel is one of the ramp's colors.
   */
  bands(x, y, w, h, ramp, { dir = "v", soft = 2 } = {}) {
    const n = ramp.length, len = dir === "v" ? h : w;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const p = ((dir === "v" ? j : i) + 0.5) / len * n, k = Math.min(n - 1, Math.floor(p)), into = (p - k) * (len / n);
        let c = ramp[k];
        // near the start of a band, let the previous color show through the dither grid
        if (k > 0 && soft > 0 && into < soft && 1 - (into + 0.5) / (soft + 1) > BAYER[(((y + j) & 3) << 2) | ((x + i) & 3)]) c = ramp[k - 1];
        this.set(x + i, y + j, c);
      }
    return this;
  }

  // ---- outlines and sprites
  /**
   * A 1 px outline just outside whatever is drawn in the box (4 neighbours), kept inside the box.
   * With { corners: true } diagonal neighbours count too (a heavier, squarer line).
   */
  outline(c = INK, x0 = 0, y0 = 0, bw = this.w, bh = this.h, { corners = false } = {}) {
    const N = corners ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const add = [], x1 = Math.min(this.w, x0 + bw), y1 = Math.min(this.h, y0 + bh);
    for (let y = Math.max(0, y0); y < y1; y++)
      for (let x = Math.max(0, x0); x < x1; x++) {
        if (this.get(x, y)) continue;
        if (N.some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X >= x0 && X < x1 && Y >= y0 && Y < y1 && this.get(X, Y); })) add.push(x, y);
      }
    for (let i = 0; i < add.length; i += 2) this.set(add[i], add[i + 1], c);
    return this;
  }
  /**
   * A sprite from strings: rows like ["..##..", ".#oo#."], pal maps characters to colors ({ "#": "#352b3d" });
   * "." and " " are empty. Top-left at (x, y). opts: { flip: mirror left-right }.
   */
  sprite(rows, pal, x = 0, y = 0, opts = {}) {
    const W = Math.max(...rows.map((r) => r.length));
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === "." || ch === " ") return;
      if (pal[ch] === undefined) throw new Error(`sprite: no color for "${ch}"`);
      this.set(x + (opts.flip ? W - 1 - i : i), y + j, col(pal[ch]));
    }));
    return this;
  }
  /** Label text in the 3 x 5 font, top-left at (x, y). opts: { scale, align: "left" | "center" | "right" }. */
  text(str, x, y, c, opts = {}) {
    const k = opts.scale ?? 1, w = textWidth(str) * k;
    const left = opts.align === "center" ? Math.round(x - w / 2) : opts.align === "right" ? x - w : x;
    rasterText(str, (gx, gy) => this.rect(left + gx * k, y + gy * k, k, k, c));
    return this;
  }
  static textSize(str, scale = 1) { return [textWidth(str) * scale, FONT_H * scale]; }

  // ---- whole-canvas operations
  /** Paste another canvas with its top-left at (dx, dy). opts: { flip, sx, sy, sw, sh (a part of the source) }. */
  blit(src, dx = 0, dy = 0, opts = {}) {
    const sx = opts.sx ?? 0, sy = opts.sy ?? 0, sw = opts.sw ?? src.w - sx, sh = opts.sh ?? src.h - sy;
    for (let j = 0; j < sh; j++)
      for (let i = 0; i < sw; i++) {
        const c = src.get(sx + (opts.flip ? sw - 1 - i : i), sy + j);
        if (!c) continue;
        if (alpha(c) === 255) this.set(dx + i, dy + j, c); else this.blend(dx + i, dy + j, c);
      }
    return this;
  }
  /** A mirrored copy (left-right). */
  flipX() {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) out.data[y * this.w + x] = this.data[y * this.w + this.w - 1 - x];
    return out;
  }
  /** A copy of a part. */
  crop(x, y, w, h) { return new Canvas(w, h).paste(this, -x, -y); }
  /** Copy pixels as they are, empty ones included (blit skips those). */
  paste(src, dx = 0, dy = 0) {
    for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) if (this.inside(dx + i, dy + j)) this.data[(dy + j) * this.w + dx + i] = src.data[j * src.w + i];
    return this;
  }
  clone() { return new Canvas(this.w, this.h).paste(this); }
  /** Nearest-neighbour copy, k times bigger. */
  scaled(k) {
    const out = new Canvas(this.w * k, this.h * k);
    for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) out.data[y * out.w + x] = this.data[((y / k) | 0) * this.w + ((x / k) | 0)];
    return out;
  }
  /** Swap one color for another everywhere. */
  replace(from, to) {
    from = col(from); to = to ? col(to) : 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] === from) this.data[i] = to;
    return this;
  }
  /** The distinct colors used (empty pixels left out). */
  colors() { const s = new Set(this.data); s.delete(0); return s; }
  equals(o) { return o.w === this.w && o.h === this.h && this.data.every((c, i) => c === o.data[i]); }

  /** RGBA bytes (a copy), for a PNG or ImageData. Empty pixels are fully transparent black. */
  toRGBA() { return new Uint8Array(this.data.buffer.slice(0)); }
  static fromRGBA(w, h, bytes) {
    const c = new Canvas(w, h), b = new Uint8Array(c.data.buffer);
    b.set(bytes.subarray(0, w * h * 4));
    for (let i = 0; i < c.data.length; i++) if (!(c.data[i] >>> 24)) c.data[i] = 0;   // any fully transparent pixel is "nothing"
    return c;
  }
}

export const canvas = (w, h, fill) => new Canvas(w, h, fill);
