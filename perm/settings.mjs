// Safe edits of agent hook settings files (~/.claude/settings.json, ~/.gemini/settings.json, ~/.codex/hooks.json).
//   readJsonStrict(file)   → {} when the file is missing or empty; throws when it exists but is not a JSON object
//                            (never treat a broken file as {} and write that back over the user's settings)
//   writeJsonAtomic(file)  → tmp file + rename, keeping the original file mode (new files 0600)
//   backupPrivate(file, dir, name) → copy into dir (0700) as a 0600 file
//   installPermHookAt / uninstallPermHookAt → the widget approval hook on PermissionRequest; every other hook is kept
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

export const isOurPermHook = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h?.command === "string" && /[\\/]\.roca[\\/]perm-hook\.sh/.test(h.command));
export function permHookPresent(settingsFile) {
  let s; try { s = readJsonStrict(settingsFile); } catch { return false; }
  const arr = (s.hooks || {}).PermissionRequest;
  return Array.isArray(arr) && arr.some(isOurPermHook);
}
// next to the async logging hook on the same event; the hook timeout is above curl's so curl always ends first
export function installPermHookAt({ settingsFile, command, timeoutSec, backupDir }) {
  const s = readJsonStrict(settingsFile);   // throws before anything is written
  if (backupDir) backupPrivate(settingsFile, backupDir, `claude-settings.backup-${Date.now()}.json`);
  if (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)) s.hooks = {};
  const arr = Array.isArray(s.hooks.PermissionRequest) ? s.hooks.PermissionRequest.filter(e => !isOurPermHook(e)) : [];
  arr.push({ hooks: [{ type: "command", command, timeout: timeoutSec + 10 }] });
  s.hooks.PermissionRequest = arr;
  writeJsonAtomic(settingsFile, s);
}
export function uninstallPermHookAt({ settingsFile }) {
  if (!existsSync(settingsFile)) return;
  const s = readJsonStrict(settingsFile);
  if (!s.hooks || !Array.isArray(s.hooks.PermissionRequest)) return;
  s.hooks.PermissionRequest = s.hooks.PermissionRequest.filter(e => !isOurPermHook(e));
  if (!s.hooks.PermissionRequest.length) delete s.hooks.PermissionRequest;
  writeJsonAtomic(settingsFile, s);
}
