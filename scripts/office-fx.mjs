#!/usr/bin/env node
// Bakes the pixel office's effect sprite sheets (assets/pixel/fx/*.png) from a pixelfx checkout
// (https://github.com/patch-gg/pixelfx, MIT). Effects that shape themselves around a character (the blink's silhouette)
// get the office's own 16 x 32 character as their actor instead of pixelfx's stand-in, so the flash fits our sprites.
// The office's own effects (steam, rack lights, window sky) live in scripts/office-fx/ and are copied into the checkout
// as src/fx/office/ to be rendered with the same tools. Prints the OFFICE_FX table that widget.html keeps in sync.
//
//   node scripts/office-fx.mjs [path to pixelfx]      (default: $PIXELFX_DIR or ../pixelfx)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PFX = resolve(process.argv[2] || process.env.PIXELFX_DIR || join(ROOT, "..", "pixelfx"));
const OUT = join(ROOT, "assets", "pixel", "fx");
const lib = await import(pathToFileURL(join(PFX, "tools", "lib", "fxlib.mjs")).href);
const { rgb } = await import(pathToFileURL(join(PFX, "src", "core", "color.js")).href);

// key → effect, palette (dark → bright), whether it wraps our character, and whether it sits on the stand-in's head
// (pixelfx's 24 x 38 actor is 6 px taller than ours, so those draw 6 px lower: dy)
const HEAL = ["#08201a", "#0f3f2c", "#17663e", "#24924e", "#3ec466", "#7ee88a", "#c8ffc4", "#ffffff"];
const ELECTRIC = ["#0a0f2e", "#172a78", "#2550d0", "#3f8cff", "#7cc8ff", "#c8f0ff", "#ffffff"];
const EFFECTS = [
  { key: "collect", id: "pickups/collect-burst", file: "collect-burst", options: { palette: HEAL } },
  { key: "blinkIn", id: "arcane/blink-in", file: "blink-in", options: { palette: ELECTRIC }, actor: true },
  { key: "blinkOut", id: "arcane/blink-out", file: "blink-out", options: { palette: ELECTRIC }, actor: true },
  { key: "exclaim", id: "ui/exclamation", file: "exclamation", options: {}, head: true },
  { key: "sleep", id: "office/zzz", file: "zzz", options: {} },
  { key: "skillCast", id: "office/skill-cast", file: "skill-cast", options: {} },
  { key: "skillCastDock", id: "office/skill-cast", file: "skill-cast-dock", options: { compact: true } },
  { key: "steam", id: "office/steam", file: "steam", options: {} },
  { key: "rackA", id: "office/rack-leds", file: "rack-a", options: { face: [2, 5] } },
  { key: "rackB", id: "office/rack-leds", file: "rack-b", options: { face: [10, 13], seed: 7 } },
  { key: "skyDay", id: "office/sky", file: "sky-day", options: {} },
  { key: "skyDusk", id: "office/sky", file: "sky-dusk", options: { palette: ["#e8a07a", "#ffd0a8", "#fff0dc"], seed: 9 } },
  { key: "skyNight", id: "office/sky", file: "sky-night", options: { palette: ["#7d86b8", "#d8defa", "#ffffff"], night: true } },
  { key: "act_code", id: "office/activity", file: "act-code", options: { kind: "code" } },
  { key: "act_docs", id: "office/activity", file: "act-docs", options: { kind: "docs" } },
  { key: "act_read", id: "office/activity", file: "act-read", options: { kind: "read" } },
  { key: "act_web", id: "office/activity", file: "act-web", options: { kind: "web" } },
  { key: "act_shell", id: "office/activity", file: "act-shell", options: { kind: "shell" } },
  { key: "act_agents", id: "office/activity", file: "act-agents", options: { kind: "agents" } },
  { key: "act_think", id: "office/activity", file: "act-think", options: { kind: "think" } },
];
mkdirSync(join(PFX, "src", "fx", "office"), { recursive: true });
for (const f of readdirSync(join(ROOT, "scripts", "office-fx"))) if (f.endsWith(".js")) copyFileSync(join(ROOT, "scripts", "office-fx", f), join(PFX, "src", "fx", "office", f));

// minimal PNG reader: 8-bit RGBA or RGB, non-interlaced (what assets/pixel holds)
function readPNG(file) {
  const b = readFileSync(file);
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), t = b.toString("ascii", p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; if (d[8] !== 8 || d[12]) throw new Error(`${file}: unsupported PNG`); }
    else if (t === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`${file}: PNG color type ${type} unsupported`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pr = f === 4 ? (() => { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })() : 0;
      line[x] = (line[x] + (f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? pr : 0)) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, data: out };
}

// the office character: char_0's front-facing standing frame (16 x 32), feet at the bottom row
function officeActor() {
  const img = readPNG(join(ROOT, "assets", "pixel", "char_0.png")), W = 16, H = 32;
  const data = new Uint8Array(W * H), pixels = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * img.w + x) * 4;
    if (img.data[i + 3] > 127) { data[y * W + x] = 1; pixels[y * W + x] = rgb(img.data[i], img.data[i + 1], img.data[i + 2]); }
  }
  return { mask: { w: W, h: H, data }, pixels, x: -W / 2, y: -H, w: W, h: H, k: 1, head: [0, -H], chest: [0, -H + 11], eyes: [] };   // eyes: none to shut (an agent may face away)
}

mkdirSync(OUT, { recursive: true });
const actor = officeActor(), table = {};
for (const e of EFFECTS) {
  const fx = await lib.loadEffect(e.id);
  const r = lib.renderFrames(fx, { options: { ...e.options, ...(e.actor ? { actor } : {}) } });
  const s = lib.spriteSheet(fx, r, e.file), m = s.json.meta.pixelfx;
  writeFileSync(join(OUT, `${e.file}.png`), s.png);
  table[e.key] = { src: `fx/${e.file}`, w: m.frameSize[0], h: m.frameSize[1], px: m.pivot[0], py: m.pivot[1], cols: m.columns, n: m.frames, fps: m.fps, loop: !!m.loop, ...(e.head ? { dy: 38 - 32 } : {}) };
  console.error(`${e.id} → assets/pixel/fx/${e.file}.png  ${m.frames} frames ${m.frameSize.join("x")}`);
}
console.log(`const OFFICE_FX = ${JSON.stringify(table)};`);
