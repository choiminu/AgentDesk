#!/usr/bin/env node
// Render drawings to a contact sheet: enlarged, labelled, on a checkerboard that shows what is transparent.
// Open the PNG and look — that is the whole point.
//
//   node pixelkit/tools/render.mjs                    one sheet per group: records/char.png, tile.png, ui.png
//   node pixelkit/tools/render.mjs char               one group
//   node pixelkit/tools/render.mjs floor icon/gear    chosen items on one sheet (records/pick.png)
//   node pixelkit/tools/render.mjs "icon/*" --name icons --zoom 8 --width 1200
//   node pixelkit/tools/render.mjs --list             what there is

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { savePNG } from "../core/index.js";
import { CATALOG, GROUPS, select } from "../catalog.js";
import { contactSheet } from "./lib/sheet.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args.splice(i, 2)[1]; };
const out = flag("out", join(ROOT, "records")), zoom = flag("zoom"), width = +flag("width", 1600), name = flag("name", "pick");
if (args.includes("--list")) { for (const it of CATALOG) console.log(`${it.group.padEnd(5)} ${it.id}`); process.exit(0); }

function sheet(items, title, file) {
  const cells = items.map((it) => ({ label: it.id, canvas: (it.show ?? it.draw)(), zoom: zoom ? +zoom : it.zoom, bg: it.bg, br: it.br }));
  const path = savePNG(join(out, `${file}.png`), contactSheet(cells, { title, width }));
  console.log(`${path}  (${items.length} items)`);
}

try {
  const groupsOnly = args.every((a) => GROUPS.includes(a));
  if (groupsOnly) for (const g of args.length ? args : GROUPS) sheet(select([g]), `pixelkit ${g}`, g);
  else sheet(select(args), `pixelkit ${args.join(" ")}`, name);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
