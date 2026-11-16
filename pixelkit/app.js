// What the app loads from pixelkit, as a list of { name, canvas }: the twelve characters' sheets and the dock's
// street. tools/export-app.mjs writes these to assets/pixel/town/; the tests compare the files with this list.

import * as C from "./char/index.js";
import * as T from "./tile/index.js";

/** The characters in file order: char_0 is the first. */
export const APP_CHARS = Object.keys(C.PRESETS);

/** Every exported picture, by file name (without ".png"), drawn fresh. */
export function appFiles() {
  const out = [];
  APP_CHARS.forEach((name, i) => {
    out.push({ name: `char_${i}`, canvas: C.baseSheet(C.PRESETS[name]) });
    for (const action of Object.keys(C.ACTIONS)) out.push({ name: `char_${i}_${action}`, canvas: C.actionSheet(C.PRESETS[name], action) });
  });
  for (const kind of ["day", "dusk", "night"]) out.push({ name: `street_sky_${kind}`, canvas: T.streetSky(kind) });
  const front = T.street(), lit = T.street({ lit: true }), lights = lit.clone();
  for (let y = 0; y < lit.h; y++) for (let x = 0; x < lit.w; x++) if (lit.get(x, y) === front.get(x, y) || !front.get(x, y)) lights.clear(x, y, 1, 1);   // only what the night switches on
  out.push({ name: "street_front", canvas: front }, { name: "street_front_lit", canvas: lit }, { name: "street_lights", canvas: lights });
  out.push({ name: "street_lamp", canvas: T.streetLamp() }, { name: "street_lamp_lit", canvas: T.streetLamp({ lit: true }) });
  out.push({ name: "street_cloud", canvas: T.streetCloud() });
  return out;
}
