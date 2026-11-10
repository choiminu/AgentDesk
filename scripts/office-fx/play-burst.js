// AgentDesk dock: the play layer's one-shots on a 56 x 56 dock tile — the monster going down in a puff with stars
// (bossDown), a crackle when two sessions change the same file (clash), and a lift of sparkles when a compacted
// session wakes up (revive). Baked by scripts/office-fx.mjs from a pixelfx checkout.
import { fit, TAU, clamp, ease } from "../../core/index.js";

export const meta = {
  name: "Dock play bursts",
  desc: "One-shots on a 56 px dock tile: a monster's puff, a file-clash crackle, a wake-up sparkle.",
  tags: ["office", "dock", "status", "burst"],
  size: [56, 56],
  origin: [28, 38],
  duration: 0.9,
  loop: false,
  fps: 20,
  bg: "dark",
  options: { kind: "bossDown" },
};

const PALS = {
  bossDown: ["#5a2a3a", "#c9c2d6", "#ffd766", "#ffffff"],
  clash: ["#7a4a00", "#ffb020", "#ffe27a", "#ffffff"],
  revive: ["#17663e", "#3ec466", "#b6ffbc", "#ffffff"],
};
const star = (p, x, y, c, c2, a) => { p.blend(x, y, c, a); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.blend(x + dx, y + dy, c2, a * 0.75); };

const DRAW = {
  bossDown(p, t, C) {
    const u = t / meta.duration, cx = 18, cy = -5, e = ease.outQuart(u);
    if (u < 0.12) { p.circle(cx, cy, 5, C[3], 1); p.glow(cx, cy, 9, C[2], 0.8); return; }
    for (let i = 0; i < 6; i++) {                                              // the puff
      const a = i / 6 * TAU + 0.4, r = 2 + e * 7, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.7 - e * 3;
      p.disc(x, y, Math.max(0.6, 2.6 * (1 - u)), C[1], 0.7 * (1 - u));
    }
    for (let i = 0; i < 5; i++) {                                              // stars fly up and out
      const a = -Math.PI / 2 + (i - 2) * 0.55, r = e * 10, x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
      star(p, x, y, i % 2 ? C[3] : C[2], C[2], clamp((1 - u) / 0.4, 0, 1));
    }
  },
  clash(p, t, C) {
    const u = t / meta.duration, a = clamp((1 - u) / 0.35, 0, 1), k = Math.floor(u * 9) % 2;
    const bolt = [[2, -36], [-2, -31], [2, -31], [-3, -24]];                   // a lightning bolt over the head
    for (let i = 0; i < bolt.length - 1; i++) p.line(bolt[i][0] + k, bolt[i][1], bolt[i + 1][0] + k, bolt[i + 1][1], i === 1 ? C[3] : C[2], a);
    p.glow(0, -30, 7, C[1], 0.6 * a);
    const e = ease.outQuart(u);
    for (let i = 0; i < 8; i++) {                                              // shock lines out of the body
      const ang = i / 8 * TAU + 0.2, r0 = 9 + e * 6, r1 = r0 + 3;
      p.line(Math.round(Math.cos(ang) * r0), Math.round(-13 + Math.sin(ang) * r0 * 0.8), Math.round(Math.cos(ang) * r1), Math.round(-13 + Math.sin(ang) * r1 * 0.8), i % 2 ? C[2] : C[1], a);
    }
    if (u < 0.15) p.glow(0, -13, 14, C[2], 0.5);
  },
  revive(p, t, C) {
    const u = t / meta.duration;
    for (let i = 0; i < 9; i++) {
      const d = (i * 0.07) % 0.4, v = clamp((u - d) / (1 - d), 0, 1); if (v <= 0) continue;
      const x = Math.round(-10 + (i * 7) % 21 + Math.sin(v * TAU + i) * 1.5), y = Math.round(-2 - ease.outQuart(v) * (20 + (i * 5) % 11));
      star(p, x, y, i % 3 ? C[2] : C[3], C[1], clamp((1 - v) / 0.4, 0, 1));
    }
    p.glow(0, -12, 12, C[1], 0.45 * (1 - u));
  },
};

export function draw(p, t, o) {
  const k = DRAW[o.kind] ? o.kind : "bossDown";
  DRAW[k](p, t, fit(PALS[k], 4));
}
