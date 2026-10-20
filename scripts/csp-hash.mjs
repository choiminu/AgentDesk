#!/usr/bin/env node
// widget.html runs under a Content-Security-Policy that allows exactly one inline <script> by its sha256 hash — no
// 'unsafe-inline', so injected markup (an onerror=, a <script> in a teammate's text) can never run.
// Any edit to the inline script changes the hash:
//   node scripts/csp-hash.mjs           → checks (exit 1 when stale)
//   node scripts/csp-hash.mjs --write   → rewrites the hash in widget.html
// `npm test` checks it too, and a dev run (`npm start`) logs an error when it is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const META_RE = /(<meta http-equiv="Content-Security-Policy" content="[^"]*'sha256-)([A-Za-z0-9+\/=]+)('[^"]*">)/;
// the inline scripts (no src attribute), exactly as the browser hashes them
export function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}
export const scriptHash = text => createHash("sha256").update(text, "utf8").digest("base64");
export function checkWidgetCsp(file) {
  const html = readFileSync(file, "utf-8");
  const m = html.match(META_RE), scripts = inlineScripts(html);
  const want = scripts.length === 1 ? scriptHash(scripts[0]) : "";
  return { ok: !!m && !!want && m[2] === want, have: m ? m[2] : "", want, inline: scripts.length, html };
}
export function writeWidgetCsp(file) {
  const r = checkWidgetCsp(file);
  if (r.ok) return false;
  if (r.inline !== 1 || !r.have) throw new Error(`expected one inline <script> and a CSP meta tag with a sha256 source (found ${r.inline} inline scripts)`);
  writeFileSync(file, r.html.replace(META_RE, `$1${r.want}$3`));
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "widget.html");
  if (process.argv.includes("--write")) { console.log(writeWidgetCsp(file) ? "widget.html: CSP hash updated" : "widget.html: CSP hash already current"); }
  else { const r = checkWidgetCsp(file); console.log(r.ok ? "widget.html: CSP hash ok" : `widget.html: CSP hash stale (have ${r.have || "none"}, want ${r.want}) — run: node scripts/csp-hash.mjs --write`); process.exit(r.ok ? 0 : 1); }
}
