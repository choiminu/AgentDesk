// AgentDesk dock: the play layer's loops on a 56 x 56 dock tile, beside its character (feet at the origin) —
// the test-failure monster at the feet (boss), sweat flying off the head when the context window fills (sweat),
// and a mug of coffee while the session compacts (coffee). Baked by scripts/office-fx.mjs from a pixelfx checkout.
import { fit, TAU, clamp } from "../../core/index.js";

export const meta = {
  name: "Dock play loops",
  desc: "Loops beside a 16 x 28 character on a 56 px dock tile: a little monster for failing tests, sweat for a full context window, coffee while compacting.",
  tags: ["office", "dock", "status", "loop"],
  size: [56, 56],
  origin: [28, 38],
  duration: 2,
  loop: true,
  fps: 12,
  bg: "dark",
  options: { kind: "boss" },
};

const PALS = {
  boss: ["#3a0b16", "#b3262f", "#ff6b5e", "#ffe9e0"],
  sweat: ["#1f4a7a", "#4f9fe6", "#b3e0ff", "#ffffff"],
  coffee: ["#3b2416", "#8a5a36", "#e9dcc8", "#ffffff"],
};

// 11 x 9: horns, two angry eyes, a jagged mouth
const BOSS = [
  "#.........#",
  "##.......##",
  ".#########.",
  "###########",
  "#oo#####oo#",
  "#o@#####@o#",
  "###########",
  "##m#m#m#m##",
  ".#########.",
];

const DRAW = {
  boss(p, t, C) {
    const u = t / meta.duration, hop = Math.abs(Math.sin(u * TAU * 2)) > 0.75 ? -1 : 0, X = 13, Y = -9 + hop;
    BOSS.forEach((row, yy) => [...row].forEach((ch, xx) => {
      if (ch === ".") return;
      const c = ch === "o" ? C[3] : ch === "@" ? C[0] : ch === "m" ? C[0] : yy < 2 ? C[2] : yy > 6 ? C[1] : xx < 2 ? C[2] : C[1];
      p.px(X + xx, Y + yy, c);
    }));
    p.line(X + 1, Y + 9, X + 9, Y + 9, C[0], hop ? 0.35 : 0.6);                 // its shadow
    p.glow(X + 5, Y + 4, 7, C[1], 0.25 + 0.15 * Math.sin(u * TAU * 2));
    if (Math.floor(u * 8) % 4 === 0) { p.px(X - 1, Y - 2, C[2]); p.px(X + 11, Y - 2, C[2]); }   // steam of anger
  },
  sweat(p, t, C) {
    const D = meta.duration;
    for (let i = 0; i < 3; i++) {
      const age = (t + i * D / 3) % D, L = 1.1; if (age >= L) continue;
      const u = age / L, side = i === 1 ? 1 : -1;
      const x = Math.round(side * (8 + u * 5)), y = Math.round(-22 - Math.sin(u * Math.PI) * 5 + u * 8) - (i === 2 ? 3 : 0);
      const a = clamp((1 - u) / 0.3, 0, 1);
      p.blend(x, y, C[2], a); p.blend(x, y + 1, C[1], a); p.blend(x, y - 1, C[3], a * 0.9);
    }
  },
  coffee(p, t, C) {
    const u = t / meta.duration, X = -17, Y = -12;
    p.rect(X, Y, 6, 6, C[2], 1);                                               // the mug
    p.line(X, Y, X + 5, Y, C[0], 1); p.line(X + 1, Y + 1, X + 4, Y + 1, C[1], 1);
    p.line(X, Y + 6, X + 5, Y + 6, C[1], 1);
    p.px(X - 1, Y + 2, C[2]); p.px(X - 2, Y + 3, C[2]); p.px(X - 1, Y + 4, C[2]);   // the handle
    for (let i = 0; i < 3; i++) {                                              // steam
      const age = (u + i / 3) % 1, x = X + 1 + i * 2 + Math.round(Math.sin(age * TAU + i) * 1), y = Y - 2 - Math.round(age * 7);
      p.blend(x, y, C[3], (1 - age) * 0.8); p.blend(x, y + 1, C[2], (1 - age) * 0.5);
    }
  },
};

export function draw(p, t, o) {
  const k = DRAW[o.kind] ? o.kind : "boss";
  DRAW[k](p, t, fit(PALS[k], 4));
}
