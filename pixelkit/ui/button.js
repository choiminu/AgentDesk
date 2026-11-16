// Buttons in three states — "normal", "raised" (the pointer is over it: lifted one pixel on a taller foot) and
// "pressed" (pushed down onto its foot). All three sources are 16 x 16 and are sized with nineSlice, so a button
// keeps its outer box in every state and the layout around it never jumps.

import { Canvas } from "../core/canvas.js";
import { RAMP, INK, shade, tint } from "../core/color.js";
import { nineSlice } from "./nine.js";

export const BUTTON_STATES = ["normal", "raised", "pressed"];
// the middle band (rows 5..9) is plain face in all three states, so it can repeat without leaving a stripe
export const BUTTON_INSET = { l: 5, r: 5, t: 5, b: 6 };
// where the face starts in each state, and so how far the caption moves
const FACE_TOP = { normal: 2, raised: 1, pressed: 4 };
const FACE_H = 10;

/** A button's 16 x 16 source. state: one of BUTTON_STATES; color: a ramp name from the palette. */
export function buttonSource(state = "normal", color = "mint") {
  const r = RAMP[color];
  if (!r) throw new Error(`ui: unknown ramp "${color}"`);
  if (!BUTTON_STATES.includes(state)) throw new Error(`ui: unknown button state "${state}"`);
  const g = new Canvas(16, 16), top = FACE_TOP[state], y0 = top - 1;
  g.roundRect(0, y0, 16, 16 - y0, INK, 2);
  g.roundRect(1, top, 14, 14 - top + 1, r[0], 1);                                   // the foot shows below the face
  const face = state === "pressed" ? r[1] : state === "raised" ? tint(r[2], 0.3) : r[2];
  g.roundRect(1, top, 14, FACE_H, face, 1);
  if (state === "pressed") g.hline(top, 2, 13, shade(r[1], 0.18));                  // pressed in: a shadow under the top edge
  else { g.hline(top, 2, 13, state === "raised" ? tint(r[3], 0.5) : r[3]); g.hline(top + FACE_H - 1, 2, 13, r[1]); }
  return g;
}

/**
 * A button at w x h (at least 10 x 16). opts: { color, label: caption in the label font, icon: a canvas to
 * centre on the face (to the left of the label when both are given) }.
 */
export function button(state, w, h = 16, { color = "mint", label = "", icon = null } = {}) {
  const g = nineSlice(buttonSource(state, color), BUTTON_INSET, w, h);
  const top = FACE_TOP[state], faceH = h - (16 - FACE_H), [tw, th] = label ? Canvas.textSize(label) : [0, 0];
  const total = (icon ? icon.w : 0) + (icon && label ? 2 : 0) + tw;
  let x = Math.round((w - total) / 2);
  if (icon) { g.blit(icon, x, top + Math.round((faceH - icon.h) / 2)); x += icon.w + 2; }
  if (label) g.text(label, x, top + Math.round((faceH - th) / 2), INK);
  return g;
}
