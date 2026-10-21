// AgentDesk core: secret masking shared by recall/ (session notes), team/ (what goes to / comes from teammates) and the
// renderer. Pure, dependency-free. Loaded as a classic <script> (global AgentDeskMask) or imported for its side effect
// (`import "../core/mask.js"; const { mask } = globalThis.AgentDeskMask;`).
//
//   maskLines(lines) → mask() per line, and every line of a multi-line private key block
//   secretRanges(s) → [[start, end), …] of what mask() would replace
//   mask(s) → s with tokens, keys, connection URIs, card / account numbers and e-mail addresses replaced by [MASKED]
//   hasCredential(s) → true when s holds a token / key / password=… / connection URI / private key (the mask() rules
//                      minus e-mail and card-number ones; zero-width / full-width tricks included)
//   maskWithCount(s) → { text: mask(s), count: how many [MASKED…] markers mask() added }
//   maskForSend(s, opts) → body for an outbound send (input over 100 KB refused) (Jira comment, Slack reply): masked FIRST, then empty / length checks
//                          → { ok: true, text, masked } | { ok: false, error }
(function (root) {
'use strict';
// every repetition is bounded ({m,n}), so no input can make a pattern backtrack for long (a 100 KB adversarial
// string stays in the low milliseconds); callers also cut their input before masking
const SECRET_RES = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '[MASKED PRIVATE KEY]'],
  [/\b(sk|rk|pk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,256}\b/g, '[MASKED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,256}\b/g, '[MASKED]'], [/\bgithub_pat_[A-Za-z0-9_]{20,256}\b/g, '[MASKED]'],
  // AWS: access key ids, and a 40-char secret next to an aws/secret keyword
  [/\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, '[MASKED]'],
  [/((?:aws)?_?secret(?:_access)?_?key[ \t]{0,8}[=:][ \t]{0,8}["']?)[A-Za-z0-9\/+=]{40}\b/gi, '$1[MASKED]'],
  // Slack: bot / app-level / user tokens
  [/\bxox[baprse]-[A-Za-z0-9-]{10,256}\b/g, '[MASKED]'], [/\bxapp-[A-Za-z0-9-]{10,256}\b/g, '[MASKED]'],
  [/\bAIza[0-9A-Za-z_-]{30,256}\b/g, '[MASKED]'], [/\beyJ[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{10,4096}\b/g, '[MASKED]'],
  [/(Bearer[ \t]{1,8})[A-Za-z0-9._~+\/=-]{8,1024}/gi, '$1[MASKED]'],
  // key = value in any common shape: password=x, DB_PASSWORD=x, a.b.password: x, {"password": "x y"}, token: 'x';
  // a quoted value may hold spaces (up to its closing quote); values of 4+ characters ("token: 5", "secret: yes" stay)
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)["']?[ \t]{0,8}[=:][ \t]{0,8}(["']?))(?!\[MASKED)(?:(?<=")[^"\n]{4,256}(?=")|(?<=')[^'\n]{4,256}(?=')|[^\s"'&,;}]{4,256})/gi, '$1[MASKED]'],
  // mysql / mariadb -p<password> (only when written right after -p: "-p secret" prompts and the next word is a database)
  [/((?:^|\s)-p)(?:'[^']{0,256}'|"[^"]{0,256}"|[^\s'"]\S{0,255})/g, '$1[MASKED]'],
  // database / broker URIs: the whole URI (host names and database names are internal too)
  [/\bjdbc:[a-z0-9]{1,20}:[^\s"'<>]{1,2048}/gi, '[MASKED URI]'],   // any JDBC URL (jdbc:oracle:thin:@host…, jdbc:mysql://…)
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqp):\/\/[^\s"'<>]{1,2048}/gi, '[MASKED URI]'],
  // card / account numbers: 12-19 digits, optionally separated by a space, dash or dot. Not across a line break (a
  // settlement table, one number per line) and not inside a 20+ digit run; a number the terminal wrapped is found by
  // team/peer.mjs maskRows, which joins the rows first
  [/\b\d(?:[ .-]?\d){11,18}\b/g, '[MASKED NUMBER]'],
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g, '[MASKED EMAIL]'],
];
function maskRaw(s) {
  let out = s;
  for (const [re, repl] of SECRET_RES) out = out.replace(re, repl);
  return out;
}
// zero-width / bidi / format characters (the set core/guard.js and team/remote.mjs drop) and NFKC (full-width digits
// and letters → ASCII): a secret hidden by them is found in the normalized text
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
function normalize(s) {
  let n = s; try { n = n.normalize('NFKC'); } catch {}
  return n.replace(INVISIBLE, '');
}
// the text keeps its own characters unless normalizing it reveals a secret the plain pass missed; then the normalized,
// masked text is returned (so a diff or a screen with harmless full-width text is not rewritten)
function mask(s) {
  const out = maskRaw(String(s == null ? '' : s));
  const n = normalize(out);
  if (n === out) return out;
  const nm = maskRaw(n);
  return nm === n ? out : nm;
}
// mask() per line, plus a private key whose BEGIN / END markers sit on different lines (a diff, a file): every line
// from BEGIN through END becomes [MASKED PRIVATE KEY]
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;
function maskLines(lines) {
  let inPem = false;
  return (Array.isArray(lines) ? lines : []).map(l => {
    const s = String(l == null ? '' : l);
    if (inPem) { if (PEM_END.test(s)) inPem = false; return '[MASKED PRIVATE KEY]'; }
    const b = s.search(PEM_BEGIN);
    if (b >= 0 && !PEM_END.test(s.slice(b))) { inPem = true; return mask(s.slice(0, b)) + '[MASKED PRIVATE KEY]'; }
    return mask(s);
  });
}
// [start, end) of every part of s that mask() would replace (a kept "$1" prefix such as "token=" is not included):
// lets a caller mask a secret it found in text joined from pieces (terminal rows) in each piece it came from
function rangesIn(str, out, map) {
  for (const [re, repl] of SECRET_RES) {
    for (const m of str.matchAll(re)) {
      const keep = repl.startsWith('$1') && m[1] ? m[1].length : 0;
      if (m[0].length <= keep) continue;
      const a = m.index + keep, b = m.index + m[0].length;
      out.push(map ? [map[a][0], map[b - 1][1]] : [a, b]);
    }
  }
}
// the second pass runs on the normalized text (per code point: invisible ones dropped, NFKC applied) with every
// normalized position mapped back to the [start, end) of the source character it came from
function secretRanges(s) {
  const str = String(s == null ? '' : s), out = [];
  rangesIn(str, out, null);
  let norm = '', i = 0; const map = [];
  for (const ch of str) {
    const start = i; i += ch.length;
    INVISIBLE.lastIndex = 0;
    if (INVISIBLE.test(ch)) continue;
    let n = ch; try { n = ch.normalize('NFKC'); } catch {}
    for (let k = 0; k < n.length; k++) map.push([start, i]);
    norm += n;
  }
  if (norm !== str) rangesIn(norm, out, map);
  return out;
}
const CRED_RES = SECRET_RES.filter(([, repl]) => repl !== '[MASKED NUMBER]' && repl !== '[MASKED EMAIL]').map(([re]) => re);
function hasCredential(s) {
  const str = String(s == null ? '' : s);
  const hit = t => CRED_RES.some(re => { re.lastIndex = 0; const r = re.test(t); re.lastIndex = 0; return r; });
  return hit(str) || hit(normalize(str));
}
const MARK_RE = /\[MASKED[A-Z ]{0,16}\]/g;
const marks = s => (s.match(MARK_RE) || []).length;
function maskWithCount(s) {
  const src = String(s == null ? '' : s), text = mask(src);
  return { text, count: Math.max(0, marks(text) - marks(src)) };
}
// opts.max: length cap applied AFTER masking (over it: rejected, or cut when opts.truncate); opts.hardMax: input size
// refused before masking at all (keeps a huge IPC payload from costing time; nothing is sent either way)
function maskForSend(s, opts) {
  const o = opts || {}, max = o.max || 32000, hardMax = o.hardMax || 100000;
  if (typeof s !== 'string') return { ok: false, error: 'body is not text' };
  if (s.length > hardMax) return { ok: false, error: 'body is too long' };
  const r = maskWithCount(s);
  let text = r.text;
  if (!text.trim()) return { ok: false, error: 'body is empty' };
  if (text.length > max) { if (!o.truncate) return { ok: false, error: 'body is too long after masking' }; text = text.slice(0, max); }
  return { ok: true, text, masked: r.count };
}
const AgentDeskMask = { mask, maskLines, secretRanges, hasCredential, maskWithCount, maskForSend };
root.AgentDeskMask = AgentDeskMask;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskMask;
})(typeof globalThis !== 'undefined' ? globalThis : this);
