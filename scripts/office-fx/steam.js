// AgentDesk office: steam off a hot drink. Baked by scripts/office-fx.mjs from a pixelfx checkout.
import { fit, TAU } from "../../core/index.js";

export const meta = {
  name: "Office steam",
  desc: "Two or three thin wisps curl up off a hot drink, swaying wider as they rise, and thin out to nothing.",
  tags: ["office", "steam", "coffee", "loop"],
  size: [12, 18],
  origin: [6, 17],
  duration: 2,
  loop: true,
  fps: 15,
  bg: "dark",
  options: { palette: ["#9aa0ae", "#d3d6df", "#f6f7fb"], seed: 5 },
};

export function draw(p, t, o) {
  const C = fit(o.palette, 3), w = (t / meta.duration) * TAU;
  // two wisps, each a column of pixels whose sideways sway grows with height; a bright band travels up each one
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1, ph = i * 2.4 + o.seed;
    for (let y = 0; y > -15; y--) {
      const h = -y / 15, x = Math.round(side * 0.6 + Math.sin(-y * 0.42 - w * (i ? 1 : 2) + ph) * (0.3 + 2.4 * h));
      const band = 0.5 + 0.5 * Math.sin(-y * 0.5 + w * (i ? 2 : 3) + ph), a = (1 - h) * (0.25 + 0.55 * band) * Math.min(1, -y / 2 + 0.4);
      if (a < 0.08) continue;
      p.blend(x, y, band > 0.6 && h < 0.5 ? C[2] : h < 0.6 ? C[1] : C[0], a);
    }
  }
}
