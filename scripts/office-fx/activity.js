// AgentDesk dock: what a working session is doing, as a small loop around its character on a 56 x 56 dock tile —
// code bits flying off the keyboard (edit), lines written on a floating page (docs), a magnifier sweeping (read /
// search), a spinning globe (web), a terminal scrolling (shell), helper orbs circling (subagents), thought dots
// (thinking: working, no tool yet), a spellbook with rising runes (a skill), a server box with packets on a cable (an MCP tool). Baked by scripts/office-fx.mjs from a pixelfx checkout, one sheet per kind.
// The tile's corners are taken (tool chip top left, badges top right, context hearts left, the name below the feet),
// so everything happens over the head and on the right of the character.
import { fit, TAU, clamp } from "../../core/index.js";

export const meta = {
  name: "Dock activity",
  desc: "A small loop beside a 16 x 28 character on a 56 px dock tile that says what the agent is doing: code, docs, read, web, shell, agents, thinking, a skill or an MCP tool.",
  tags: ["office", "dock", "status", "activity", "loop"],
  size: [56, 56],
  origin: [28, 38],   // the character's feet, 18 px above the tile's bottom
  duration: 2,
  loop: true,
  fps: 12,
  bg: "dark",
  options: { kind: "code", seed: 3 },
};

const PALS = {
  code: ["#2a8a64", "#46c98f", "#8ff5c6", "#f2fff8"],
  docs: ["#6b5a2e", "#c9b27a", "#f3e6c0", "#ffffff"],
  read: ["#1f4a7a", "#4f8fd6", "#a9d4ff", "#ffffff"],
  web: ["#0f4f5a", "#2aa3b3", "#7fe3ec", "#effeff"],
  shell: ["#10151c", "#6b7c94", "#ffc861", "#fff4d6"],
  agents: ["#7a3d12", "#d9822b", "#ffc46b", "#fff3d0"],
  think: ["#4a4a66", "#8e8fb8", "#d5d6f2", "#ffffff"],
  skill: ["#3d1f6b", "#8a5cf0", "#cdb4ff", "#fbf5ff"],
  mcp: ["#5c1a40", "#d6408f", "#ff9ccc", "#fff0f7"],
};

// mini glyphs (3 x 5) for the code bits
const GLYPHS = [
  [".#.", "#..", "#..", "#..", ".#."],   // (
  ["#..", ".#.", ".#.", ".#.", "#.."],   // ) mirrored below
  ["..#", "..#", ".#.", "#..", "#.."],   // /
  [".##", ".#.", "#..", ".#.", ".##"],   // {
  ["...", ".#.", "...", ".#.", "#.."],   // ;
  ["...", "...", "###", "...", "..."],   // -
];

function glyph(p, g, x, y, c, a) {
  g.forEach((row, yy) => [...row].forEach((ch, xx) => { if (ch === "#") p.blend(Math.round(x) + xx, Math.round(y) + yy, c, a); }));
}

const DRAW = {
  // bits of code pop off the hands and drift up to the right, a spark where each leaves
  // a stream of code bits: little glyphs and 1 px bits fly off the hands and up to the right, sparking where they leave
  code(p, t, C) {
    const D = meta.duration, SEQ = [0, 2, 1, 3, 4, 2];
    for (let i = 0; i < 6; i++) {
      const age = (t + i * D / 6) % D, L = 1.3;
      if (age >= L) continue;
      const u = age / L, g = GLYPHS[SEQ[i]];
      const x = 6 + u * 12 + Math.sin(u * 5 + i * 2) * 1.2, y = -12 - u * 22 + (i % 3);
      const a = clamp(u / 0.1, 0, 1) * clamp((1 - u) / 0.3, 0, 1);
      glyph(p, g, x, y, u < 0.25 ? C[3] : u < 0.6 ? C[2] : C[1], a);
      if (u > 0.15 && u < 0.6) p.glow(x + 1, y + 2, 3, C[2], 0.25 * a);
      if (u < 0.1) { p.px(5, -11, C[3]); p.px(4, -12, C[2]); p.glow(5, -11, 4, C[2], 0.7 * (1 - u / 0.1)); }
    }
    for (let i = 0; i < 8; i++) {   // loose bits
      const age = (t * 1.5 + i * 0.37) % 1.2, u = age / 1.2;
      const x = 6 + u * (8 + (i % 4) * 3), y = -12 - u * (10 + (i * 7) % 9);
      p.blend(Math.round(x), Math.round(y), i % 2 ? C[2] : C[3], (1 - u) * 0.9);
    }
  },
  // a page floats on the right; a pen writes four lines, the page turns white and starts over
  docs(p, t, C) {
    const D = meta.duration, u = t / D, X = 11, Y = -27, W = 9, H = 11;
    const fade = u > 0.88 ? (1 - u) / 0.12 : u < 0.06 ? u / 0.06 : 1;
    p.rect(X, Y, W, H, C[2], fade);
    p.line(X, Y, X + W - 1, Y, C[3], fade); p.line(X + W - 1, Y + H - 1, X, Y + H - 1, C[1], fade);
    const lines = 4, per = 0.8 / lines;
    for (let k = 0; k < lines; k++) {
      const s = clamp((u - 0.06 - k * per) / per, 0, 1), len = Math.round((k === lines - 1 ? 4 : 6) * s);
      if (len > 0) p.line(X + 1, Y + 2 + k * 2, X + len, Y + 2 + k * 2, C[0], fade > 0.5 ? 1 : fade);
      if (s > 0 && s < 1) {   // the pen: a 1 x 3 nib over the end of the line
        const px = X + Math.max(1, len), py = Y + 2 + k * 2;
        p.line(px + 1, py - 3, px + 3, py - 5, C[3], 1); p.px(px, py - 1, C[3]); p.glow(px, py - 1, 2, C[2], 0.35);
      }
    }
  },
  // a magnifier sweeps a small figure-8 beside the head; its glass catches a glint
  read(p, t, C) {
    const w = t / meta.duration * TAU, cx = 16 + Math.sin(w) * 4, cy = -24 + Math.sin(w * 2) * 2;
    p.blend(Math.round(cx), Math.round(cy), C[1], 0.35);
    p.disc(cx, cy, 2.6, C[2], 0.25);
    p.ring(Math.round(cx), Math.round(cy), 3, 1, C[2], 1);
    p.line(Math.round(cx) + 2, Math.round(cy) + 3, Math.round(cx) + 4, Math.round(cy) + 5, C[1], 1);
    p.line(Math.round(cx) + 3, Math.round(cy) + 3, Math.round(cx) + 5, Math.round(cy) + 5, C[0], 1);
    const gl = (Math.sin(w * 2) + 1) / 2;
    p.px(Math.round(cx) - 1, Math.round(cy) - 1, C[3]);
    if (gl > 0.8) p.glow(Math.round(cx) - 1, Math.round(cy) - 1, 3, C[3], (gl - 0.8) * 3);
  },
  // a globe turns (two meridians sliding across), a satellite circles it with a short trail
  // a globe turns (meridians slide across, two latitudes), a satellite circles it with a short trail
  web(p, t, C) {
    const w = t / meta.duration * TAU, cx = 16, cy = -26, r = 5;
    p.circle(cx, cy, r, C[0], 0.9);
    p.circle(cx - 1, cy - 1, r - 2, C[1], 0.35);
    for (const dy of [-2, 2]) { const hw = Math.round(Math.sqrt(r * r - dy * dy)) - 1; p.line(cx - hw, cy + dy, cx + hw, cy + dy, C[1], 1); }
    for (let m = 0; m < 3; m++) {
      const ph = w + m * TAU / 3, sx = Math.sin(ph);
      if (Math.cos(ph) <= 0) continue;
      for (let y = -r + 1; y <= r - 1; y++) { const hw = Math.sqrt(r * r - y * y); p.px(Math.round(cx + sx * (hw - 0.5)), cy + y, C[2]); }
    }
    p.ring(cx, cy, r, 1, C[2], 1);
    p.px(cx - 2, cy - 3, C[3]);
    for (let k = 0; k < 5; k++) {
      const a = w * 2 - k * 0.22, sx = cx + Math.cos(a) * 9, sy = cy + Math.sin(a) * 3;
      if (Math.sin(a) < 0 && Math.abs(sx - cx) < r) continue;   // behind the globe
      if (k === 0) { p.px(Math.round(sx), Math.round(sy), C[3]); p.glow(sx, sy, 3, C[2], 0.6); }
      else p.blend(Math.round(sx), Math.round(sy), C[2], 0.7 - k * 0.13);
    }
  },
  // a little terminal: a prompt, output lines scrolling up, a blinking cursor
  shell(p, t, C) {
    const X = 9, Y = -28, W = 14, H = 10, u = t / meta.duration;
    p.rect(X, Y, W, H, C[0], 0.95);
    p.line(X, Y, X + W - 1, Y, C[1], 1); p.line(X, Y + H - 1, X + W - 1, Y + H - 1, C[1], 0.6);
    p.line(X, Y, X, Y + H - 1, C[1], 0.6); p.line(X + W - 1, Y, X + W - 1, Y + H - 1, C[1], 0.6);
    p.px(X + 1, Y, C[2]); p.px(X + 3, Y, C[1]);
    const step = Math.floor(u * 8);
    for (let k = 0; k < 3; k++) {
      const len = 2 + ((step + k) * 5) % 9, yy = Y + 2 + k * 2;
      p.line(X + 2, yy, X + 1 + Math.min(len, W - 4), yy, k === 2 ? C[2] : C[1], 1);
    }
    const py = Y + H - 2;
    p.px(X + 1, py - 1, C[2]); p.px(X + 2, py, C[2]); p.px(X + 1, py + 1, C[2]);   // ">"
    if (Math.floor(u * 4) % 2 === 0) { p.line(X + 4, py, X + 5, py, C[3], 1); p.glow(X + 4.5, py, 2, C[2], 0.3); }
  },
  // two helper orbs circle the character; behind it they dim and hide where the body is
  agents(p, t, C) {
    const w = t / meta.duration * TAU;
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 5; k++) {
        const a = w + i * Math.PI - k * 0.18, x = Math.cos(a) * 14, y = -15 + Math.sin(a) * 4, front = Math.sin(a) > 0;
        if (!front && Math.abs(x) < 8) continue;   // behind the body
        const al = (k === 0 ? 1 : 0.55 - k * 0.1) * (front ? 1 : 0.5);
        if (k === 0) { p.circle(Math.round(x), Math.round(y), 1, front ? C[2] : C[1], al); p.px(Math.round(x), Math.round(y), C[3]); p.glow(x, y, 3, C[2], front ? 0.5 : 0.2); }
        else p.blend(Math.round(x), Math.round(y), C[1], al);
      }
    }
  },
  // a thought cloud over the head: three dots light up one after another
  think(p, t, C) {
    const u = t / meta.duration;
    p.px(6, -27, C[1]); p.blend(9, -29, C[2], 0.9); p.blend(10, -29, C[2], 0.9);
    p.ellipse(16, -34, 8, 4, C[1], 0.55);
    p.ellipse(16, -34, 7, 3, C[0], 0.85);
    for (let k = 0; k < 3; k++) {
      const on = Math.max(0, Math.sin((u - k * 0.15) * TAU)), x = 12 + k * 4;
      const c = on > 0.55 ? C[3] : C[1];
      p.rect(x, -35, 2, 2, c, 1);
      if (on > 0.55) p.glow(x + 1, -34, 3, C[2], (on - 0.55) * 1.2);
    }
  },
  // a skill: an open spellbook floats over the right shoulder, runes rise off its pages and fade
  skill(p, t, C) {
    const u = t / meta.duration, X = 10, Y = -22, bob = Math.round(Math.sin(u * TAU) * 1);
    const by = Y + bob;
    p.rect(X, by, 6, 6, C[2], 1); p.rect(X + 7, by, 6, 6, C[2], 1);         // pages
    p.line(X, by + 6, X + 5, by + 6, C[1], 1); p.line(X + 7, by + 6, X + 12, by + 6, C[1], 1);
    p.line(X + 6, by - 1, X + 6, by + 6, C[0], 1);                             // spine
    p.line(X - 1, by + 7, X + 13, by + 7, C[0], 1);                            // cover
    for (let k = 0; k < 2; k++) p.line(X + 1, by + 1 + k * 2, X + 4, by + 1 + k * 2, C[1], 1);
    for (let k = 0; k < 2; k++) p.line(X + 8, by + 1 + k * 2, X + 11, by + 1 + k * 2, C[1], 1);
    p.glow(X + 6, by + 2, 6, C[1], 0.35);
    for (let i = 0; i < 4; i++) {                                              // runes: little four-point stars
      const age = (u + i / 4) % 1, x = X + 3 + ((i * 5) % 8) + Math.round(Math.sin(age * TAU + i) * 1.5), y = by - 2 - Math.round(age * 9);
      const a = clamp(age / 0.15, 0, 1) * clamp((1 - age) / 0.35, 0, 1), c = age < 0.4 ? C[3] : C[2];
      p.blend(x, y, c, a); p.blend(x - 1, y, C[2], a * 0.7); p.blend(x + 1, y, C[2], a * 0.7); p.blend(x, y - 1, C[2], a * 0.7); p.blend(x, y + 1, C[2], a * 0.7);
      p.glow(x, y, 3, C[1], 0.4 * a);
    }
  },
  // an MCP tool: a little server box over the right shoulder, a cable down to the hands, packets running both ways
  mcp(p, t, C) {
    const u = t / meta.duration, X = 12, Y = -32, W = 10, H = 9;
    p.rect(X, Y, W, H, C[0], 1);
    p.line(X, Y, X + W - 1, Y, C[2], 1); p.line(X, Y, X, Y + H - 1, C[1], 1);
    p.line(X + W - 1, Y, X + W - 1, Y + H - 1, C[1], 0.7); p.line(X, Y + H - 1, X + W - 1, Y + H - 1, C[1], 0.7);
    for (let r = 0; r < 2; r++) {                                              // two drive bays with blinking leds
      const yy = Y + 2 + r * 3;
      p.line(X + 2, yy, X + 5, yy, C[1], 1);
      const on = Math.floor(u * 6 + r * 3) % 3 !== 0;
      p.px(X + 7, yy, on ? C[3] : C[1]); if (on) p.glow(X + 7, yy, 2, C[2], 0.4);
    }
    const path = [];                                                           // the cable: hands (6,-12) up to the box's bottom
    for (let i = 0; i <= 14; i++) { const v = i / 14; path.push([Math.round(6 + v * 11), Math.round(-12 - v * 11 + Math.sin(v * Math.PI) * 3)]); }
    for (const [x, y] of path) p.blend(x, y, C[1], 0.85);
    p.rect(15, Y + H, 4, 2, C[1], 1);                                          // the plug
    p.px(16, Y + H + 2, C[2]); p.px(18, Y + H + 2, C[2]);
    for (let i = 0; i < 2; i++) {                                              // a request up, a reply down
      const v = (u * 2 + i * 0.5) % 1, up = i === 0, q = up ? v : 1 - v, j = Math.min(path.length - 1, Math.round(q * (path.length - 1)));
      const [x, y] = path[j];
      p.rect(x - 1, y - 1, 2, 2, up ? C[3] : C[2], 1); p.glow(x, y, 3, C[2], 0.6);
    }
  },
};

export function draw(p, t, o) {
  const k = DRAW[o.kind] ? o.kind : "code";
  DRAW[k](p, t, fit(o.palette && o.palette !== meta.options.palette ? o.palette : PALS[k], 4));
}
