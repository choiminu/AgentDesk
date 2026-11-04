// AgentDesk office: status lights on a rack cabinet (Kenney's k_rack_a / k_rack_b, 16 x 32), drawn over the sprite.
// Baked by scripts/office-fx.mjs from a pixelfx checkout.
import { fit, rand } from "../../core/index.js";

export const meta = {
  name: "Rack lights",
  desc: "A column of status LEDs on a cabinet face: most hold green, some blink amber at their own pace, one flickers blue like disk activity.",
  tags: ["office", "server", "led", "blink", "loop"],
  size: [16, 32],
  origin: [0, 0],
  duration: 2.4,
  loop: true,
  fps: 10,
  bg: "dark",
  // face: the panel's x range on the sprite (k_rack_a: 2..5, k_rack_b: 10..13)
  options: { palette: ["#1f6b3a", "#3ee07a", "#e8a33d", "#6fc0ff"], seed: 2, face: [2, 5] },
};

export function draw(p, t, o) {
  const [dim, green, amber, blue] = fit(o.palette, 4), [x0, x1] = o.face, f = Math.floor(t * meta.fps);
  for (let y = 3; y <= 16; y += 2) for (let x = x0; x <= x1; x += 3) {
    const k = rand(x, y, o.seed);
    if (k < 0.2) continue;                                              // an empty slot
    let c = green, on = true;
    if (k > 0.8) { c = amber; on = Math.floor(f / (2 + Math.floor(k * 10) % 3)) % 2 === 0; }
    else if (k > 0.72) { c = blue; on = rand(f, x * 31 + y, o.seed) > 0.45; }
    else on = rand(Math.floor(f / 6), x + y * 17, o.seed) > 0.08;      // a rare blink on the steady ones
    p.px(x, y, on ? c : dim);
  }
}
