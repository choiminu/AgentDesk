// Panels: 24 x 24 sources drawn here, sized with nineSlice. A soft ink line with rounded corners and a heavier
// foot, so a panel sits on the page like the office's furniture does.

import { Canvas } from "../core/canvas.js";
import { hex, RAMP, INK, WHITE } from "../core/color.js";
import { nineSlice } from "./nine.js";

function box(fill, top, foot) {
  const g = new Canvas(24, 24);
  g.roundRect(0, 0, 24, 24, INK, 2);
  g.roundRect(1, 1, 22, 21, fill, 1);          // the line is 1 px, the foot 2
  g.hline(1, 2, 21, top);
  g.hline(21, 2, 21, foot);
  return g;
}

// name -> { source: () => Canvas, inset, ink: the color text on it should use }
export const PANELS = {
  /** A cream sheet: the everyday panel. */
  paper: { inset: 6, ink: INK, source: () => box(hex("#fffaf0"), WHITE, hex("#e9dfcb")) },
  /** A dark panel for overlays and tooltips. */
  dark: { inset: 6, ink: hex("#f6f0e2"), source: () => box(RAMP.slate[0], RAMP.slate[1], hex("#2f3547")) },
  /** A sheet with a colored title bar. */
  window: {
    inset: { l: 6, r: 6, t: 12, b: 6 }, ink: INK,
    source: () => {
      const g = box(hex("#fffaf0"), WHITE, hex("#e9dfcb")), c = RAMP.lilac;
      g.roundRect(1, 1, 22, 8, c[2], 1); g.hline(1, 2, 21, c[3]); g.hline(8, 1, 22, c[1]);
      g.hline(9, 1, 22, INK);
      g.hline(10, 1, 22, WHITE);
      return g;
    },
  },
  /** A sticky note with a turned-up corner. */
  note: {
    inset: 7, ink: INK,
    source: () => {
      const c = RAMP.sun, g = box(c[3], hex("#fffbe6"), c[2]);
      g.clear(18, 18, 6, 6);
      for (let i = 0; i < 6; i++) { g.set(18 + i, 23 - i, INK); for (let j = 0; j < 5 - i; j++) g.set(18 + i, 18 + j, c[2]); }   // the fold
      g.hline(17, 18, 23, INK); g.vline(17, 18, 23, INK); g.set(17, 17, c[3]);
      g.hline(23, 3, 17, INK); g.vline(23, 3, 17, INK); g.hline(22, 2, 16, INK); g.hline(21, 2, 16, c[2]);
      return g;
    },
  },
};

/** A panel's 24 x 24 source. */
export function panelSource(style = "paper") {
  if (!PANELS[style]) throw new Error(`ui: unknown panel "${style}"`);
  return PANELS[style].source();
}
/** A panel at w x h. opts: { title: text for a "window" panel's bar }. */
export function panel(style, w, h, { title } = {}) {
  const g = nineSlice(panelSource(style), PANELS[style].inset, w, h);
  if (title && style === "window") g.text(title, 5, 3, INK);
  return g;
}
