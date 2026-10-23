#!/usr/bin/env node
// Builds the app icon (assets/icon.png, 512×512 RGBA) from the office's pixel character sprite — pure Node, no
// dependencies: a small PNG decoder (8-bit RGBA, non-interlaced, as the sprites are) and encoder (zlib + CRC-32).
// electron-builder turns this PNG into the macOS .icns and the Windows .ico; Linux and the Win/Linux window and tray
// use it as is. Run after changing the sprite or the drawing below:  node scripts/make-icon.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("only 8-bit RGBA non-interlaced PNGs are supported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, px };
}

export function encodePng(w, h, px) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);   // filter 0 on every line
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// source-over blend of one straight-alpha colour onto the canvas
function blend(px, i, r, g, b, a) {
  if (a <= 0) return;
  const da = px[i + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
  const mix = (s, d) => Math.round((s * sa + d * da * (1 - sa)) / oa);
  px[i] = mix(r, px[i]); px[i + 1] = mix(g, px[i + 1]); px[i + 2] = mix(b, px[i + 2]); px[i + 3] = Math.round(oa * 255);
}
// coverage of a rounded rectangle at a pixel centre, with a 1px soft edge
function roundRectCover(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

export function drawIcon(sheet) {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  // macOS-style tile: 412px rounded square centred in 512 (the grid Apple's icon template uses), dark office night
  const T0 = 50, T1 = 462, R = 92;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const cov = roundRectCover(x + 0.5, y + 0.5, T0, T0, T1, T1, R); if (!cov) continue;
    const t = (y - T0) / (T1 - T0);
    const top = [36, 44, 66], bot = [18, 22, 34];
    blend(px, (y * SIZE + x) * 4, ...top.map((c, k) => Math.round(c + (bot[k] - c) * t)), Math.round(255 * cov));
  }
  // floor strip the character stands on
  for (let y = 372; y < 400; y++) for (let x = 0; x < SIZE; x++) {
    const cov = roundRectCover(x + 0.5, y + 0.5, T0, T0, T1, T1, R); if (cov) blend(px, (y * SIZE + x) * 4, 92, 74, 58, Math.round(255 * cov));
  }
  // the character: frame 0 of row 0 (16×32, facing the viewer), scaled ×11 with nearest neighbour
  const FW = 16, FH = 32, S = 11, ox = Math.round((SIZE - FW * S) / 2);
  let last = FH - 1; while (last > 0 && ![...Array(FW).keys()].some(sx => sheet.px[(last * sheet.w + sx) * 4 + 3])) last--;
  const oy = 386 - (last + 1) * S;   // the lowest opaque row stands on the floor strip
  for (let sy = 0; sy < FH; sy++) for (let sx = 0; sx < FW; sx++) {
    const si = (sy * sheet.w + sx) * 4, a = sheet.px[si + 3]; if (!a) continue;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) blend(px, ((oy + sy * S + y) * SIZE + ox + sx * S + x) * 4, sheet.px[si], sheet.px[si + 1], sheet.px[si + 2], a);
  }
  // status lamp (an agent at work): green dot with a dark ring, top right of the tile
  const LX = 392, LY = 120;
  for (let y = LY - 40; y < LY + 40; y++) for (let x = LX - 40; x < LX + 40; x++) {
    const d = Math.hypot(x + 0.5 - LX, y + 0.5 - LY);
    const ring = Math.max(0, Math.min(1, 34.5 - d)), dot = Math.max(0, Math.min(1, 26.5 - d));
    if (ring) blend(px, (y * SIZE + x) * 4, 18, 22, 34, Math.round(255 * ring));
    if (dot) blend(px, (y * SIZE + x) * 4, 74, 222, 128, Math.round(255 * dot));
  }
  return px;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sheet = decodePng(readFileSync(join(ROOT, "assets", "pixel", "char_0.png")));
  const out = join(ROOT, "assets", "icon.png");
  writeFileSync(out, encodePng(SIZE, SIZE, drawIcon(sheet)));
  console.log(`wrote ${out} (${SIZE}×${SIZE})`);
}
