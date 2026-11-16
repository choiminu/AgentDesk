// Numbers and seeded randomness. Everything here is pure: the same inputs always give the same output, so a
// drawing made from a seed is the same drawing every time. Nothing in pixelkit may call the platform's
// unseeded generator (tools/check.mjs enforces it).
//
// hash, rand, Rng and tileNoise are adapted from pixelfx (src/core/math.js, MIT) — see ../NOTICE.md.

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap = (x, m) => ((x % m) + m) % m;

/** 32-bit integer hash of any number of integers. */
export function hash(...ns) {
  let h = 0x9e3779b9;
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}
/** Deterministic number in [0, 1) from integers (seed, x, y, which value ...). */
export const rand = (...ns) => hash(...ns) / 4294967296;

/** Text to a seed, so a drawing can be seeded by its name. */
export function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Seeded generator (mulberry32). */
export class Rng {
  constructor(seed = 1) { this.s = (typeof seed === "string" ? seedOf(seed) : seed >>> 0) || 1; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  /** Whole number in a..b, both included. */
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  pick(list) { return list[Math.floor(this.next() * list.length)]; }
}

/**
 * 2D value noise in [-1, 1] whose lattice repeats every px cells across and py cells down (0: no repeat).
 * A texture sampled from it over exactly one period has no seam when it is laid next to itself.
 */
export function tileNoise(x, y, px = 0, py = 0, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = px ? wrap(ix, px) : ix, x1 = px ? wrap(ix + 1, px) : ix + 1;
  const y0 = py ? wrap(iy, py) : iy, y1 = py ? wrap(iy + 1, py) : iy + 1;
  const a = rand(x0, y0, seed), b = rand(x1, y0, seed), c = rand(x0, y1, seed), d = rand(x1, y1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}
