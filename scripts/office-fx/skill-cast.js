// AgentDesk office: a quick, small spell cast when an agent uses a skill — a flat rune ring flashes at the feet and a
// few sparkles rise to head height. No big glow (it plays over a 16 x 32 office sprite). Baked by scripts/office-fx.mjs.
import { fit, TAU, Rng } from "../../core/index.js";

export const meta = {
  name: "Office skill cast",
  desc: "A flat purple rune ring flashes white at the feet and fades while five sparkles rise around the body to head height.",
  tags: ["office", "skill", "cast", "arcane", "oneshot"],
  size: [48, 56],
  origin: [24, 51],   // feet of a 16 x 32 office character; the ring draws a few px below as floor perspective
  duration: 1.2,
  loop: false,
  fps: 20,
  bg: "dark",
  options: { palette: ["#4b2f86", "#7c58cf", "#b694f6", "#ddcbff", "#ffffff"], seed: 3 },
};

const RX = 14, RY = 3.5;

// the ring: 1 px ellipse at the feet, grows in fast, flashes white, cools to purple and fades; rune ticks on it
function ring(p, t, C, far) {
  if (t >= 0.8) return;
  const grow = Math.min(1, t / 0.12), rx = RX * (0.55 + 0.45 * grow), ry = RY * (0.55 + 0.45 * grow);
  const fade = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.35;
  const c = t < 0.1 ? C[4] : t < 0.25 ? C[3] : C[2];
  // each ring pixel once (blending the same pixel twice makes the ends heavier than the sides)
  const n = Math.ceil(rx * 7), seen = new Set();
  for (let i = 0; i < n; i++) {
    const g = (i / n) * TAU, s = Math.sin(g);
    if (far !== s < 0) continue;
    const x = Math.round(Math.cos(g) * rx), y = Math.round(s * ry), k = x * 64 + y;
    if (seen.has(k)) continue;
    seen.add(k);
    p.blend(x, y, c, (far ? 0.55 : 0.9) * fade);
  }
  // four rune ticks turning slowly around the ring
  for (let k = 0; k < 4; k++) {
    const g = (k / 4) * TAU + t * 1.6, s = Math.sin(g);
    if (far !== s < 0) continue;
    const x = Math.round(Math.cos(g) * rx), y = Math.round(s * ry);
    p.blend(x, y - 1, t < 0.2 ? C[4] : C[3], (far ? 0.5 : 0.85) * fade);
  }
}

// sparkles: born around the body low down, rise to head height (-32) and fade; brighter and whiter as they rise
function sparks(p, t, C, o, back) {
  const R = new Rng(o.seed);
  for (let i = 0; i < 5; i++) {
    const side = i % 2 ? 1 : -1, x0 = side * R.range(6, 11), t0 = 0.05 + i * 0.08 + R.range(0, 0.05);
    const life = R.range(0.55, 0.7), top = R.range(26, 34), isBack = i === 2;
    const age = t - t0;
    if (age < 0 || age >= life || isBack !== back) continue;
    const u = age / life, e = 1 - (1 - u) * (1 - u);
    const x = Math.round(x0 * (1 - 0.25 * u) + Math.sin(u * TAU + i) * 1), y = Math.round(-2 - e * top);
    // in fast, hold, then a white twinkle near the top and a quick fade (a slow fade reads as grey dust)
    const a = (u < 0.15 ? u / 0.15 : 1) * (u > 0.8 ? (1 - u) / 0.2 : 1);
    const c = u < 0.35 ? C[2] : u < 0.6 ? C[3] : C[4];
    p.blend(x, y, c, a);
    // a tiny cross while it climbs, a brighter one as it twinkles at the top
    const arm = u > 0.2 && u < 0.5 ? C[1] : u >= 0.6 && u < 0.8 ? C[3] : 0;
    if (arm) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.blend(x + dx, y + dy, arm, a * 0.6);
    // a short fading trail under it while it rises
    if (u < 0.6) p.blend(x, y + 1, C[1], a * 0.35);
  }
}

export function drawBack(p, t, o) {
  const C = fit(o.palette, 5);
  ring(p, t, C, true);
  sparks(p, t, C, o, true);
}

export function draw(p, t, o) {
  const C = fit(o.palette, 5);
  ring(p, t, C, false);
  sparks(p, t, C, o, false);
}
