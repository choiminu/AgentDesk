// AgentDesk office: a quiet zzz over a resting agent — small Zs, no glow (pixelfx's status/sleep is made for a
// game character and reads too loud on a 16 x 32 office sprite). Baked by scripts/office-fx.mjs from a pixelfx checkout.
import { fit, TAU } from "../../core/index.js";

export const meta = {
  name: "Office zzz",
  desc: "Two small Zs at a time drift up and to the right of the head, one size step bigger as they rise, and fade out.",
  tags: ["office", "sleep", "zzz", "rest", "loop"],
  size: [24, 42],
  origin: [4, 41],   // feet of a 16 x 32 office character: the Zs start beside its head (y -27)
  duration: 3,
  loop: true,
  fps: 10,
  bg: "dark",
  options: { palette: ["#7f86b8", "#b9c0ea"], seed: 2 },
};

// 4 x 5 and, higher up, 5 x 6: the diagonal runs all the way to the corner (a short one reads as an I)
const Z = [["####", "..#.", ".#..", "#...", "####"], ["#####", "...#.", "..#..", ".#...", "#....", "#####"]];

export function draw(p, t, o) {
  const [dim, lit] = fit(o.palette, 2), D = meta.duration, L = 2.6;
  // two Zs half a loop apart, so they never sit on each other
  for (let i = 0; i < 2; i++) {
    const age = (t + i * D / 2) % D;
    if (age >= L) continue;
    const u = age / L, big = u > 0.55 ? 1 : 0, rows = Z[big];
    const x = Math.round(7 + u * 9 + Math.sin(TAU * u) * 1), y = Math.round(-27 - u * 10) - (big ? 1 : 0);
    const a = (u < 0.15 ? u / 0.15 : 1) * (u > 0.7 ? (1 - u) / 0.3 : 1) * 0.8;
    rows.forEach((row, yy) => [...row].forEach((ch, xx) => { if (ch === "#") p.blend(x + xx, y + yy, big ? dim : lit, a); }));
  }
}
