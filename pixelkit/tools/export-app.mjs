#!/usr/bin/env node
// Write the pictures the app loads into assets/pixel/town/: char_0 … char_11 (the 112 x 96 base sheets), their
// _umbrella / _jump / _carry action sheets, and the dock's street (street_*.png). Run it again after changing a
// drawing; the same code always writes the same bytes.
//
//   node pixelkit/tools/export-app.mjs            write the files
//   node pixelkit/tools/export-app.mjs --out dir  write them somewhere else
//   node pixelkit/tools/export-app.mjs --check    write nothing; exit 1 if a file on disk differs from what would be written
//
// Note: scripts/office-town.mjs also writes char_0 … char_11 here (the earlier drawings). Run this one last.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { savePNG, fromPNG } from "../core/index.js";
import { appFiles } from "../app.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2), at = args.indexOf("--out");
const out = at >= 0 ? args[at + 1] : join(ROOT, "assets", "pixel", "town"), check = args.includes("--check");

let stale = 0;
for (const { name, canvas } of appFiles()) {
  const file = join(out, `${name}.png`);
  if (check) {
    const same = existsSync(file) && fromPNG(readFileSync(file)).equals(canvas);   // pixels: the zlib build changes the bytes, not the picture
    if (!same) { stale++; console.log(`stale  ${name}.png`); }
  } else {
    savePNG(file, canvas);
    console.log(`${name}.png  ${canvas.w} x ${canvas.h}`);
  }
}
if (check) { console.log(stale ? `${stale} files differ: run node pixelkit/tools/export-app.mjs` : "all files are up to date"); process.exit(stale ? 1 : 0); }
