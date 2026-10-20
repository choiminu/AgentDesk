// AgentDesk core: worktree diff view and review comments. Pure, dependency-free (clean() comes from core/team.js,
// which is loaded first in the renderer and in diff/git.mjs). Loaded as a classic <script> (global AgentDeskDiff) or
// imported for its side effect (`import "../core/diff.js"; const { parseUnified } = globalThis.AgentDeskDiff;`).
//
//   parseUnified(text, { maxLines })  → { hunks: [{ header, lines: [{ t: 'ctx'|'add'|'del', o, n, s, noNl? }] }], binary, truncated }
//   parseNumstat(z)                   → [{ path, oldPath, add, del, binary }]   (`git diff --numstat -z`)
//   parseNameStatus(z)                → [{ status: 'M'|'A'|'D'|'R'|…, path, oldPath }]  (`git diff --name-status -z`)
//   parsePorcelain(z)                 → [{ x, y, path, orig }]   (`git status --porcelain=v1 -z`)
//   safeRelPath(p)                    → p when it is a plain repo-relative path ('' for absolute / `..` / NUL / empty)
//   pathAllowed(p, list)              → safeRelPath(p) and p is one of list (the paths of the last diff-stat)
//   createSeq()                       → { next(key), isLatest(key, token) } — drop answers of superseded requests
//   commentMessage(comments, summary) → { text, count, sent, dropped } — one line typed into the session (no newline: it would submit early)
(function (root) {
'use strict';

const COMMENT_MAX = 500, COMMENTS_MAX = 20, SUMMARY_MAX = 500, PATH_MAX = 300;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseUnified(text, opts) {
  const maxLines = (opts && opts.maxLines) || 2000;
  const out = { hunks: [], binary: false, truncated: false };
  let hunk = null, o = 0, n = 0, leftOld = 0, leftNew = 0, count = 0;
  const src = String(text == null ? '' : text);
  if (!src) return out;
  const rows = src.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  for (const raw of rows) {
    // content keeps its bytes as they are (a line whose only change is a trailing CR must still differ);
    // headers are matched without a trailing CR
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (hunk && (leftOld > 0 || leftNew > 0)) {
      const c = raw[0];
      if (c === ' ' || c === '+' || c === '-' || line === '') {
        if (count >= maxLines) { out.truncated = true; break; }
        if (c === '+') { hunk.lines.push({ t: 'add', o: 0, n: n++, s: raw.slice(1) }); leftNew--; }
        else if (c === '-') { hunk.lines.push({ t: 'del', o: o++, n: 0, s: raw.slice(1) }); leftOld--; }
        else { hunk.lines.push({ t: 'ctx', o: o++, n: n++, s: raw.slice(1) }); leftOld--; leftNew--; }
        count++;
        continue;
      }
      if (c === '\\') { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noNl = true; continue; }
      // anything else inside a hunk means the input was cut or malformed: stop counting this hunk
      leftOld = leftNew = 0;
    }
    if (line[0] === '\\') { const last = hunk && hunk.lines[hunk.lines.length - 1]; if (last) last.noNl = true; continue; }
    const m = line.match(HUNK_RE);
    if (m) {
      if (count >= maxLines) { out.truncated = true; break; }
      o = Number(m[1]); n = Number(m[3]);
      leftOld = m[2] == null ? 1 : Number(m[2]); leftNew = m[4] == null ? 1 : Number(m[4]);
      hunk = { header: line, lines: [] }; out.hunks.push(hunk);
      continue;
    }
    // file headers (diff --git, index, ---/+++, mode, rename / similarity) are skipped; a binary marker is kept
    if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') out.binary = true;
    hunk = null;
  }
  if (hunk && (leftOld > 0 || leftNew > 0)) out.truncated = true;   // the last hunk ended early: cut input
  return out;
}

const zTokens = z => { const t = String(z == null ? '' : z).split('\0'); if (t.length && t[t.length - 1] === '') t.pop(); return t; };

function parseNumstat(z) {
  const t = zTokens(z), out = [];
  for (let i = 0; i < t.length; i++) {
    const m = t[i].match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/); if (!m) continue;
    let path = m[3], oldPath = '';
    if (path === '') { oldPath = t[++i] || ''; path = t[++i] || ''; }   // rename / copy: "a\td\t\0old\0new\0"
    if (!path) continue;
    const binary = m[1] === '-' || m[2] === '-';
    out.push({ path, oldPath, add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

function parseNameStatus(z) {
  const t = zTokens(z), out = [];
  for (let i = 0; i < t.length; i++) {
    const st = t[i]; if (!/^[A-Z][0-9]{0,3}$/.test(st)) continue;
    const s = st[0];
    if (s === 'R' || s === 'C') { const oldPath = t[++i] || '', path = t[++i] || ''; if (path) out.push({ status: s, path, oldPath }); }
    else { const path = t[++i] || ''; if (path) out.push({ status: s, path, oldPath: '' }); }
  }
  return out;
}

function parsePorcelain(z) {
  const t = zTokens(z), out = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i]; if (e.length < 4 || e[2] !== ' ') continue;
    const x = e[0], y = e[1], path = e.slice(3);
    let orig = '';
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') orig = t[++i] || '';   // "XY new\0old\0"
    out.push({ x, y, path, orig });
  }
  return out;
}

function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return '';
  if (/^[\/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return '';
  if (p.split(/[\/\\]/).some(seg => seg === '..' || seg === '')) return '';
  return p;
}
function pathAllowed(p, list) {
  const s = safeRelPath(p); if (!s) return false;
  if (list instanceof Set || list instanceof Map) return list.has(s);
  return Array.isArray(list) && list.includes(s);
}

function cleanText(s, max) {
  const T = root.AgentDeskTeam;
  if (T && T.clean) return T.clean(s, max);
  throw new Error('core/team.js must be loaded before core/diff.js is used');
}
// REPORT markers in a comment / path / summary would be taken for the session's own report block when it is read back
const noMarkers = s => String(s == null ? '' : s).replace(/REPORT_(START|END)/g, '');
// the one function behind both the confirm preview and what main.mjs types: same filter, same order.
// → { text, count, sent: [index into comments], dropped: [{ index, path, line, reason: 'bad-path'|'empty'|'limit' }] }
// A path only has to be a plain relative path (the file is not read, it only names the place in the message).
function commentMessage(comments, summary, lang) {
  const list = Array.isArray(comments) ? comments : [];
  const items = [], sent = [], dropped = [];
  list.forEach((c, index) => {
    const path0 = c && typeof c === 'object' ? c.path : '', line = c && Number.isInteger(c.line) && c.line > 0 && c.line < 1e8 ? c.line : 0;
    const drop = reason => dropped.push({ index, path: typeof path0 === 'string' ? path0 : '', line, reason });
    if (!c || typeof c !== 'object') return drop('empty');
    if (!safeRelPath(c.path)) return drop('bad-path');
    const text = cleanText(noMarkers(c.text), COMMENT_MAX), path = cleanText(noMarkers(c.path), PATH_MAX);
    if (!text || !path) return drop('empty');
    if (items.length >= COMMENTS_MAX) return drop('limit');
    const where = line ? `${path}:${line}${c.side === 'old' ? (lang === 'en' ? ' (old)' : ' (이전 줄)') : ''}` : path;
    items.push(`${items.length + 1}. ${where} — ${text}`); sent.push(index);
  });
  if (!items.length) return { text: '', count: 0, sent, dropped };
  const sum = cleanText(noMarkers(summary), SUMMARY_MAX);
  const parts = [lang === 'en' ? `[Review comments · ${items.length}]` : `[리뷰 코멘트 · ${items.length}건]`];
  if (sum) parts.push(lang === 'en' ? `Summary: ${sum}` : `요약: ${sum}`);
  parts.push(...items);
  parts.push(lang === 'en' ? 'Apply the comments above and, when done, report with the REPORT block.' : '위 코멘트를 반영하고, 끝나면 REPORT 블록으로 보고해 주세요.');
  return { text: parts.join(' '), count: items.length, sent, dropped };
}

// request ordering: next(key) hands out a token, isLatest(key, token) tells whether no newer request for that key
// started since — an answer that is not the latest is dropped (a scope toggled twice, a slow refresh)
function createSeq(maxKeys) {
  const m = new Map(), cap = maxKeys || 500;
  return {
    next(key) { if (m.size > cap && !m.has(key)) m.clear(); const n = (m.get(key) || 0) + 1; m.set(key, n); return n; },
    isLatest(key, token) { return m.get(key) === token; },
    forget(key) { m.delete(key); },
  };
}

const AgentDeskDiff = { createSeq, parseUnified, parseNumstat, parseNameStatus, parsePorcelain, safeRelPath, pathAllowed, commentMessage, COMMENT_MAX, COMMENTS_MAX };
root.AgentDeskDiff = AgentDeskDiff;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDiff;
})(typeof globalThis !== 'undefined' ? globalThis : this);
