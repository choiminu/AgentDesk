#!/usr/bin/env node
// widget.html keeps Korean source strings and translates them to English through the I18N map: t('…') in the script,
// and the page translator (i18nApply) for Korean text, title, placeholder and aria-label that reach the DOM.
// This check fails when English mode would still show Korean:
//   - a t('literal') call whose literal has no I18N key (exact or trimmed match), and
//   - any other Korean string literal / template-literal piece / static markup text that still holds Korean after
//     the same substitution t() does at runtime.
// Not checked: comments, regex literals, the I18N map itself, text under a data-verbatim element in static markup,
// literals in the Korean arm of a language branch (LANG === 'en' ? … : '…'), and entries in scripts/i18n-allow.json.
//   node scripts/i18n-check.mjs          → lists the misses, exit 1 when there are any
//   node scripts/i18n-check.mjs --json   → the same as JSON
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HAN = /[가-힣]/;
// helpers that pass their argument through t() (the ko arm strips a namespace prefix such as "도크: ")
const WRAPPERS = ["t", "dockT", "inboxT", "tlT"];
const WRAP_RE = new RegExp(`(?:^|[^\\w$.])(?:${WRAPPERS.join("|")})\\(\\s*$`);
// the Korean arm of `LANG === 'en' ? english : korean` (also `en ? … : …`, `LANG === 'ko' ? korean : english`), looked
// for in the literal's own statement (back to the previous ";", at most 6 lines), and the `return korean` that follows
// `if (LANG === 'en') return english;`
const BRANCH_RE = /(?:\bLANG\s*[!=]==?\s*'(?:en|ko)'|(?:^|[^\w$.])(?:en|ko|isEn|isKo))\s*\?/;
const EN_RETURN_RE = /if\s*\(\s*LANG\s*===\s*'en'\s*\)\s*return\b[^\n]*;\s*return\s*$/;

// ── a small JS lexer: string / template / regex literals and comments ──
// Returns { strings: [{ quote, text, start, end }], pieces: template quasis as { quote: '`', text, start, end, tpl } }.
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
export function lexLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prev = "";   // last significant token: an identifier/keyword, a number marker "0", or a punctuator char
  const regexAllowed = () => {
    if (!prev) return true;
    if (/^[\w$]/.test(prev)) return KEYWORDS_BEFORE_REGEX.has(prev);
    return !/[)\]}]/.test(prev);
  };
  const readQuoted = (q) => {
    const s = i; i++;
    while (i < n && src[i] !== q) { if (src[i] === "\\") i++; else if (src[i] === "\n") break; i++; }
    i++;
    out.push({ quote: q, text: src.slice(s + 1, i - 1), start: s, end: i });
  };
  const readTemplate = () => {
    const s = i; i++;
    let pieceStart = i;
    const tpl = { start: s, pieces: [] };
    for (;;) {
      if (i >= n) break;
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { tpl.pieces.push({ text: src.slice(pieceStart, i), start: pieceStart, end: i }); i++; break; }
      if (c === "$" && src[i + 1] === "{") {
        tpl.pieces.push({ text: src.slice(pieceStart, i), start: pieceStart, end: i });
        i += 2; prev = "{";
        code(true);
        i++;   // the closing }
        pieceStart = i;
        continue;
      }
      i++;
    }
    tpl.end = i;
    for (const p of tpl.pieces) out.push({ quote: "`", text: p.text, start: p.start, end: p.end, tpl });
  };
  const readRegex = () => {
    i++;
    let cls = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "\n") break;
      if (cls) { if (c === "]") cls = false; }
      else if (c === "[") cls = true;
      else if (c === "/") { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
  };
  function code(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === "'" || c === '"') { readQuoted(c); prev = "0"; continue; }
      if (c === "`") { readTemplate(); prev = "0"; continue; }
      if (c === "/") { if (regexAllowed()) { readRegex(); prev = "0"; } else { i++; prev = "/"; } continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (/[\w$]/.test(c)) { const s = i; while (i < n && /[\w$]/.test(src[i])) i++; prev = src.slice(s, i); if (/^\d/.test(prev)) prev = "0"; continue; }
      if (c === "{") depth++;
      if (c === "}") { if (untilBrace && depth === 0) return; depth--; }
      prev = c; i++;
    }
  }
  code(false);
  return out;
}

export function loadI18n(html) {
  const start = html.indexOf("const I18N = {");
  const end = html.indexOf("const I18N_KEYS");
  if (start < 0 || end < 0) throw new Error("I18N map not found in widget.html");
  const I18N = Function(html.slice(start, end) + "\nreturn I18N;")();
  return { I18N, start, end };
}
export function makeTr(I18N) {
  const keys = Object.keys(I18N).sort((a, b) => b.length - a.length);
  return (s) => {
    if (I18N[s] != null) return I18N[s];
    const tt = s.trim();
    if (I18N[tt] != null) return s.replace(tt, I18N[tt]);
    let o = s;
    for (const k of keys) if (o.includes(k)) o = o.split(k).join(I18N[k]);
    return o;
  };
}
const unescapeJs = s => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) =>
  e[0] === "u" ? String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16)) : e[0] === "x" ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: "\n", t: "\t" }[e] ?? e));

// the timeline's own short-word dictionary (TL_EN, used through tlT): kept out of I18N on purpose (see widget.html)
export function loadTimelineWords(html) {
  const m = /const TL_EN = (\{[\s\S]*?\});/.exec(html);
  return m ? Function(`return ${m[1]};`)() : {};
}
export function checkWidgetI18n(html, allow = {}) {
  const { I18N, start: mapStart, end: mapEnd } = loadI18n(html);
  const TL = loadTimelineWords(html);
  const tr = makeTr(I18N);
  const lineStarts = [0];
  for (let k = 0; k < html.length; k++) if (html[k] === "\n") lineStarts.push(k + 1);
  const lineOf = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  // allow.strings: exact Korean runs that may stay (removed from a piece before it is checked); allow.patterns: regexes
  // for whole pieces that may stay. Group entries by reason in scripts/i18n-allow.json.
  const allowStrings = Object.values(allow.strings || {}).flat().sort((x, y) => y.length - x.length);
  const allowRe = Object.values(allow.patterns || {}).flat().map(p => new RegExp(p));
  const strip = s => { for (const a of allowStrings) s = s.split(a).join(""); return s; };
  const allowed = s => allowRe.some(r => r.test(s)) || !HAN.test(strip(s));

  const missingKeys = [], untranslated = [];
  // inline scripts
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const base = m.index + m[0].indexOf(">") + 1;
    for (const lit of lexLiterals(m[1])) {
      const pos = base + lit.start;
      if (pos >= mapStart && pos < mapEnd) continue;   // the dictionary itself
      const text = lit.quote === "`" ? lit.text : unescapeJs(lit.text);
      if (!HAN.test(text)) continue;
      const before = m[1].slice(Math.max(0, lit.start - 40), lit.start);
      const litStart = lit.tpl ? lit.tpl.start : lit.start;   // a template piece: its statement starts before the backtick
      let from = litStart;
      for (let k = 0; k < 6 && from > 0; k++) from = m[1].lastIndexOf("\n", from - 1);
      const head = m[1].slice(Math.max(0, from), litStart), stmt = head.slice(head.lastIndexOf(";") + 1);
      const wrapped = lit.quote !== "`" && WRAP_RE.test(before) && /^\s*[),]/.test(m[1].slice(lit.end, lit.end + 4));
      if (allowed(text)) continue;
      if (TL[text] != null) continue;   // a timeline word (TL_KIND / TL_STATE values, tlT('…'))
      if (wrapped) {
        if (I18N[text] == null && I18N[text.trim()] == null && HAN.test(tr(text))) missingKeys.push({ line: lineOf(pos), text });
        continue;
      }
      if (BRANCH_RE.test(stmt) || EN_RETURN_RE.test(head)) continue;
      // template pieces: check the Korean runs between markup and ${…}
      if (HAN.test(tr(strip(text)))) untranslated.push({ line: lineOf(pos), text: text.trim() });
    }
  }
  // static markup outside <script>/<style>; a line whose only Korean sits right inside a data-verbatim element is skipped
  const blank = s => s.replace(/[^\n]/g, " ");
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, blank).replace(/<style[\s\S]*?<\/style>/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
  const lines = markup.split("\n");
  lines.forEach((ln, idx) => {
    if (/data-verbatim/.test(ln) && !/>[^<]*[가-힣]/.test(ln.replace(/<[^>]*data-verbatim[^>]*>[^<]*/g, ""))) return;
    for (const mm of ln.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) if (!allowed(mm[1]) && HAN.test(tr(strip(mm[1])))) untranslated.push({ line: idx + 1, text: mm[1].trim() });
    for (const mm of ln.matchAll(/(?:title|placeholder|aria-label)="([^"]*[가-힣][^"]*)"/g)) if (!allowed(mm[1]) && HAN.test(tr(strip(mm[1])))) untranslated.push({ line: idx + 1, text: "[attr] " + mm[1] });
  });
  return { keys: Object.keys(I18N).length, missingKeys, untranslated };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const html = readFileSync(join(root, "widget.html"), "utf-8");
  let allow = {};
  try { allow = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "i18n-allow.json"), "utf-8")); } catch {}
  const r = checkWidgetI18n(html, allow);
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    for (const x of r.missingKeys) console.log(`widget.html:${x.line}  t() without an I18N key: ${x.text}`);
    for (const x of r.untranslated) console.log(`widget.html:${x.line}  Korean left in English mode: ${x.text.slice(0, 120)}`);
    console.log(r.missingKeys.length + r.untranslated.length ? `i18n: ${r.missingKeys.length} t() keys missing, ${r.untranslated.length} untranslated pieces` : `i18n: ok (${r.keys} keys)`);
  }
  process.exit(r.missingKeys.length + r.untranslated.length ? 1 : 0);
}
