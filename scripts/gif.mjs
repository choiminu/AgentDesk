// A small GIF89a encoder (no dependencies): RGBA frames of one size → an animated GIF with a global 256-colour palette
// (median cut over the frames' colours), LZW-compressed, looping forever. Used by scripts/shots.mjs for the README.
//
//   encodeGif(frames, { delays })  frames: [{ w, h, px: Uint8Array RGBA }], delays: [ms per frame] → Buffer

function quantize(frames, maxColors = 255) {
  // colours seen (5 bits per channel) with their counts, then median cut down to maxColors boxes
  const counts = new Map();
  for (const f of frames) for (let i = 0; i < f.px.length; i += 4) {
    const k = ((f.px[i] >> 3) << 10) | ((f.px[i + 1] >> 3) << 5) | (f.px[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let boxes = [[...counts.entries()].map(([k, n]) => ({ r: ((k >> 10) & 31) << 3, g: ((k >> 5) & 31) << 3, b: (k & 31) << 3, n }))];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift(); if (!box || box.length < 2) { if (box) boxes.push(box); break; }
    const range = ch => { let lo = 255, hi = 0; for (const c of box) { lo = Math.min(lo, c[ch]); hi = Math.max(hi, c[ch]); } return hi - lo; };
    const ch = ['r', 'g', 'b'].sort((a, b) => range(b) - range(a))[0];
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  const palette = boxes.map(box => {
    let r = 0, g = 0, b = 0, n = 0; for (const c of box) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; n += c.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}
function indexFrames(frames, palette) {
  const cache = new Map();
  const nearest = (r, g, b) => {
    const k = (r << 16) | (g << 8) | b; let i = cache.get(k); if (i != null) return i;
    let best = 0, bd = Infinity;
    for (let p = 0; p < 255; p++) { const d = (palette[p][0] - r) ** 2 + (palette[p][1] - g) ** 2 + (palette[p][2] - b) ** 2; if (d < bd) { bd = d; best = p; } }
    cache.set(k, best); return best;
  };
  return frames.map(f => { const out = new Uint8Array(f.w * f.h); for (let i = 0, j = 0; i < f.px.length; i += 4, j++) out[j] = nearest(f.px[i], f.px[i + 1], f.px[i + 2]); return out; });
}
// LZW (GIF variant) with a 8-bit minimum code size, output as sub-blocks
function lzw(indexes) {
  const minCode = 8, clear = 1 << minCode, eoi = clear + 1, out = [];
  let bits = 0, nbits = 0;
  const emit = (code, size) => { bits |= code << nbits; nbits += size; while (nbits >= 8) { out.push(bits & 255); bits >>>= 8; nbits -= 8; } };
  let dict = new Map(), next = eoi + 1, size = minCode + 1;
  const reset = () => { dict = new Map(); next = eoi + 1; size = minCode + 1; };
  emit(clear, size);
  let prefix = -1;
  for (const k of indexes) {
    if (prefix < 0) { prefix = k; continue; }
    const key = prefix * 4096 + k, code = dict.get(key);
    if (code != null) { prefix = code; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next - 1 === (1 << size) && size < 12) size++; }
    else { emit(clear, size); reset(); }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix, size);
  emit(eoi, size);
  if (nbits > 0) out.push(bits & 255);
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) { const chunk = out.slice(i, i + 255); blocks.push(chunk.length, ...chunk); }
  blocks.push(0);
  return Buffer.from(blocks);
}
export function encodeGif(frames, opts = {}) {
  if (!frames.length) throw new Error('no frames');
  const { w, h } = frames[0], delays = opts.delays || frames.map(() => 800);
  const palette = quantize(frames), idx = indexFrames(frames, palette);
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0xF7; lsd[5] = 0; lsd[6] = 0; parts.push(lsd);   // global colour table, 256 entries
  const gct = Buffer.alloc(256 * 3); palette.forEach((c, i) => { gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2]; }); parts.push(gct);
  parts.push(Buffer.from([0x21, 0xFF, 0x0B, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]));   // loop forever
  idx.forEach((ix, i) => {
    const gce = Buffer.alloc(8); gce[0] = 0x21; gce[1] = 0xF9; gce[2] = 4; gce[3] = 0; gce.writeUInt16LE(Math.max(2, Math.round(delays[i] / 10)), 4); gce[6] = 0; gce[7] = 0; parts.push(gce);
    const desc = Buffer.alloc(10); desc[0] = 0x2C; desc.writeUInt16LE(0, 1); desc.writeUInt16LE(0, 3); desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7); desc[9] = 0; parts.push(desc);
    parts.push(Buffer.from([8])); parts.push(lzw(ix));
  });
  parts.push(Buffer.from([0x3B]));
  return Buffer.concat(parts);
}
// box-filter downscale by an integer factor (device pixels → README size)
export function downscale(frame, f) {
  const w = Math.floor(frame.w / f), h = Math.floor(frame.h / f), px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const s = ((y * f + dy) * frame.w + x * f + dx) * 4; r += frame.px[s]; g += frame.px[s + 1]; b += frame.px[s + 2]; a += frame.px[s + 3]; }
    const o = (y * w + x) * 4, n = f * f; px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = a / n;
  }
  return { w, h, px };
}
