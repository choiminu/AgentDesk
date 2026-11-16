// Everything pixelkit draws, in one list, so the tools have the same view of it: render.mjs lays items out on a
// contact sheet and check.mjs holds each one to its spec. Add a drawing here and both tools pick it up.
//
// An item: { id, group: "char" | "tile" | "ui", draw: () => Canvas (the asset itself), show?: () => Canvas (how
// to look at it — a tile repeated, pieces put together), zoom?, bg?, br?, spec: what check.mjs holds it to
// (see tools/lib/checks.mjs) }.

import { Canvas, hex, mix } from "./core/index.js";
import * as C from "./char/index.js";
import * as T from "./tile/index.js";
import * as U from "./ui/index.js";

const items = [];
const add = (item) => items.push(item);

// ── characters: the base sheet and the three extra actions for every preset ──
const CHAR_SPEC = { frame: [C.FRAME.w, C.FRAME.h], maxColors: 26, clip: true };
for (const [name, preset] of Object.entries(C.PRESETS)) {
  add({ id: `char/${name}`, group: "char", zoom: 3, draw: () => C.baseSheet(preset), spec: { ...CHAR_SPEC, size: [112, 96], maxLone: 150 } });
  for (const [action, poses] of Object.entries(C.ACTIONS))
    add({ id: `char/${name}-${action}`, group: "char", zoom: 3, draw: () => C.actionSheet(preset, action), spec: { ...CHAR_SPEC, size: [poses.length * 16, 96], maxLone: 22 * poses.length } });
}

// ── tiles ──
for (const kind of Object.keys(T.FLOORS))
  add({ id: `floor/${kind}`, group: "tile", zoom: 3, draw: () => T.floor(kind), show: () => T.tiled(T.floor(kind), 4, 3), spec: { size: [16, 16], opaque: true, maxColors: 8, maxLone: 8, tile: { x: true, y: true } } });
items[items.length - 1].br = true;
const WALL_COLORS = { plain: "#f3e6cf", panel: "#cfe6dc", brick: "#f0cdbb" };
for (const kind of Object.keys(T.WALLS))
  add({ id: `wall/${kind}`, group: "tile", zoom: 3, draw: () => T.wall(kind, { color: WALL_COLORS[kind] }), show: () => T.tiled(T.wall(kind, { color: WALL_COLORS[kind] }), 4, 1), spec: { size: [16, 32], opaque: true, maxColors: 10, maxLone: 0, tile: { x: true } } });
add({
  id: "wall/window", group: "tile", zoom: 3, br: true, draw: () => T.wallWindow(),
  show: () => new Canvas(64, 32).paste(T.wall("plain"), 0, 0).paste(T.wallWindow(), 16, 0).paste(T.wall("plain"), 48, 0),
  spec: { size: [32, 32], opaque: true, maxColors: 14, maxLone: 2, joins: [{ with: "wall/plain", side: "right" }] },
});
for (const kind of ["sky", "dusk", "night"])
  add({ id: `sky/${kind}`, group: "tile", zoom: 2, draw: () => T.sky(kind), show: () => T.tiled(T.sky(kind), 3, 1), spec: { size: [32, 64], opaque: true, maxColors: 6, maxLone: kind === "night" ? 40 : 0, tile: { x: true } } });
add({ id: "sky/cloud", group: "tile", zoom: 3, bg: "#9cc8f2", draw: () => T.cloud({ w: 28, seed: 2 }), spec: { size: [28, 12], maxColors: 2, maxLone: 0 } });
add({ id: "sky/cloud-wide", group: "tile", zoom: 3, bg: "#9cc8f2", draw: () => T.cloud({ w: 40, seed: 9 }), spec: { size: [40, 17], maxColors: 2, maxLone: 0 } });
add({ id: "sky/skyline", group: "tile", zoom: 3, bg: "#c4e0fa", br: true, draw: () => T.skyline({ seed: 3 }), show: () => T.tiled(T.skyline({ seed: 3 }), 2, 1), spec: { size: [64, 24], maxColors: 2, maxLone: 0, tile: { x: true } } });
add({ id: "build/facade", group: "tile", zoom: 3, draw: () => T.facade(), show: () => T.tiled(T.facade(), 3, 2), spec: { size: [16, 16], opaque: true, maxColors: 3, maxLone: 0, tile: { x: true, y: true } } });
for (const lit of [false, true])
  add({ id: `build/window${lit ? "-lit" : ""}`, group: "tile", zoom: 3, draw: () => T.windowPiece({ lit }), spec: { size: [16, 16], opaque: true, maxColors: 8, maxLone: 2, tile: { x: true, y: true }, joins: [{ with: "build/facade", side: "right" }, { with: "build/facade", side: "below" }] } });
add({ id: "build/roof", group: "tile", zoom: 3, draw: () => T.roofPiece(), show: () => T.tiled(T.roofPiece(), 3, 1), spec: { size: [16, 16], opaque: true, maxColors: 6, maxLone: 0, tile: { x: true } } });
add({ id: "build/awning", group: "tile", zoom: 3, draw: () => T.awningPiece(), show: () => T.tiled(T.awningPiece(), 3, 1), spec: { size: [16, 16], opaque: true, maxColors: 10, maxLone: 0, tile: { x: true }, joins: [{ with: "build/facade", side: "below" }] } });
add({ id: "build/door", group: "tile", zoom: 3, br: true, draw: () => T.doorPiece(), spec: { size: [16, 32], opaque: true, maxColors: 14, maxLone: 2, tile: { x: true } } });
const HOUSES = [
  { seed: 1 },
  { seed: 4, cols: 3, floors: 1, color: "sky", roof: "slate", stripe: "sun", door: "wood" },
  { seed: 9, cols: 5, floors: 3, color: "rose", roof: "lilac", stripe: "coral", door: "leaf", lit: 0.6 },
];
HOUSES.forEach((o, i) => add({ id: `build/house-${i + 1}`, group: "tile", zoom: 2, draw: () => T.building(o), spec: { size: [(o.cols ?? 4) * 16 + 2, 16 + (o.floors ?? 2) * 16 + 34], maxColors: 32, clip: true } }));

// two scenes that put the three groups side by side: do they look like one world?
function street() {
  const g = new Canvas(256, 144);
  g.paste(T.tiled(T.sky("sky", { h: 96 }), 8, 1), 0, 0);
  g.blit(T.cloud({ w: 40, seed: 9 }), 20, 10).blit(T.cloud({ w: 28, seed: 2 }), 150, 26).blit(T.cloud({ w: 18, seed: 5 }), 216, 8);
  g.blit(T.tiled(T.skyline({ seed: 3 }), 4, 1), 0, 72);
  g.paste(T.tiled(T.floor("grass"), 16, 1), 0, 96).paste(T.tiled(T.floor("pavement"), 16, 2), 0, 112);
  let x = 6;
  for (const o of [HOUSES[1], HOUSES[0], HOUSES[2]]) { const b = T.building({ ...o, floors: Math.min(o.floors ?? 2, 2) }); g.blit(b, x, 112 - b.h + 1); x += b.w + 12; }
  const walker = (name, pose, px, py, flip) => g.blit(C.frame(C.PRESETS[name], "side", pose), px, py, { flip });
  walker("rose", "umbrellaA", 40, 106); walker("cloud", "carryB", 96, 108, true); walker("mint", "jumpC", 150, 102); walker("lilac", "walkA", 200, 108, true);
  return g;
}
function office() {
  const g = new Canvas(192, 128);
  for (let x = 0; x < 192; x += 16) g.paste(T.wall("plain"), x, 0);
  g.paste(T.wallWindow(), 32, 0).paste(T.wallWindow({ sky: "dusk" }), 112, 0);
  g.paste(T.tiled(T.floor("plank"), 12, 3), 0, 32).paste(T.tiled(T.floor("carpet"), 5, 2), 96, 48);
  g.paste(T.tiled(T.floor("plank"), 12, 3), 0, 80);
  const put = (name, view, pose, x, y, flip) => g.blit(C.frame(C.PRESETS[name], view, pose), x, y, { flip });
  put("sky", "down", "stand", 12, 30); put("coral", "side", "walkA", 44, 38); put("sun", "down", "carryA", 76, 44);
  put("berry", "up", "walkB", 104, 34); put("moss", "side", "carryB", 136, 48, true); put("amber", "down", "jumpB", 164, 36);
  g.blit(U.panel("window", 84, 40, { title: "TODAY" }), 6, 84);
  g.blit(U.button("normal", 34, 16, { label: "OPEN" }), 12, 102).blit(U.button("pressed", 34, 16, { color: "sun", label: "SAVE" }), 50, 102);
  g.blit(U.panel("dark", 92, 28), 96, 92);
  ["gear", "book", "sword", "bell"].forEach((n, i) => g.blit(U.button(i === 1 ? "raised" : "normal", 20, 20, { color: "cream", icon: U.icon(n) }), 100 + i * 21, 96));
  return g;
}
add({ id: "scene/street", group: "tile", zoom: 3, br: true, draw: street, spec: { size: [256, 144] } });
add({ id: "scene/office", group: "ui", zoom: 3, br: true, draw: office, spec: { size: [192, 128] } });

// ── menu UI ──
U.ICON_NAMES.forEach((name, i) => add({ id: `icon/${name}`, group: "ui", zoom: 6, br: i === U.ICON_NAMES.length - 1, draw: () => U.icon(name), spec: { size: [16, 16], maxColors: 8, maxLone: 6, clip: true } }));
function iconRow() {
  const g = new Canvas(U.ICON_NAMES.length * 18 + 2, 20);
  U.ICON_NAMES.forEach((n, i) => g.blit(U.icon(n), 2 + i * 18, 2));
  return g;
}
add({ id: "icon/all-x1", group: "ui", zoom: 1, bg: "#fffaf0", draw: iconRow, spec: {} });
add({ id: "icon/all-x2", group: "ui", zoom: 2, bg: "#fffaf0", draw: iconRow, spec: {} });
add({ id: "icon/all-dark", group: "ui", zoom: 2, bg: "#3b4257", br: true, draw: iconRow, spec: {} });
for (const style of Object.keys(U.PANELS)) add({ id: `panel/${style}-source`, group: "ui", zoom: 4, draw: () => U.panelSource(style), spec: { size: [24, 24], maxColors: 8, maxLone: 2 } });
add({ id: "panel/paper-72x44", group: "ui", zoom: 3, draw: () => U.panel("paper", 72, 44), spec: { size: [72, 44] } });
add({ id: "panel/window-96x56", group: "ui", zoom: 3, draw: () => U.panel("window", 96, 56, { title: "SETTINGS" }), spec: { size: [96, 56] } });
add({ id: "panel/dark-60x22", group: "ui", zoom: 3, draw: () => U.panel("dark", 60, 22), spec: { size: [60, 22] } });
add({ id: "panel/note-44x44", group: "ui", zoom: 3, br: true, draw: () => U.panel("note", 44, 44), spec: { size: [44, 44] } });
for (const state of U.BUTTON_STATES) add({ id: `button/${state}-source`, group: "ui", zoom: 5, draw: () => U.buttonSource(state), spec: { size: [16, 16], maxColors: 6, maxLone: 0 } });
for (const color of ["mint", "sun", "coral", "lilac"])
  for (const state of U.BUTTON_STATES) add({ id: `button/${color}-${state}`, group: "ui", zoom: 4, br: color === "lilac" && state === "pressed", draw: () => U.button(state, color === "lilac" ? 64 : 40, color === "lilac" ? 20 : 16, { color, label: color === "lilac" ? "NEW SESSION" : state === "pressed" ? "OK!" : "OK" }), spec: {} });
for (const state of U.BUTTON_STATES) add({ id: `button/icon-${state}`, group: "ui", zoom: 4, draw: () => U.button(state, 22, 22, { color: "cream", icon: U.icon("gear") }), spec: { size: [22, 22] } });

// ── the dock's street: the pieces the app loads, and the scenes they make when it stacks them ──
const NAMES = Object.keys(C.PRESETS);
const D = "dock-street";
// what the dock shows of a character: the facing-down row through a 16 x 28 window (the top 4 px cut off)
const dockSprite = (name, pose = "walkA") => C.frame(C.PRESETS[name], "down", pose).crop(0, 4, 16, 28);
// a tint over everything but the lights, to see what a night filter in the app would leave readable
function dimmed(c, lit, k) {
  const out = c.clone(), night = hex("#141a3d");
  for (let i = 0; i < out.data.length; i++) if (out.data[i] && out.data[i] === lit.data[i] ? false : out.data[i]) out.data[i] = mix(out.data[i], night, k);
  return out;
}
function dockScene(kind, dim = 0) {
  const g = new Canvas(T.STREET.w, T.STREET.h), day = T.street(), lit = T.street({ lit: true }), on = kind !== "day";
  g.paste(T.tiled(T.streetSky(kind), T.STREET.w / T.STREET.skyW, 1), 0, 0);
  if (kind !== "night") { g.blit(T.streetCloud(), 236, 6); g.blit(T.streetCloud().flipX(), 470, 2); }
  // the lit strip minus the day strip is exactly the lights; tint the rest
  const front = !on ? day : dim ? (() => { const f = dimmed(day, new Canvas(day.w, day.h), dim); for (let i = 0; i < f.data.length; i++) if (lit.data[i] !== day.data[i]) f.data[i] = lit.data[i]; return f; })() : lit;
  g.blit(front);
  for (const x of [112, 240, 368, 496]) g.blit(T.streetLamp({ lit: on }), x - 8, 44 - 35);
  const cast = [["sky", "walkA", "API"], ["coral", "typeA", "DOCS"], ["rose", "umbrellaA", "WEB"], ["mint", "jumpC", "TEST"], ["cloud", "carryA", "OPS"], ["lilac", "stand", "UI"]];
  cast.forEach(([name, pose, tag], i) => {
    const x = 40 + i * 84;
    g.blit(dockSprite(name, pose), x, T.STREET.feet - 25);                    // the shoes' row lands on y 46
    for (let yy = 50; yy < 58; yy++) for (let xx = x - 7; xx < x + 23; xx++) g.blend(xx, yy, hex("#0a0c14a0"));   // a name tag like the dock's
    g.text(tag, x + 8, 52, hex("#eef1f6"), { align: "center" });
  });
  return g;
}
function dockChars(pose, plate) {
  const g = new Canvas(NAMES.length * 20 + 4, 32, hex(plate));
  NAMES.forEach((n, i) => g.blit(dockSprite(n, pose), 4 + i * 20, 2));
  return g;
}
add({ id: `${D}/scene-day`, group: D, zoom: 2, br: true, draw: () => dockScene("day"), spec: { size: [512, 72] } });
add({ id: `${D}/scene-dusk`, group: D, zoom: 2, br: true, draw: () => dockScene("dusk"), spec: { size: [512, 72], soft: true } });
add({ id: `${D}/scene-night`, group: D, zoom: 2, br: true, draw: () => dockScene("night"), spec: { size: [512, 72], soft: true } });
add({ id: `${D}/scene-night-tinted`, group: D, zoom: 2, br: true, draw: () => dockScene("night", 0.45), spec: { size: [512, 72], soft: true } });
add({ id: `${D}/scene-day-x1`, group: D, zoom: 1, draw: () => dockScene("day"), spec: {} });
add({ id: `${D}/scene-night-x1`, group: D, zoom: 1, br: true, draw: () => dockScene("night"), spec: { soft: true } });
for (const kind of ["day", "dusk", "night"])
  add({ id: `${D}/sky-${kind}`, group: D, zoom: 2, draw: () => T.streetSky(kind), show: () => T.tiled(T.streetSky(kind), 3, 1), spec: { size: [64, 72], opaque: true, maxColors: 6, maxLone: kind === "night" ? 12 : 0, tile: { x: true } } });
add({ id: `${D}/lamp`, group: D, zoom: 4, draw: () => T.streetLamp(), spec: { size: [16, 36], maxColors: 8, maxLone: 2, clip: true } });
add({ id: `${D}/lamp-lit`, group: D, zoom: 4, bg: "#1c2350", draw: () => T.streetLamp({ lit: true }), spec: { size: [16, 36], maxColors: 10, soft: true } });
add({ id: `${D}/cloud`, group: D, zoom: 4, bg: "#93c8f4", br: true, draw: () => T.streetCloud(), spec: { size: [36, 15], maxColors: 2, maxLone: 0 } });
add({ id: `${D}/front`, group: D, zoom: 3, br: true, bg: "#93c8f4", draw: () => T.street(), spec: { size: [512, 72], maxColors: 110, maxLone: 70, tile: { x: true } } });
add({ id: `${D}/front-lit`, group: D, zoom: 3, br: true, bg: "#1c2350", draw: () => T.street({ lit: true }), spec: { size: [512, 72], maxColors: 110, maxLone: 70, tile: { x: true } } });
for (const [pose, plate] of [["walkA", "#2a2f3f"], ["typeA", "#2a2f3f"], ["walkA", "#ece9e3"]])
  for (const zoom of [1, 2, 4]) add({ id: `${D}/chars-${pose}-${plate === "#ece9e3" ? "pale" : "dark"}-x${zoom}`, group: D, zoom, br: zoom === 4, draw: () => dockChars(pose, plate), spec: {} });

export const CATALOG = items;
export const GROUPS = ["char", "tile", "ui", D];
export const byId = new Map(items.map((it) => [it.id, it]));

/** Items matching patterns: a group ("char"), an id ("floor/plank"), a prefix ("floor") or a glob ("icon/*"). */
export function select(patterns) {
  if (!patterns.length) return items;
  const out = new Set();
  for (const p of patterns) {
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    const hits = items.filter((it) => it.group === p || it.id === p || it.id.startsWith(p + "/") || re.test(it.id));
    if (!hits.length) throw new Error(`nothing in the catalog matches "${p}"`);
    hits.forEach((h) => out.add(h));
  }
  return items.filter((it) => out.has(it));
}
