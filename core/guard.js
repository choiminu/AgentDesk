// AgentDesk core: dangerous-command guard. Used for text typed into a session from outside (team phase 3: a teammate's
// remote input) and for the PreToolUse guardrail hook (guard/guard.mjs: Bash commands and Edit / Write target paths).
// Pure, dependency-free. Loaded as a classic <script> (global AgentDeskGuard) or required / imported for its side
// effect (`import "../core/guard.js"; const { isDangerous } = globalThis.AgentDeskGuard;`).
//
//   isDangerous(text) → { blocked: true, rule: id, label } | { blocked: false }   (every built-in Bash rule, first hit)
//   GUARD_RULES       → the built-in rule table for commands (data): { id, label, severity, re?, unless?, test? }
//                        re matches → hit, unless `unless` also matches; `test(text)` for rules a regex cannot say
//   FILE_RULES        → built-in rules for the target path of Edit / Write / MultiEdit / NotebookEdit
//   defaultRules()    → the rule file's JSON form of both tables (single source: ~/.roca/guard.json starts from it)
//   compileRules(json) → { rules, errors }   user JSON → matchers; a bad / over-long regex is dropped and reported
//   evaluate(tool, input, rules, opts) → { hit: {id,label,severity,builtin}|null, severity, subject, slow, cut, timedOut }
//   summarizeHit(hit, subject) → ≤120-char, masked excerpt around the match
//   decide(mode, result, summary) → { decision: null|"ask"|"deny", output }   the PreToolUse hook output
//
// One line of input (newlines become spaces), case-insensitive. Unicode is NFKC-normalised and invisible format
// characters (zero-width space, bidi marks, …) are removed before matching, so "r\u200bm" or full-width letters do
// not slip past. This is a seatbelt against obvious destructive commands, not a sandbox: a request phrased in plain
// words ("delete everything under my home folder") or variable indirection ('x=rm; $x -rf /') is not recognised.
(function (root) {
'use strict';

// the four normalised forms are split the same ways by many rules: keep the last few splits
const SPLITTERS = { any: /[;&|]/, nopipe: /[;&]/, ws: /\s+/ };
let splitMemo = new Map();
function splitCached(s, kind) {
  let e = splitMemo.get(s);
  if (!e) { if (splitMemo.size > 8) splitMemo = new Map(); e = {}; splitMemo.set(s, e); }
  return e[kind] || (e[kind] = s.split(SPLITTERS[kind]));
}
// rm with recursive + force flags whose target is the root, the home folder, a glob, an absolute path, a parent path or "."
const RM_STOP = /^(?:;|&&|\|\||\||&)$/;
function rmDangerous(s) {
  if (!/rm/i.test(s)) return false;
  const toks = splitCached(s, 'ws').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].length < 2 || !/rm/i.test(toks[i])) continue;
    const tk = toks[i].replace(/^[`'"(]+/, '').toLowerCase();
    if (tk !== 'rm' && !/\/rm$/.test(tk)) continue;
    let r = false, f = false, j = i + 1;
    for (; j < toks.length && /^-/.test(toks[j]); j++) {
      const o = toks[j].toLowerCase();
      if (o === '--') { j++; break; }
      if (o === '--recursive') r = true; else if (o === '--force') f = true;
      else if (!o.startsWith('--')) { if (o.includes('r')) r = true; if (o.includes('f')) f = true; }
    }
    if (!(r && f)) continue;
    for (; j < toks.length && !RM_STOP.test(toks[j]); j++) {
      const t = toks[j].replace(/^[`'"]+|[`'";)]+$/g, '');
      if (/^(?:\/|~|\$HOME\b|\$\{HOME\}|\.\.(?:\/|$)|\.\/?$)/i.test(t) || t.includes('*')) return true;
    }
    i = j;   // a later rm inside these arguments only sees a subset of them: scanning it again finds nothing new (and was O(n²))
  }
  return false;
}

// Linear matchers. A regex like /\bgit\b[^;&|]*?\bpush\b[^;&|]*?FLAG/ backtracks over every (git, push) pair: an 8,000-
// char "git push git push …" took over a second, on the app's main thread. The same question asked as "in one command
// segment, the first git, then the first push after it, then FLAG after that" has the same answer (an earlier match
// never removes a later one) in linear time. Every built-in below that scans a segment does it this way; its `re` stays
// as the readable form shown in the UI, and test/guard.test.mjs checks that both agree on the whole example corpus.
const gi = src => new RegExp(src, 'gi');
// each regex in turn, each starting where the previous match ended → end of the last match, or -1
function inOrder(seg, res, from) {
  let pos = from || 0;
  for (const re of res) { re.lastIndex = pos; const m = re.exec(seg); if (!m) return -1; pos = m.index + m[0].length; }
  return pos;
}
const SEP = 'any', SEP_NOPIPE = 'nopipe';
const anySeg = (s, sep, fn) => splitCached(s, sep).some(fn);
const GIT = gi(String.raw`\bgit\b`), PUSH = gi(String.raw`\bpush\b`), RESET = gi(String.raw`\breset\b`), CLEAN = gi(String.raw`\bclean\b`);
// "-f" anywhere in a run of short flags; [a-eg-z]* cannot take the f, so there is a single way to match
const FORCE_SRC = String.raw`\s--force(?:-with-lease|-if-includes)?\b|\s-[a-eg-z]*f[a-z]*\b|\s\+\S`;
const FORCE = gi(FORCE_SRC), HARD = gi(String.raw`--hard\b`), CLEAN_F = gi(String.raw`\s-[a-eg-z]*f[a-z]*\b|\s--force\b`);
const PROTECTED = gi(String.raw`[\s:+](?:main|master|release(?:\/[^\s;&|]*)?)(?=$|[\s;&|])`);
const SECRET_FILE = String.raw`(?:\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.p12\b|\.key\b|credentials)`;
const SECRET_CMD_SRC = String.raw`\b(?:cat|less|more|head|tail|bat|strings|xxd|base64|cp|scp|tee|echo|printf|sed\s+-i)\b`;
const SECRET_CMD = gi(SECRET_CMD_SRC), SECRET = gi(SECRET_FILE), SECRET_Q = new RegExp(SECRET_FILE, 'i');
// a secret file name inside `>`/`>>` + spaces + one word: one pass marks where such a word may be, then the names are
// looked up (the regex form />>?\s*\S*NAME/ restarts at every ">" and was O(n²) on ">>>>…")
function redirectToSecret(s) {
  if (s.indexOf('>') < 0) return false;
  const armed = new Uint8Array(s.length + 1);
  let on = false, word = false;
  for (let i = 0; i < s.length; i++) {
    armed[i] = on ? 1 : 0;
    const c = s[i];
    if (c === '>') { on = true; word = false; }
    else if (c === ' ' || c === '\t' || (c > '~' && /\s/.test(c))) { if (word) on = false; }
    else word = true;
  }
  SECRET.lastIndex = 0;
  for (let m; (m = SECRET.exec(s));) { if (armed[m.index]) return true; SECRET.lastIndex = m.index + 1; }
  return false;
}
const CURL_WGET = gi(String.raw`\b(?:curl|wget)\b`), PIPE_SH = gi(String.raw`\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b`);
const BASE64 = gi(String.raw`\bbase64\b`), DECODE = gi(String.raw`\s(?:-d|-D|--decode)\b`);
const DASH_CE = gi(String.raw`(?:^|\s)-[ce]\s`), DESTRUCT = gi(String.raw`\b(?:rm|rmdir|rmtree|rmSync|unlink|unlinkSync|remove|removedirs|drop|truncate|delete|mkfs|shred)\b`);
const FIND = gi(String.raw`\bfind\b`), FIND_DEL = gi(String.raw`\s(?:-delete\b|-exec\s+rm\b|-execdir\s+rm\b)`);
const REMOTE_DIRECT = /<\(\s*(?:curl|wget)\b|-c\s+["']?\$\(\s*(?:curl|wget)\b|(?:^|[;&|]\s*)\$\(\s*(?:curl|wget)\b/i, EVAL = gi(String.raw`\beval\b`);
const WGET = gi(String.raw`\bwget\b`), MIRROR = gi(String.raw`\s(?:--mirror|-m)\b`);
const DD = gi(String.raw`\bdd\b`), OF_DEV = gi(String.raw`\bof=\/dev\/`);
const DB_CLI = gi(String.raw`\b(?:mysql|mariadb|psql|mongosh|mongo)\b`), DB_URI = gi(String.raw`\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/`);
const PROD_HOST = gi(String.raw`rds-prod|\bprod-|production`), PROD_Q = /rds-prod|\bprod-|production/i;
const GUARD_RULES = [
  { id: 'rm-rf', severity: 'block', label: 'rm -rf (루트·홈·와일드카드·절대경로)', test: rmDangerous, hint: /\brm\s/i },
  { id: 'git-push-force', severity: 'warn', label: 'git push --force', re: /\bgit\b[^;&|]*?\bpush\b[^;&|]*?(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-eg-z]*f[a-z]*\b|\s\+\S)/i, test: s => /\bgit\b/i.test(s) && (anySeg(s, SEP, x => inOrder(x, [GIT, PUSH, FORCE]) >= 0)), hint: /\bgit\b/i },
  { id: 'git-reset-hard', severity: 'warn', label: 'git reset --hard', re: /\bgit\b[^;&|]*?\breset\b[^;&|]*?--hard\b/i, test: s => /\bgit\b/i.test(s) && (anySeg(s, SEP, x => inOrder(x, [GIT, RESET, HARD]) >= 0)), hint: /\bgit\b/i },
  { id: 'git-clean-force', severity: 'warn', label: 'git clean -f', re: /\bgit\b[^;&|]*?\bclean\b[^;&|]*?(?:\s-[a-eg-z]*f[a-z]*\b|\s--force\b)/i, test: s => /\bgit\b/i.test(s) && (anySeg(s, SEP, x => inOrder(x, [GIT, CLEAN, CLEAN_F]) >= 0)), hint: /\bgit\b/i },
  { id: 'sql-drop', severity: 'block', label: 'DROP TABLE / DATABASE', re: /\bdrop\s+(?:table|database|schema)\b/i },
  { id: 'sql-truncate', severity: 'block', label: 'TRUNCATE', re: /\btruncate\s+table\b|\btruncate\s+[`"\[]?[\w.]+[`"\]]?\s*;/i },
  { id: 'sql-delete-no-where', severity: 'warn', label: 'DELETE FROM (WHERE 없음)', re: /\bdelete\s+from\s+\S+/i, unless: /\bwhere\b/i },
  { id: 'sql-update-no-where', severity: 'warn', label: 'UPDATE … SET (WHERE 없음)', re: /\bupdate\s+[`"\[]?[\w.]+[`"\]]?\s+set\b/i, unless: /\bwhere\b/i },
  { id: 'db-connect', severity: 'warn', label: 'DB 클라이언트 접속 (mysql·psql·mongosh)', re: /\b(?:mysql|mariadb|psql|mongosh|mongo)\s+-|\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?):\/\//i },
  { id: 'secret-file', severity: 'warn', label: '비밀 파일 읽기·쓰기 (.env·id_rsa·.pem·credentials)', re: new RegExp(String.raw`\b(?:cat|less|more|head|tail|bat|strings|xxd|base64|cp|scp|tee|echo|printf|sed\s+-i)\b[^;&|]*?` + SECRET_FILE + String.raw`|>>?\s*\S*` + SECRET_FILE, 'i'), test: s => SECRET_Q.test(s) && (anySeg(s, SEP, x => inOrder(x, [SECRET_CMD, SECRET]) >= 0) || redirectToSecret(s)), hint: /\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.p12\b|\.key\b|credentials/i },
  { id: 'curl-pipe-sh', severity: 'block', label: 'curl | sh', re: /\b(?:curl|wget)\b[^;&]*?\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i, test: s => /\b(?:curl|wget)\b/i.test(s) && (anySeg(s, SEP_NOPIPE, x => inOrder(x, [CURL_WGET, PIPE_SH]) >= 0)), hint: /\b(?:curl|wget)\b/i },
  { id: 'pipe-interpreter', severity: 'warn', label: '| python·node·perl·ruby·sh (파이프로 실행)', re: /\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|sh|bash|zsh|dash|ksh|fish)\b/i },
  { id: 'base64-decode', severity: 'warn', label: 'base64 -d | …', re: /\bbase64\b(?=[^;&|]*\s(?:-d|-D|--decode)\b)[^;&]*\|/i, test: s => /\bbase64\b/i.test(s) && (anySeg(s, SEP_NOPIPE, x => x.split('|').slice(0, -1).some(p => inOrder(p, [BASE64, DECODE]) >= 0))), hint: /\bbase64\b/i },
  { id: 'inline-code-destructive', severity: 'warn', label: '-c / -e 인라인 코드의 삭제·파괴 명령', re: /(?:^|\s)-[ce]\s.*?\b(?:rm|rmdir|rmtree|rmSync|unlink|unlinkSync|remove|removedirs|drop|truncate|delete|mkfs|shred)\b/i, test: s => /(?:^|\s)-[ce]\s/i.test(s) && (inOrder(s, [DASH_CE, DESTRUCT]) >= 0), hint: /(?:^|\s)-[ce]\s/i },
  { id: 'find-delete', severity: 'warn', label: 'find … -delete / -exec rm', re: /\bfind\b[^;&|]*?\s(?:-delete\b|-exec\s+rm\b|-execdir\s+rm\b)/i, test: s => /\bfind\b/i.test(s) && (anySeg(s, SEP, x => inOrder(x, [FIND, FIND_DEL]) >= 0)), hint: /\bfind\b/i },
  { id: 'remote-script', severity: 'block', label: '내려받은 스크립트 실행 (<(curl) · $(curl) · eval)', re: /<\(\s*(?:curl|wget)\b|-c\s+["']?\$\(\s*(?:curl|wget)\b|(?:^|[;&|]\s*)\$\(\s*(?:curl|wget)\b|\beval\b[^;&|]*\b(?:curl|wget)\b/i, test: s => REMOTE_DIRECT.test(s) || (/\beval\b/i.test(s) && anySeg(s, SEP, x => inOrder(x, [EVAL, CURL_WGET]) >= 0)), hint: /\beval\b|\$\(|<\(/i },
  { id: 'wget-mirror', severity: 'warn', label: 'wget --mirror', re: /\bwget\b[^;&|]*\s(?:--mirror|-m)\b/i, test: s => /\bwget\b/i.test(s) && (anySeg(s, SEP, x => inOrder(x, [WGET, MIRROR]) >= 0)), hint: /\bwget\b/i },
  { id: 'disk-destroy', severity: 'block', label: 'shred · dd of=/dev/ · mkfs', re: /\bshred\s|\bdd\b[^;&|]*\bof=\/dev\/|\bmkfs(?:\.\w+)?\s/i, test: s => /\bshred\s|\bmkfs(?:\.\w+)?\s/i.test(s) || (/\bof=\/dev\//i.test(s) && anySeg(s, SEP, x => inOrder(x, [DD, OF_DEV]) >= 0)), hint: /\b(?:shred|dd|mkfs)\b/i },
  { id: 'chmod-000', severity: 'block', label: 'chmod -R 000', re: /\bchmod\s+(?:-\S+\s+)*0?000\b/i },
  { id: 'chmod-777', severity: 'warn', label: 'chmod 777', re: /\bchmod\s+(?:-\S+\s+)*0?777\b/i },
  { id: 'sudo', severity: 'warn', label: 'sudo', re: /\bsudo\s+\S/i },
  { id: 'skip-permissions', severity: 'block', label: '권한 확인 끄기 (--dangerously-skip-permissions)', re: /--dangerously-skip-permissions\b|\bbypassPermissions\b/i },
  // after the rules above, so isDangerous (first hit) keeps naming them; evaluate prefers a block-severity hit
  { id: 'db-prod', severity: 'block', label: '운영 DB 접속 (rds-prod·prod-·production 호스트)', re: /\b(?:mysql|mariadb|psql|mongosh|mongo)\b[^;&|]*?(?:rds-prod|\bprod-|production)|\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/\S*?(?:rds-prod|\bprod-|production)/i, test: s => PROD_Q.test(s) && (anySeg(s, SEP, x => inOrder(x, [DB_CLI, PROD_HOST]) >= 0) || anySeg(s, 'ws', w => inOrder(w, [DB_URI, PROD_HOST]) >= 0)), hint: /\b(?:mysql|mariadb|psql|mongosh|mongo)\b/i },
  { id: 'git-push-protected', severity: 'block', label: 'git push --force → main·master·release', re: /\bgit\b[^;&|]*?\bpush\b(?=[^;&|]*?(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-eg-z]*f[a-z]*\b|\s\+\S))[^;&|]*?[\s:+](?:main|master|release(?:\/[^\s;&|]*)?)(?=$|[\s;&|])/i, test: s => /\bgit\b/i.test(s) && (anySeg(s, SEP, x => { const p = inOrder(x, [GIT, PUSH]); return p >= 0 && inOrder(x, [FORCE], p) >= 0 && inOrder(x, [PROTECTED], p) >= 0; })), hint: /\bgit\b/i },
];
const BASH_TOOLS = ['Bash'];
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// matched against the tool's target path (file_path / notebook_path), not its content
const FILE_RULES = [
  { id: 'secret-path', severity: 'block', tools: FILE_TOOLS, label: '비밀·시스템 파일 수정 (.env·*.pem·id_rsa·credentials·~/.ssh·~/.aws·/etc)',
    re: /(?:^|\/)\.env(?!\.(?:example|sample|template|dist)$)[^\/]*$|\.pem$|(?:^|\/)id_rsa[^\/]*$|(?:^|\/)credentials[^\/]*$|(?:^|\/)\.ssh\/|(?:^|\/)\.aws\/|^(?:\/private)?\/etc\//i },
];
const BUILTIN = Object.create(null);
for (const r of GUARD_RULES) BUILTIN[r.id] = { ...r, tools: BASH_TOOLS };
for (const r of FILE_RULES) BUILTIN[r.id] = r;
const INPUT_MAX = 8000;      // user rules (vm, 20 ms each): longer input → its first and last 4,000 chars only
const FULL_MAX = 256 * 1024; // built-in rules (all linear): the whole input up to 256 KB, beyond that first + last 128 KB
const DEADLINE_MS = 1200;    // evaluate gives up (timedOut) past this; the hook's curl waits 2 s
const PATTERN_MAX = 500;
const SLOW_MS = 20;          // a user rule slower than this on one input is reported in `slow` (the caller disables it)
const SUMMARY_MAX = 120;

function normalize(text) {
  let s = String(text == null ? '' : text);
  try { s = s.normalize('NFKC'); } catch {}
  return s.replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
}
// shell quoting / escaping that changes nothing for the shell but hides a word from a regex: r"m", r\m, \rm, 'rm', a
// trailing "\" (line continuation). Both the plain and the unquoted form are checked.
const unquote = s => s.replace(/[\\'"`]/g, '');
// ${IFS} / $IFS as a space, and empty-ish command substitutions $(…) / `…` dropped: r$()m, rm${IFS}-rf${IFS}/
const unsubst = s => s.replace(/\$\{IFS\}|\$IFS\b/g, ' ').replace(/\$\([^()]*\)/g, '').replace(/`[^`]*`/g, '');
const forms = (text) => {
  const plain = normalize(text);
  return [...new Set([plain, unquote(plain), unsubst(plain), unquote(unsubst(plain))])];
};
function matchForms(r, fs) {
  for (const s of fs) {
    const hit = r.test ? r.test(s) : r.re.test(s);
    if (hit && !(r.unless && r.unless.test(s))) return true;
  }
  return false;
}

// the rule file's JSON form; built-ins carry `builtin: true` (their matcher lives here, `pattern` is for display)
function defaultRules() {
  return [...GUARD_RULES.map(r => ({ ...r, tools: BASH_TOOLS })), ...FILE_RULES].map(r => ({
    id: r.id, label: r.label, pattern: r.re ? r.re.source : '', tools: [...r.tools], enabled: true, severity: r.severity, builtin: true,
  }));
}
// the id a rule is stored and matched under (guard.json and compileRules agree): cleaned, else user-<n>
const ruleId = (x, index) => (x && typeof x.id === 'string' && cleanText(x.id, 64)) || `user-${index + 1}`;
const cleanText = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, ' ').trim().slice(0, n);
// json: an array of rules or { rules: [...] }. Rules that cannot be used (bad regex, over 500 chars, unknown built-in,
// duplicate id) are left out of `rules` and listed in `errors` — the caller shows them; nothing throws.
function compileRules(json) {
  const list = Array.isArray(json) ? json : (json && Array.isArray(json.rules) ? json.rules : []);
  const rules = [], errors = [], seen = new Set();
  list.forEach((x, index) => {
    const id = ruleId(x, index);
    const fail = (error) => { errors.push({ index, id, error }); };
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('규칙이 객체가 아닙니다');
    if (seen.has(id)) return fail('같은 id의 규칙이 이미 있습니다');
    const tools = Array.isArray(x.tools) ? x.tools.filter(t => typeof t === 'string' && t).map(t => cleanText(t, 64)).slice(0, 10) : [];
    const base = { id, label: cleanText(x.label, 120) || id, tools: tools.length ? tools : BASH_TOOLS, severity: x.severity === 'block' ? 'block' : 'warn', enabled: x.enabled !== false };
    if (x.builtin === true) {
      const b = BUILTIN[id];
      if (!b) return fail('알 수 없는 내장 규칙입니다');
      seen.add(id); rules.push({ ...base, builtin: true, re: b.re, unless: b.unless, test: b.test }); return;
    }
    const p = x.pattern;
    if (typeof p !== 'string' || !p.trim()) return fail('정규식이 비어 있습니다');
    if (p.length > PATTERN_MAX) return fail(`정규식이 ${PATTERN_MAX}자를 넘습니다`);
    let re; try { re = new RegExp(p, 'i'); } catch (e) { return fail(`정규식 오류: ${e.message}`); }
    seen.add(id); rules.push({ ...base, builtin: false, re, pattern: p });
  });
  return { rules, errors };
}
const appliesTo = (r, tool) => Array.isArray(r.tools) && (r.tools.includes(tool) || r.tools.includes('*'));
// the text a rule looks at: the command for Bash, the target path for the file tools, JSON for anything else
function subjectOf(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return typeof i.command === 'string' ? i.command : (typeof input === 'string' ? input : '');
  if (FILE_TOOLS.includes(tool)) return String(i.file_path || i.notebook_path || '');
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input == null ? '' : input); } catch { return ''; }
}
const clockNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
// longer than INPUT_MAX: the first and the last half are checked (a dangerous tail after padding is still seen)
function cutInput(raw, max) {
  if (raw.length <= max) return { text: raw, cut: false };
  const h = Math.floor(max / 2);
  return { text: raw.slice(0, h) + '\n' + raw.slice(raw.length - h), cut: true };
}
// rules: compileRules(...).rules. opts: { firstHit (the first hit in rule order; default: the first block-severity
// hit, else the first warn hit), run(rule, forms) → bool for user rules (may throw: e.g. a vm timeout → `slow`),
// now(), maxLen (user rules, default 8,000), fullMax (built-ins, default 256 KB), slowMs, deadline (ms, default
// 1,200: past it → timedOut, no hit claimed), clock() for the deadline }.
// Built-in rules see the whole input (they are linear) and are never reported slow. User rules see at most the first
// and last 4,000 chars. `cut`: some rule that ran did not see all of the input (the caller asks for Bash).
function evaluate(tool, input, rules, opts) {
  const o = opts || {};
  const clock = o.clock || Date.now, start = clock(), deadline = o.deadline != null ? o.deadline : DEADLINE_MS;
  const subject = subjectOf(String(tool || ''), input);
  const full = cutInput(subject, o.fullMax || FULL_MAX);
  const out = { hit: null, severity: null, subject: full.text, slow: [], cut: full.cut, timedOut: false };
  if (!subject) return out;
  const short = cutInput(subject, o.maxLen || INPUT_MAX);
  let fullForms = null, shortForms = null;
  const now = o.now || clockNow, slowMs = o.slowMs != null ? o.slowMs : SLOW_MS;
  let warn = null;
  for (const r of rules || []) {
    if (!r || r.enabled === false || !appliesTo(r, tool)) continue;
    if (clock() - start > deadline) { out.timedOut = true; out.hit = null; out.severity = null; return out; }
    let hit = false;
    if (r.builtin) hit = matchForms(r, fullForms || (fullForms = forms(full.text)));
    else {
      if (short.cut) out.cut = true;
      const fs = shortForms || (shortForms = forms(short.text));
      const t0 = now();
      try { hit = o.run ? !!o.run(r, fs) : matchForms(r, fs); } catch { out.slow.push(r.id); continue; }
      if (now() - t0 > slowMs) out.slow.push(r.id);
    }
    if (!hit) continue;
    const h = { id: r.id, label: r.label, severity: r.severity === 'block' ? 'block' : 'warn', builtin: !!r.builtin };
    if (o.firstHit || h.severity === 'block') { out.hit = h; out.severity = h.severity; return out; }
    if (!warn) warn = h;
  }
  if (clock() - start > deadline) { out.timedOut = true; return out; }
  if (warn) { out.hit = warn; out.severity = warn.severity; }
  return out;
}
// ≤120 chars of the input around the match, secrets masked (core/mask.js when loaded), one line
function summarizeHit(hit, subject) {
  let s = normalize(String(subject == null ? '' : subject).slice(0, FULL_MAX)).replace(/\s+/g, ' ').trim();
  const b = hit && BUILTIN[hit.id];
  // where the excerpt starts: a cheap `hint` for rules matched by code (their display `re` can backtrack badly)
  const loc = b && (b.hint || (b.test ? null : b.re));
  const M = root.AgentDeskMask;
  const mask = x => (M && M.mask ? M.mask(x) : x);
  // mask a wide window first (a secret just before the match is masked whole, never cut in half), then place the
  // excerpt on the match inside the masked text
  let lead = '';
  const m = loc ? loc.exec(s) : null;
  if (m && m.index > 30) { s = s.slice(Math.max(0, m.index - 300), m.index + 600); lead = '…'; }
  else s = s.slice(0, 900);
  s = mask(s);
  const m2 = loc && lead ? loc.exec(s) : null;
  if (m2 && m2.index > 30) s = s.slice(m2.index - 20);
  s = lead + s;
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + '…' : s;
}
// mode: "off" | "warn" | "block". block-severity hit in block mode → deny; any other hit (unless off) → ask.
// output is the PreToolUse hook's stdout ({} = no effect).
function decide(mode, result, summary) {
  const hit = result && result.hit;
  if (mode === 'off' || !hit) return { decision: null, output: {} };
  const deny = mode === 'block' && hit.severity === 'block';
  const head = `[AgentDesk 가드] ${cleanText(hit.label, 120)}: ${cleanText(summary, SUMMARY_MAX)}`;
  return {
    decision: deny ? 'deny' : 'ask',
    output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: deny ? 'deny' : 'ask',
      permissionDecisionReason: deny ? `${head} — 차단했습니다. AgentDesk 설정 → 가드레일에서 규칙을 조정할 수 있습니다` : `${head} — 터미널에서 확인하세요` } },
  };
}

// an ask that is not tied to a rule (evaluation timed out, input too long to check, an error in block mode)
function askOutput(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[AgentDesk 가드] ${cleanText(reason, 200)} — 터미널에서 확인하세요` } };
}
// the only answers the guard may give: {} or a PreToolUse ask / deny with a string reason and nothing else
function outputAllowed(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const k = Object.keys(o);
  if (!k.length) return true;
  if (k.length !== 1 || k[0] !== 'hookSpecificOutput') return false;
  const h = o.hookSpecificOutput;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  const hk = Object.keys(h).sort().join(',');
  return hk === 'hookEventName,permissionDecision,permissionDecisionReason' && h.hookEventName === 'PreToolUse'
    && (h.permissionDecision === 'ask' || h.permissionDecision === 'deny') && typeof h.permissionDecisionReason === 'string';
}
const DEFAULT_COMPILED = compileRules(defaultRules()).rules.filter(r => r.tools.includes('Bash'));
// compatible entry point (remote input): every built-in command rule, the first hit in table order blocks
function isDangerous(text) {
  const r = evaluate('Bash', { command: text == null ? '' : String(text) }, DEFAULT_COMPILED, { firstHit: true });
  return r.hit ? { blocked: true, rule: r.hit.id, label: r.hit.label } : { blocked: false };
}

const AgentDeskGuard = { GUARD_RULES, FILE_RULES, FILE_TOOLS, INPUT_MAX, FULL_MAX, PATTERN_MAX, SLOW_MS, DEADLINE_MS, isDangerous, normalize, forms, defaultRules, compileRules, ruleId, evaluate, subjectOf, summarizeHit, decide, askOutput, outputAllowed, matchForms };
root.AgentDeskGuard = AgentDeskGuard;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskGuard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
