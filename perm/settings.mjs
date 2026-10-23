// Safe edits of agent hook settings files (~/.claude/settings.json, ~/.gemini/settings.json, ~/.codex/hooks.json).
//   readJsonStrict(file)   → {} when the file is missing or empty; throws when it exists but is not a JSON object
//                            (never treat a broken file as {} and write that back over the user's settings)
//   writeJsonAtomic(file)  → tmp file + rename, keeping the original file mode (new files 0600)
//   backupPrivate(file, dir, name) → copy into dir (0700) as a 0600 file
//   installPermHookAt / uninstallPermHookAt → the widget approval hook on PermissionRequest; every other hook is kept
//   installGuardHookAt / uninstallGuardHookAt → the guardrail hook on PreToolUse (Bash|Edit|Write|MultiEdit|NotebookEdit)
import { readFileSync, writeFileSync, existsSync, renameSync, statSync, copyFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function readJsonStrict(file) {
  if (!existsSync(file)) return {};
  let raw;
  try { raw = readFileSync(file, "utf-8"); } catch (e) { throw new Error(`${basename(file)}을 읽을 수 없습니다: ${e.message}`); }
  if (!raw.trim()) return {};
  let o;
  try { o = JSON.parse(raw); } catch (e) { throw new Error(`${basename(file)}을 읽을 수 없습니다: ${e.message}`); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${basename(file)}을 읽을 수 없습니다: JSON 객체가 아닙니다`);
  return o;
}
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600; try { mode = statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.agentdesk-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode });
    try { chmodSync(tmp, mode); } catch {}
    renameSync(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}
export function backupPrivate(file, dir, name) {
  if (!existsSync(file)) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, name);
  copyFileSync(file, out); chmodSync(out, 0o600);
  return out;
}

// command hooks of ours on one event, found by the script path in their command (other hooks on the event are kept)
const hookIsOurs = (entry, re) => Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h?.command === "string" && re.test(h.command));
function hookPresentAt(settingsFile, event, re) {
  let s; try { s = readJsonStrict(settingsFile); } catch { return false; }
  const arr = (s.hooks || {})[event];
  return Array.isArray(arr) && arr.some(e => hookIsOurs(e, re));
}
// replaces (never duplicates) our entry on `event`; throws on a broken settings file before anything is written
function installHookAt({ settingsFile, event, re, entry, backupDir, backupName }) {
  const s = readJsonStrict(settingsFile);
  if (backupDir) backupPrivate(settingsFile, backupDir, backupName || `claude-settings.backup-${Date.now()}.json`);
  if (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)) s.hooks = {};
  const arr = Array.isArray(s.hooks[event]) ? s.hooks[event].filter(e => !hookIsOurs(e, re)) : [];
  arr.push(entry);
  s.hooks[event] = arr;
  writeJsonAtomic(settingsFile, s);
}
function uninstallHookAt({ settingsFile, event, re }) {
  if (!existsSync(settingsFile)) return;
  const s = readJsonStrict(settingsFile);
  if (!s.hooks || !Array.isArray(s.hooks[event])) return;
  s.hooks[event] = s.hooks[event].filter(e => !hookIsOurs(e, re));
  if (!s.hooks[event].length) delete s.hooks[event];
  writeJsonAtomic(settingsFile, s);
}

const PERM_HOOK_RE = /[\\/]\.roca[\\/]perm-hook\.(sh|cmd|cjs)\b/;   // Windows: perm-hook.cjs (run by node.exe) or perm-hook.cmd (launcher)
export const isOurPermHook = (entry) => hookIsOurs(entry, PERM_HOOK_RE);
export function permHookPresent(settingsFile) { return hookPresentAt(settingsFile, "PermissionRequest", PERM_HOOK_RE); }
// next to the async logging hook on the same event; the hook timeout is above curl's so curl always ends first
export function installPermHookAt({ settingsFile, command, timeoutSec, backupDir }) {
  installHookAt({ settingsFile, event: "PermissionRequest", re: PERM_HOOK_RE, entry: { hooks: [{ type: "command", command, timeout: timeoutSec + 10 }] }, backupDir });
}
export function uninstallPermHookAt({ settingsFile }) { uninstallHookAt({ settingsFile, event: "PermissionRequest", re: PERM_HOOK_RE }); }

// the guardrail hook (~/.roca/guard-hook.sh): synchronous PreToolUse on the tools that change things
export const GUARD_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit";
export const GUARD_HOOK_TIMEOUT = 3;   // seconds; curl gives up before this, and a timed-out PreToolUse hook does not block
const GUARD_HOOK_RE = /[\\/]\.roca[\\/]guard-hook\.(sh|cmd|cjs)\b/;
export const isOurGuardHook = (entry) => hookIsOurs(entry, GUARD_HOOK_RE);
export function guardHookPresent(settingsFile) { return hookPresentAt(settingsFile, "PreToolUse", GUARD_HOOK_RE); }
export function installGuardHookAt({ settingsFile, command, backupDir }) {
  installHookAt({ settingsFile, event: "PreToolUse", re: GUARD_HOOK_RE, entry: { matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: GUARD_HOOK_TIMEOUT }] }, backupDir });
}
export function uninstallGuardHookAt({ settingsFile }) { uninstallHookAt({ settingsFile, event: "PreToolUse", re: GUARD_HOOK_RE }); }
