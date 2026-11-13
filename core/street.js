// AgentDesk core: the dock bar as a small street — the sky follows the clock, the weather follows the plan limit.
// Shared by the renderer (classic <script>) and the tests (CommonJS). Pure: no DOM, no clock of its own. paint()
// only needs an object with `fillStyle` and `fillRect` (a 2D canvas context, or a recorder in a test).
//
//   skyAt(hour)            → [top, bottom] sky colours ('#rrggbb') at that hour (0–24, fractions allowed)
//   darkAt(hour)           → 0 (day) … 1 (night): how much the scene is dimmed
//   lampOn(hour)           → street lamps and windows lit (18:00 – 06:30)
//   weatherOf(pct)         → { stage: 'clear' | 'cloudy' | 'rain' | 'storm', cloud: 0…1, rain: 0…1 } from the used
//                            share of the limit (null / not a number: clear)
//   usagePct(rows)         → the highest `pct` of AgentDeskDock.usageRows(), or null when there is none
//   layout(width, seed)    → { buildings, stars, clouds } for a bar that wide (logical px), the same for the same input
//   paint(g, scene)        → draws one frame. scene: { w, h, hour, pct, tick, still, lay, heads: [{ x, y }],
//                            lamps: [x…], dimFrom } — heads: where a character's head is (an umbrella goes over it in
//                            the rain); dimFrom: from this x on the bar's buttons sit, so the picture is darkened;
//                            still: no motion (rain is drawn as puddles only, no lightning)
(function (root) {
'use strict';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const A = hex(a), B = hex(b), k = clamp(num(t), 0, 1); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join(''); };
const rgba = (h, a) => { const c = hex(h); return `rgba(${c[0]},${c[1]},${c[2]},${Math.round(clamp(num(a), 0, 1) * 1000) / 1000})`; };
const hourOf = h => { const n = num(h) % 24; return n < 0 ? n + 24 : n; };

// [hour, top, bottom]
const SKY = [[0, '#070b1f', '#141a3d'], [5, '#10143a', '#2b2a5c'], [6.5, '#5b5a9a', '#f2a271'], [8, '#63b4ea', '#bfe6f7'], [12, '#4aa6ea', '#a9dcf6'],
  [16.5, '#5aaee8', '#c4e4f2'], [18.5, '#5a4f96', '#f59b62'], [20, '#161a45', '#3a3068'], [24, '#070b1f', '#141a3d']];
function skyAt(hour) {
  const h = hourOf(hour); let i = 0;
  while (i < SKY.length - 2 && h >= SKY[i + 1][0]) i++;
  const a = SKY[i], b = SKY[i + 1], t = (h - a[0]) / (b[0] - a[0]);
  return [mix(a[1], b[1], t), mix(a[2], b[2], t)];
}
function darkAt(hour) { const h = hourOf(hour); return h < 5 ? 1 : h < 7.5 ? 1 - (h - 5) / 2.5 : h < 17.5 ? 0 : h < 20 ? (h - 17.5) / 2.5 : 1; }
function lampOn(hour) { const h = hourOf(hour); return h < 6.5 || h >= 18; }

const STAGES = ['clear', 'cloudy', 'rain', 'storm'];
function weatherOf(pct) {
  const ok = pct != null && pct !== '' && Number.isFinite(Number(pct)), u = ok ? clamp(Number(pct), 0, 100) : 0;
  return { stage: u < 60 ? 'clear' : u < 80 ? 'cloudy' : u < 95 ? 'rain' : 'storm', cloud: clamp((u - 50) / 30, 0, 1), rain: u < 80 ? 0 : 0.35 + (u - 80) / 20 * 0.65 };
}
function usagePct(rows) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) { const p = r && r.pct != null ? Number(r.pct) : NaN; if (Number.isFinite(p) && (best == null || p > best)) best = p; }
  return best;
}

// a small seeded generator: the same street for the same width
function rng(seed) { let s = (Math.floor(num(seed)) >>> 0) || 7; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function layout(width, seed) {
  const w = clamp(Math.floor(num(width)), 0, 4000), r = rng(seed == null ? 7 : seed), buildings = [], stars = [], clouds = [];
  for (let x = -3; x < w;) {
    const bw = 9 + Math.floor(r() * 10), bh = 4 + Math.floor(r() * 10);
    buildings.push({ x, w: bw, h: bh, t: r(), win: Array.from({ length: 12 }, () => r()) });
    x += bw + (r() < 0.3 ? 1 : 0);
  }
  for (let i = 0, n = Math.round(w / 9); i < n; i++) stars.push({ x: Math.floor(r() * w), y: Math.floor(r() * 12), p: r() });
  for (let i = 0, n = Math.max(3, Math.round(w / 55)); i < n; i++) clouds.push({ x: r() * w, y: 1 + Math.floor(r() * 6), w: 12 + Math.floor(r() * 12), v: 0.04 + r() * 0.06, need: i / n });
  return { buildings, stars, clouds };
}

const UMBRELLAS = ['#d9534f', '#3f8fd6', '#58a55c', '#f0b400', '#e07bb0', '#8a6fd1'];
function paint(g, scene) {
  const o = scene && typeof scene === 'object' ? scene : {};
  const W = clamp(Math.floor(num(o.w)), 0, 4000), H = clamp(Math.floor(num(o.h)), 0, 400);
  if (!g || !W || !H) return null;
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const tick = Math.floor(num(o.tick)), still = o.still === true, lay = o.lay && typeof o.lay === 'object' ? o.lay : layout(W, 7);
  const wx = weatherOf(o.pct), dk = darkAt(o.hour), lit = lampOn(o.hour), h = hourOf(o.hour);
  const GY = H - Math.max(8, Math.round(H * 0.3));   // the pavement's top: the tile names sit over the pavement
  // sky
  let [top, bot] = skyAt(h); const grey = mix('#8a93a0', '#1a1d29', dk);
  top = mix(top, grey, wx.cloud * 0.75); bot = mix(bot, grey, wx.cloud * 0.65);
  const bands = 6;
  for (let i = 0; i < bands; i++) R(0, Math.floor(i * GY / bands), W, Math.ceil(GY / bands) + 1, mix(top, bot, i / (bands - 1)));
  for (const s of lay.stars || []) { const a = dk * (1 - wx.cloud) * (still || (tick + Math.floor(s.p * 40)) % 30 > 4 ? 1 : 0.4); if (a > 0.05) R(s.x, s.y, 1, 1, rgba('#ffffff', a * (0.5 + s.p * 0.5))); }
  // sun / moon on an arc
  const day = h >= 6 && h < 18, p = day ? (h - 6) / 12 : ((h + 6) % 24) / 12, sx = 6 + p * (W - 12), sy = GY - 5 - Math.sin(p * Math.PI) * (GY - 9), sa = 1 - wx.cloud * 0.85;
  if (day) { R(sx - 2, sy - 3, 4, 6, rgba('#ffe27a', sa)); R(sx - 3, sy - 2, 6, 4, rgba('#ffe27a', sa)); R(sx - 1, sy - 1, 2, 2, rgba('#fff6c9', sa)); }
  else { R(sx - 2, sy - 2, 4, 4, rgba('#e9eefc', sa)); R(sx - 1, sy - 3, 2, 6, rgba('#e9eefc', sa)); R(sx, sy - 2, 2, 3, rgba(top, sa)); }
  // skyline
  const litWin = [];
  for (const b of lay.buildings || []) {
    const c = mix(mix(mix('#7f8ca6', '#a3aec2', b.t), bot, 0.25), '#0d1020', dk * 0.85);   // by day the skyline is hazy, by night a silhouette
    R(b.x, GY - b.h, b.w, b.h, c); R(b.x, GY - b.h, b.w, 1, mix(c, '#ffffff', 0.12));
    let k = 0;
    for (let y = GY - b.h + 2; y < GY - 2; y += 3) for (let x = b.x + 2; x < b.x + b.w - 2; x += 3) {
      const on = lit && b.win[k++ % b.win.length] < 0.55;
      if (on) litWin.push([x, y]);
      R(x, y, 1, 1, on ? '#ffd96b' : mix(c, '#bcd7ee', dk > 0.5 ? 0.06 : 0.35));
    }
  }
  // clouds
  const cc = mix(mix('#ffffff', '#59616f', wx.cloud), '#161924', dk * 0.7);
  for (const c of lay.clouds || []) {
    if (c.need > 0.12 + wx.cloud * 0.9) continue;
    const x = ((c.x + (still ? 0 : tick * c.v)) % (W + 40)) - 20;
    R(x, c.y + 2, c.w, 2, cc); R(x + 3, c.y + 1, c.w - 7, 1, cc); R(x + 6, c.y, c.w - 13, 1, cc);
  }
  // pavement and road
  const pave = mix(mix('#a39f97', '#666b77', wx.rain * 0.6), '#1a1c26', dk * 0.55);
  R(0, GY, W, H - GY - 2, pave);
  for (let x = 0; x < W; x += 8) R(x, GY, 1, H - GY - 2, 'rgba(0,0,0,0.10)');
  R(0, H - 2, W, 2, mix('#3f434c', '#14161e', dk * 0.6));
  if (wx.rain) for (let i = 0; i < Math.round(W / 22); i++) R((i * 41 + 12) % W, GY + 2 + (i % 3) * 2, 5 + (i % 3) * 2, 1, rgba('#a9c8e8', 0.2 + wx.rain * 0.25));
  // lamps
  const lamps = (Array.isArray(o.lamps) ? o.lamps : []).map(num).filter(x => x >= 1 && x < W - 1);
  for (const x of lamps) { R(x, GY - 11, 1, 12, '#20242e'); R(x - 1, GY - 12, 3, 1, '#20242e'); }
  // umbrellas over the characters (behind the tiles: the character stands in front of its umbrella)
  if (wx.rain) (Array.isArray(o.heads) ? o.heads : []).forEach((p0, i) => {
    const x = Math.round(num(p0 && p0.x)), y = Math.round(num(p0 && p0.y)), c = UMBRELLAS[i % UMBRELLAS.length];
    R(x - 2, y - 3, 5, 1, c); R(x - 4, y - 2, 9, 1, c); R(x - 5, y - 1, 11, 1, c); R(x, y, 1, 3, '#2a2a2a');
  });
  // night falls over everything drawn so far; lights are drawn on top
  const night = dk * 0.45 + wx.cloud * 0.1;
  if (night > 0.01) R(0, 0, W, H, rgba('#060a22', night));
  if (lit) {
    for (const x of lamps) { for (let y = GY - 10; y < H - 2; y++) { const hw = Math.round((y - (GY - 10)) * 0.45) + 1; R(x - hw, y, hw * 2 + 1, 1, 'rgba(255,214,120,0.13)'); } R(x - 1, GY - 12, 3, 2, '#fff1b8'); }
    for (const [x, y] of litWin) R(x, y, 1, 1, 'rgba(255,217,107,0.8)');
  }
  // rain: where each drop is follows from the tick alone
  let drops = 0;
  if (wx.rain && !still) {
    drops = Math.round(wx.rain * W * 0.35);
    const len = wx.rain > 0.8 ? 3 : 2, speed = 2 + Math.round(wx.rain * 2);
    for (let i = 0; i < drops; i++) {
      const y = ((i * 7919) % (H + 6) + tick * speed + (i % 5)) % (H + 6) - 4, x = ((i * 104729) % (W + 12) - tick + W * 4) % (W + 12);
      R(x, y, 1, len, 'rgba(190,215,245,0.55)');
    }
  }
  const flash = !still && wx.stage === 'storm' && tick % 97 < 2;
  if (flash) R(0, 0, W, H, 'rgba(255,255,255,0.2)');
  // the bar's buttons: the picture steps back
  const dim = num(o.dimFrom);
  if (dim > 0 && dim < W) { R(dim - 6, 0, 3, H, 'rgba(10,12,20,0.2)'); R(dim - 3, 0, 3, H, 'rgba(10,12,20,0.4)'); R(dim, 0, W - dim, H, 'rgba(10,12,20,0.6)'); }
  return { stage: wx.stage, lit, dark: dk, drops, flash, ground: GY, moving: !still && (wx.rain > 0 || wx.cloud > 0) };
}

const AgentDeskStreet = { SKY, STAGES, skyAt, darkAt, lampOn, weatherOf, usagePct, layout, paint };
root.AgentDeskStreet = AgentDeskStreet;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskStreet;
})(typeof globalThis !== 'undefined' ? globalThis : this);
