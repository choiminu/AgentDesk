// The checks, as plain functions over a canvas, so the tests can call them one by one. Each finds a mistake eyes
// miss on a contact sheet: a size that is off by a pixel, a color that crept in, a stray dot, art cut off at
// the frame, a tile that does not meet itself, randomness without a seed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { alpha, INK } from "../../core/index.js";
import { seamReport, joinReport } from "../../tile/seam.js";

/** Size problems: [] when c is exactly spec.size and a whole number of spec.frame frames. */
export function sizeProblems(c, { size, frame } = {}) {
  const out = [];
  if (size && (c.w !== size[0] || c.h !== size[1])) out.push(`size is ${c.w} x ${c.h}, expected ${size[0]} x ${size[1]}`);
  if (frame && (c.w % frame[0] || c.h % frame[1])) out.push(`${c.w} x ${c.h} is not a whole number of ${frame[0]} x ${frame[1]} frames`);
  return out;
}

/** How many distinct colors are used (empty pixels left out). */
export const colorCount = (c) => c.colors().size;

// the 8 neighbours of (x, y) that pass a test
function around(c, x, y, test) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && test(c.get(x + dx, y + dy))) return true;
  return false;
}
/** Stray pixels: drawn pixels with nothing drawn around them at all — a dot floating in the air. [[x, y], ...] */
export function strays(c) {
  const out = [];
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (c.get(x, y) && !around(c, x, y, (n) => n !== 0)) out.push([x, y]);
  return out;
}
/**
 * Lone pixels: drawn pixels none of whose 8 neighbours has the same color. One is a detail (an eye glint, a
 * button); many are speckle. opts: { wrapX, wrapY }: for a tile, look around the edge to the other side, since
 * that is its neighbour once it repeats. [[x, y], ...]
 */
export function lonePixels(c, { wrapX = false, wrapY = false } = {}) {
  const at = (x, y) => c.get(wrapX ? (x + c.w) % c.w : x, wrapY ? (y + c.h) % c.h : y), out = [];
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const p = c.get(x, y);
      if (!p) continue;
      let twin = false;
      for (let dy = -1; dy <= 1 && !twin; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(x + dx, y + dy) === p) { twin = true; break; }
      if (!twin) out.push([x, y]);
    }
  return out;
}
/** How many pixels are neither empty nor fully opaque. */
export function softPixels(c) {
  let n = 0;
  for (const p of c.data) if (p && alpha(p) !== 255) n++;
  return n;
}
/** How many pixels are empty. */
export function emptyPixels(c) {
  let n = 0;
  for (const p of c.data) if (!p) n++;
  return n;
}
/**
 * Art cut off at the edge: drawn pixels on the border of the canvas (or of each frame) that are not the outline
 * color. An outlined sprite that fits shows only ink there; anything else means the drawing ran out of room.
 * With margin > 0, anything at all within that many pixels of the edge counts. [[x, y], ...]
 */
export function clipped(c, { frame, ink = INK, margin = 0 } = {}) {
  const fw = frame?.[0] ?? c.w, fh = frame?.[1] ?? c.h, out = [];
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const p = c.get(x, y);
      if (!p) continue;
      const e = Math.min(x % fw, fw - 1 - (x % fw), y % fh, fh - 1 - (y % fh));
      if (e < margin || (e === 0 && p !== ink)) out.push([x, y]);
    }
  return out;
}

const RANDOM = new RegExp("Math\\s*\\.\\s*ran" + "dom");
/** Source files under dir (.js, .mjs) that call the unseeded generator: [{ file, line }]. */
export function unseeded(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) { if (name !== "records" && name !== "node_modules") walk(f); continue; }
      if (!/\.m?js$/.test(name)) continue;
      readFileSync(f, "utf8").split("\n").forEach((text, i) => { if (RANDOM.test(text)) out.push({ file: relative(dir, f), line: i + 1 }); });
    }
  };
  walk(dir);
  return out;
}
/** The same test on a piece of source text. */
export const usesUnseeded = (source) => RANDOM.test(source);

/**
 * Run every check an item's spec asks for. item: { id, draw, spec }; byId: id -> item, for joins.
 * spec: { size, frame, maxColors, maxLone, opaque, soft (translucent pixels are meant), clip (outlined sprite:
 * nothing but ink on the frame's border), margin, tile: { x, y }, joins: [{ with: id, side: "right" | "below" }] }.
 * Returns { errors: [...], notes: [...] }.
 */
export function checkItem(item, byId = new Map()) {
  const errors = [], notes = [], spec = item.spec ?? {};
  let c;
  try { c = item.draw(); } catch (e) { return { errors: [`does not draw: ${e.message}`], notes }; }
  if (!item.draw().equals(c)) errors.push("not deterministic: drawing it twice gave two pictures");
  errors.push(...sizeProblems(c, spec));
  if (!c.colors().size) errors.push("draws nothing");
  const n = colorCount(c);
  if (spec.maxColors && n > spec.maxColors) errors.push(`${n} colors, the limit is ${spec.maxColors}`);
  const soft = softPixels(c);
  if (soft && !spec.soft) errors.push(`${soft} translucent pixels: pixel art is opaque (dither instead, or set soft)`);
  const st = strays(c);
  if (st.length) errors.push(`${st.length} stray pixel${st.length > 1 ? "s" : ""} floating alone, first at ${st[0].join(", ")}`);
  const lone = lonePixels(c, { wrapX: !!spec.tile?.x, wrapY: !!spec.tile?.y }).filter(([x, y]) => !st.some(([sx, sy]) => sx === x && sy === y)).length;
  if (spec.maxLone !== undefined && lone > spec.maxLone) notes.push(`${lone} lone pixels (the budget is ${spec.maxLone}): speckle — group them or drop them`);
  if (spec.opaque && emptyPixels(c)) errors.push(`${emptyPixels(c)} empty pixels in a piece that should be solid`);
  if (spec.clip || spec.margin) {
    const cut = clipped(c, { frame: spec.frame, margin: spec.margin ?? 0 });
    if (cut.length) errors.push(`${cut.length} pixels cut off at the frame's edge, first at ${cut[0].join(", ")}`);
  }
  if (spec.tile) {
    const r = seamReport(c, { x: !!spec.tile.x, y: !!spec.tile.y });
    for (const axis of ["x", "y"]) if (r[axis] && !r[axis].ok) errors.push(`seam when repeated ${axis === "x" ? "left to right" : "top to bottom"}: ${r[axis].seam} pixels change across the edge, ${r[axis].inner} at most inside`);
  }
  for (const j of spec.joins ?? []) {
    const other = byId.get(j.with);
    if (!other) { errors.push(`joins "${j.with}", which is not in the catalog`); continue; }
    const r = joinReport(c, other.draw(), j.side ?? "right");
    if (!r.ok) errors.push(`does not meet ${j.with} (${j.side ?? "right"}): ${r.why ?? `${r.seam} pixels change across the joint, ${r.inner} at most inside`}`);
  }
  return { errors, notes };
}
