#!/usr/bin/env node
// Hold every drawing to its spec: exact size and frame grid, a color limit, no stray or translucent pixels,
// nothing cut off at a frame's edge, tiles that meet themselves and their neighbours, the same picture every
// time, and no unseeded randomness anywhere in the source.
//
//   node pixelkit/tools/check.mjs              everything
//   node pixelkit/tools/check.mjs char floor   chosen groups, ids or prefixes
//
// Exits 1 if anything fails. Notes ("warn") do not fail the run; read them anyway.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { byId, select } from "../catalog.js";
import { checkItem, unseeded } from "./lib/checks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let items;
try { items = select(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }

let fails = 0, warns = 0;
for (const it of items) {
  const { errors, notes } = checkItem(it, byId);
  if (errors.length) fails++;
  if (notes.length) warns++;
  const tag = errors.length ? "FAIL" : notes.length ? "warn" : "ok  ";
  if (errors.length || notes.length || items.length < 30) console.log(`${tag}  ${it.id}${[...errors, ...notes].map((s) => "\n      " + s).join("")}`);
}
const random = unseeded(ROOT);
for (const r of random) console.log(`FAIL  ${r.file}:${r.line}\n      calls the unseeded generator: use Rng / rand from core/math.js so the picture repeats`);
fails += random.length;
console.log(`\n${items.length} drawings: ${items.length - fails + random.length} pass, ${fails} fail, ${warns} with notes`);
process.exit(fails ? 1 : 0);
