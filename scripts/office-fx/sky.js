// AgentDesk office: what moves behind a 36 x 22 window pane, over the sky gradient the office paints.
// Baked by scripts/office-fx.mjs from a pixelfx checkout: day / dusk (clouds) and night (stars).
import { fit, rand, tileFbm } from "../../core/index.js";

export const meta = {
  name: "Window sky",
  desc: "Day and dusk: soft pixel clouds drift slowly across the pane and wrap round. Night: stars twinkle out of step and a shooting star crosses once a loop.",
  tags: ["office", "sky", "clouds", "stars", "loop"],
  size: [36, 22],
  origin: [0, 0],
  duration: 12,
  loop: true,
  fps: 10,
  bg: "sky",
  options: { palette: ["#c9def0", "#eef6ff", "#ffffff"], seed: 4, night: false },
};

export function draw(p, t, o) {
  const C = fit(o.palette, 3), W = 36, H = 22, ph = t / meta.duration;
  if (!o.night) {
    // clouds: two noise layers scrolled a whole number of tiles per loop (no seam), thresholded into hard steps,
    // with a darker underside so they read as puffs, not smears
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const hi = tileFbm((x / W) * 2 - ph * 2, y / 6, 2, 0, o.seed, 3) - Math.abs(y - 6) / 9;
      const lo = tileFbm((x / W) * 3 - ph * 3, y / 5 + 9, 3, 0, o.seed + 7, 2) - Math.abs(y - 15) / 7 - 0.08;
      const n = Math.max(hi, lo), under = Math.max(tileFbm((x / W) * 2 - ph * 2, (y - 2) / 6, 2, 0, o.seed, 3) - Math.abs(y - 2 - 6) / 9,
        tileFbm((x / W) * 3 - ph * 3, (y - 2) / 5 + 9, 3, 0, o.seed + 7, 2) - Math.abs(y - 2 - 15) / 7 - 0.08);
      if (n <= 0.1) continue;
      p.blend(x, y, n > 0.22 ? C[2] : under > 0.1 && n < 0.18 ? C[0] : C[1], n > 0.22 ? 0.95 : 0.8);
    }
    return;
  }
  for (let i = 0; i < 9; i++) {
    const x = Math.floor(rand(i, 1, o.seed) * (W - 2)) + 1, y = Math.floor(rand(i, 2, o.seed) * (H - 4)) + 1;
    const tw = Math.sin((ph * (2 + (i % 3)) + rand(i, 3, o.seed)) * Math.PI * 2);
    p.blend(x, y, tw > 0.6 ? C[2] : C[1], tw > -0.4 ? 1 : 0.35);
    if (tw > 0.85) { p.blend(x - 1, y, C[1], 0.5); p.blend(x + 1, y, C[1], 0.5); p.blend(x, y - 1, C[1], 0.5); p.blend(x, y + 1, C[1], 0.5); }
  }
  // a shooting star in the middle of the loop: a short tail sliding down-left
  const s = (ph - 0.55) / 0.06;
  if (s >= 0 && s <= 1) for (let k = 0; k < 6; k++) {
    const x = Math.round(30 - s * 24 + k), y = Math.round(2 + s * 9 - k * 0.4);
    if (x >= 0 && x < W && y >= 0 && y < H) p.blend(x, y, C[2], (1 - k / 6) * (1 - s * 0.6));
  }
}
