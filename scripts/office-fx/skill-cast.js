// AgentDesk office: the skill book — when an agent uses a skill a small book pops over its head and flips open, light and
// sparkles pour up out of the pages, and a thin rune ring turns at the feet. `compact` is the dock tile's cut: the book
// sits just over the head and the sparkles stay low, so it all fits in a 56 px tile. Baked by scripts/office-fx.mjs.
import { fit, TAU, Rng, seg, ease } from "../../core/index.js";

export const meta = {
  name: "Office skill book",
  desc: "A small book pops over the head and flips open; light and sparkles pour up out of its pages; a thin rune ring turns at the feet.",
  tags: ["office", "skill", "cast", "book", "oneshot"],
  size: [56, 64],
  origin: [28, 58],   // feet of a 16 x 32 office character
  duration: 1.45,
  loop: false,
  fps: 20,
  bg: "dark",
  options: { palette: ["#3a2470", "#6a46c4", "#9d78f0", "#d6c4ff", "#ffffff"], seed: 7, compact: false },
};

const CLOSED = ["#######", "#ccccc#", "#ccwcc#", "#cwwwc#", "#ccwcc#", "#ccccc#", "#ccccc#", "#######", ".pppppp"];
const OPEN = [".####.####.", "#pppp#pppp#", "#pllp#pllp#", "#pppp#pppp#", "#plpp#pplp#", "#pppp#pppp#", "#pllp#pllp#", ".####e####.", "....eee...."];
const BOOK = { "#": "#3a2470", c: "#7c58cf", w: "#ffffff", p: "#f4ecff", l: "#9d78f0", e: "#3a2470" };

// the ring: a 2 px ellipse band with a faint floor inside, grows in fast, white-hot then purple, rune marks turning on it
function ring(p, t, C, far) {
  const end = 0.9, rx0 = 14, ry0 = 4;
  if (t >= end) return;
  const g = ease.outBack(seg(t, 0, 0.14)), rx = rx0 * (0.35 + 0.65 * g), ry = ry0 * (0.35 + 0.65 * g);
  const fade = 1 - seg(t, end - 0.35, end), hot = t < 0.08 ? C[4] : t < 0.22 ? C[3] : C[2];
  if (far) p.ellipse(0, 0, rx, ry, C[1], (d) => (d < 0.82 ? 0.3 * fade * (0.4 + 0.6 * d) : 0));
  p.shade(-rx - 1, -ry - 1, rx + 1, ry + 1, (x, y, o) => {
    if (far ? y >= 0 : y < 0) return;
    const dx = x / rx, dy = y / ry, d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1 || d < 0.7) return;
    o.c = d > 0.86 ? hot : C[2];
    o.a = (far ? 0.75 : 1) * fade;
  });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + t * 2.2, s = Math.sin(a);
    if (far !== s < 0) continue;
    p.rect(Math.round(Math.cos(a) * rx * 0.86) - 1, Math.round(s * ry * 0.86) - 2, 2, 2, t < 0.3 ? C[4] : C[3], (far ? 0.7 : 1) * fade);
  }
  if (!far) p.glow(0, 0, rx + 4, C[2], 0.35 * fade);
}

function book(p, t, C, o) {
  const u = seg(t, 0, 1.35);
  if (u <= 0 || u >= 1) return;
  const a = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1, pop = ease.outBack(seg(u, 0, 0.1));
  if (pop < 0.3) return;
  // top row of the book: over the head in the office, just over the visible head on a dock tile
  const y = o.compact ? -37 - Math.round(1 * ease.outQuart(seg(u, 0, 0.3))) : Math.round(-50 - 3 * ease.outQuart(seg(u, 0, 0.3)));
  const open = u > 0.16, rows = open ? OPEN : CLOSED, w = rows[0].length;
  const b = seg(u, 0.16, 0.3) * (1 - seg(u, 0.55, 0.85));   // light out of the pages, behind the book
  if (b > 0) { p.glowLine(0, y, 0, y - (o.compact ? 6 : 14), 6, C[3], 0.8 * b); p.glow(0, y + 4, 12, C[2], 0.6 * b); }
  p.sprite(rows, BOOK, -Math.floor(w / 2), y, { a });
  if (!open) p.glow(0, y + 4, 8, C[2], 0.35 * a);
  // sparkles out of the pages: up over the book in the office, out to the sides on a tile (no room above)
  const R = new Rng(o.seed);
  for (let i = 0; i < 10; i++) {
    const t0 = 0.22 + i * 0.045 + R.range(0, 0.04), life = R.range(0.4, 0.6), dx = R.range(-12, 12) * (o.compact ? 1.4 : 1), up = o.compact ? R.range(-2, 4) : R.range(10, 20);
    const s = (u * 1.35 - t0) / life;
    if (s <= 0 || s >= 1) continue;
    const x = Math.round(dx * ease.outQuad(s)), yy = Math.round(y + 2 - up * ease.outQuad(s)), al = (s > 0.7 ? (1 - s) / 0.3 : 1) * a;
    p.blend(x, yy, s < 0.5 ? C[4] : C[3], al);
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.blend(x + ex, yy + ey, C[2], al * 0.6);
    p.light(x, yy, C[3], 0.3 * al);
  }
}

export function drawBack(p, t, o) {
  const C = fit(o.palette, 5);
  ring(p, t, C, true);
}

export function draw(p, t, o) {
  const C = fit(o.palette, 5);
  ring(p, t, C, false);
  book(p, t, C, o);
}
