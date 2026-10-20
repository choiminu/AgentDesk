// AgentDesk core: dangerous-input guard for text typed into a session from outside (team phase 3: a teammate's remote
// input). Pure, dependency-free. Loaded as a classic <script> (global AgentDeskGuard) or required / imported for its
// side effect (`import "../core/guard.js"; const { isDangerous } = globalThis.AgentDeskGuard;`).
//
//   isDangerous(text) → { blocked: true, rule: id, label } | { blocked: false }
//   GUARD_RULES       → the rule table (data): { id, label, re?, unless?, test? }
//                        re matches → blocked, unless `unless` also matches; `test(text)` for rules a regex cannot say
//
// One line of input (the caller flattens newlines first), case-insensitive. Unicode is NFKC-normalised and invisible
// format characters (zero-width space, bidi marks, …) are removed before matching, so "r\u200bm" or full-width letters
// do not slip past. This is a seatbelt against obvious destructive commands, not a sandbox: a request phrased in plain
// words ("delete everything under my home folder") is not recognised.
(function (root) {
'use strict';

// rm with recursive + force flags whose target is the root, the home folder, a glob, an absolute path, a parent path or "."
const RM_STOP = /^(?:;|&&|\|\||\||&)$/;
function rmDangerous(s) {
  const toks = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
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
  }
  return false;
}

const SECRET_FILE = String.raw`(?:\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.p12\b|\.key\b|credentials)`;
const GUARD_RULES = [
  { id: 'rm-rf', label: 'rm -rf (루트·홈·와일드카드·절대경로)', test: rmDangerous },
  { id: 'git-push-force', label: 'git push --force', re: /\bgit\b[^;&|]*?\bpush\b[^;&|]*?(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/i },
  { id: 'git-reset-hard', label: 'git reset --hard', re: /\bgit\b[^;&|]*?\breset\b[^;&|]*?--hard\b/i },
  { id: 'git-clean-force', label: 'git clean -f', re: /\bgit\b[^;&|]*?\bclean\b[^;&|]*?(?:\s-[a-z]*f[a-z]*\b|\s--force\b)/i },
  { id: 'sql-drop', label: 'DROP TABLE / DATABASE', re: /\bdrop\s+(?:table|database|schema)\b/i },
  { id: 'sql-truncate', label: 'TRUNCATE', re: /\btruncate\s+table\b|\btruncate\s+[`"\[]?[\w.]+[`"\]]?\s*;/i },
  { id: 'sql-delete-no-where', label: 'DELETE FROM (WHERE 없음)', re: /\bdelete\s+from\s+\S+/i, unless: /\bwhere\b/i },
  { id: 'sql-update-no-where', label: 'UPDATE … SET (WHERE 없음)', re: /\bupdate\s+[`"\[]?[\w.]+[`"\]]?\s+set\b/i, unless: /\bwhere\b/i },
  { id: 'db-connect', label: 'DB 클라이언트 접속 (mysql·psql·mongosh)', re: /\b(?:mysql|mariadb|psql|mongosh|mongo)\s+-|\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?):\/\//i },
  { id: 'secret-file', label: '비밀 파일 읽기·쓰기 (.env·id_rsa·.pem·credentials)', re: new RegExp(String.raw`\b(?:cat|less|more|head|tail|bat|strings|xxd|base64|cp|scp|tee|echo|printf|sed\s+-i)\b[^;&|]*?` + SECRET_FILE + String.raw`|>>?\s*\S*` + SECRET_FILE, 'i') },
  { id: 'curl-pipe-sh', label: 'curl | sh', re: /\b(?:curl|wget)\b[^;&]*?\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i },
  { id: 'pipe-interpreter', label: '| python·node·perl·ruby·sh (파이프로 실행)', re: /\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|sh|bash|zsh|dash|ksh|fish)\b/i },
  { id: 'base64-decode', label: 'base64 -d | …', re: /\bbase64\b[^;&|]*?\s(?:-d|-D|--decode)\b[^;&]*\|/i },
  { id: 'inline-code-destructive', label: '-c / -e 인라인 코드의 삭제·파괴 명령', re: /(?:^|\s)-[ce]\s.*?\b(?:rm|rmdir|rmtree|rmSync|unlink|unlinkSync|remove|removedirs|drop|truncate|delete|mkfs|shred)\b/i },
  { id: 'find-delete', label: 'find … -delete / -exec rm', re: /\bfind\b[^;&|]*?\s(?:-delete\b|-exec\s+rm\b|-execdir\s+rm\b)/i },
  { id: 'remote-script', label: '내려받은 스크립트 실행 (<(curl) · $(curl) · eval)', re: /<\(\s*(?:curl|wget)\b|-c\s+["']?\$\(\s*(?:curl|wget)\b|(?:^|[;&|]\s*)\$\(\s*(?:curl|wget)\b|\beval\b[^;&|]*\b(?:curl|wget)\b/i },
  { id: 'wget-mirror', label: 'wget --mirror', re: /\bwget\b[^;&|]*\s(?:--mirror|-m)\b/i },
  { id: 'disk-destroy', label: 'shred · dd of=/dev/ · mkfs', re: /\bshred\s|\bdd\b[^;&|]*\bof=\/dev\/|\bmkfs(?:\.\w+)?\s/i },
  { id: 'chmod-000', label: 'chmod -R 000', re: /\bchmod\s+(?:-\S+\s+)*0?000\b/i },
  { id: 'chmod-777', label: 'chmod 777', re: /\bchmod\s+(?:-\S+\s+)*0?777\b/i },
  { id: 'sudo', label: 'sudo', re: /\bsudo\s+\S/i },
  { id: 'skip-permissions', label: '권한 확인 끄기 (--dangerously-skip-permissions)', re: /--dangerously-skip-permissions\b|\bbypassPermissions\b/i },
];

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
function isDangerous(text) {
  const plain = normalize(text);
  const forms = [plain, unquote(plain), unsubst(plain), unquote(unsubst(plain))];
  for (const r of GUARD_RULES) {
    for (const s of forms) {
      const hit = r.test ? r.test(s) : r.re.test(s);
      if (hit && !(r.unless && r.unless.test(s))) return { blocked: true, rule: r.id, label: r.label };
    }
  }
  return { blocked: false };
}

const AgentDeskGuard = { GUARD_RULES, isDangerous, normalize };
root.AgentDeskGuard = AgentDeskGuard;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskGuard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
