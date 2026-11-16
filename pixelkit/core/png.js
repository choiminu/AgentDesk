// PNG in and out on node:zlib alone, so the tools need no packages.
// encodePNG is adapted from pixelfx (tools/lib/png.mjs, MIT) — see ../NOTICE.md. decodePNG is pixelkit's own; it
// reads what image editors usually save: 8-bit grey, grey + alpha, RGB, RGBA, and palette images of 1 to 8 bits,
// with tRNS transparency, not interlaced.

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Canvas } from "./canvas.js";

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encode w x h RGBA bytes as a PNG buffer (8 bits per channel). */
export function encodePNG(w, h, rgba) {
  if (rgba.length < w * h * 4) throw new Error("encodePNG: not enough pixels");
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // Sub filter: pixel art has long runs, so differences compress well
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (src[y * stride + x] - (x >= 4 ? src[y * stride + x - 4] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG buffer to { w, h, data: RGBA bytes }. Throws on what it does not read (16-bit, interlaced). */
export function decodePNG(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let o = 8, w = 0, h = 0, depth = 8, type = 6, plte = null, trns = null;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), name = buf.toString("ascii", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (name === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9];
      if (!(type in CHANNELS)) throw new Error(`PNG color type ${type} is not supported`);
      if (data[12] !== 0) throw new Error("interlaced PNGs are not supported");
      if (depth !== 8 && !(type === 3 && [1, 2, 4].includes(depth))) throw new Error(`${depth}-bit PNGs of color type ${type} are not supported`);
    } else if (name === "PLTE") plte = data;
    else if (name === "tRNS") trns = data;
    else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    o += 12 + len;
  }
  if (!w || !h) throw new Error("PNG has no IHDR");
  if (type === 3 && !plte) throw new Error("palette PNG has no PLTE");
  const ch = CHANNELS[type], bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat)), lines = Buffer.alloc(stride * h);
  if (raw.length < (stride + 1) * h) throw new Error("PNG data is cut short");
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? lines[dst + x - bpp] : 0, b = y ? lines[dst - stride + x] : 0, c = x >= bpp && y ? lines[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error(`PNG filter ${f} is not valid`);
      lines[dst + x] = v & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4, s = y * stride + x * ch;
      if (type === 6) { data[d] = lines[s]; data[d + 1] = lines[s + 1]; data[d + 2] = lines[s + 2]; data[d + 3] = lines[s + 3]; }
      else if (type === 2) {
        data[d] = lines[s]; data[d + 1] = lines[s + 1]; data[d + 2] = lines[s + 2];
        data[d + 3] = trns && trns.length >= 6 && trns[1] === lines[s] && trns[3] === lines[s + 1] && trns[5] === lines[s + 2] ? 0 : 255;
      } else if (type === 0) { data[d] = data[d + 1] = data[d + 2] = lines[s]; data[d + 3] = trns && trns.length >= 2 && trns[1] === lines[s] ? 0 : 255; }
      else if (type === 4) { data[d] = data[d + 1] = data[d + 2] = lines[s]; data[d + 3] = lines[s + 1]; }
      else {
        const bit = x * depth, i = depth === 8 ? lines[y * stride + x] : (lines[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (i * 3 + 2 >= plte.length) throw new Error("PNG palette index out of range");
        data[d] = plte[i * 3]; data[d + 1] = plte[i * 3 + 1]; data[d + 2] = plte[i * 3 + 2];
        data[d + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  return { w, h, data };
}

/** A canvas as a PNG buffer. */
export const toPNG = (c) => encodePNG(c.w, c.h, c.toRGBA());
/** A PNG buffer as a canvas. */
export function fromPNG(buf) { const { w, h, data } = decodePNG(buf); return Canvas.fromRGBA(w, h, data); }
/** Write a canvas to a PNG file, making folders as needed. Returns the path. */
export function savePNG(file, c) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toPNG(c));
  return file;
}
/** Read a PNG file as a canvas. */
export const loadPNG = (file) => fromPNG(readFileSync(file));
