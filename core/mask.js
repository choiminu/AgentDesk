// AgentDesk core: secret masking shared by recall/ (session notes), team/ (what goes to / comes from teammates) and the
// renderer. Pure, dependency-free. Loaded as a classic <script> (global AgentDeskMask) or imported for its side effect
// (`import "../core/mask.js"; const { mask } = globalThis.AgentDeskMask;`).
//
//   mask(s) → s with tokens, keys, connection URIs, card / account numbers and e-mail addresses replaced by [MASKED]
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
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)[ \t]{0,8}[=:][ \t]{0,8}["']?)[^\s"'&]{6,256}/gi, '$1[MASKED]'],
  // mysql / mariadb -p<password> (only when written right after -p: "-p secret" prompts and the next word is a database)
  [/((?:^|\s)-p)(?:'[^']{0,256}'|"[^"]{0,256}"|[^\s'"]\S{0,255})/g, '$1[MASKED]'],
  // database / broker URIs: the whole URI (host names and database names are internal too)
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqp|jdbc:[a-z]{1,20}):\/\/[^\s"'<>]{1,2048}/gi, '[MASKED URI]'],
  // card / account numbers: 12-19 digits in a row, optionally grouped by spaces or dashes
  [/\b\d(?:[ -]?\d){11,18}\b/g, '[MASKED NUMBER]'],
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g, '[MASKED EMAIL]'],
];
function mask(s) {
  let out = String(s == null ? '' : s);
  for (const [re, repl] of SECRET_RES) out = out.replace(re, repl);
  return out;
}
const AgentDeskMask = { mask };
root.AgentDeskMask = AgentDeskMask;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskMask;
})(typeof globalThis !== 'undefined' ? globalThis : this);
