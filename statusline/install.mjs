// "Usage without Orca": the Claude Code status line relay (statusline/relay.cjs) in ~/.claude/settings.json.
//   relayState({ settingsFile, origFile })  → 'on' (settings run our relay) | 'replaced' (we installed it, then the
//                                             user set another statusLine: counts as off, never overwritten) | 'off'
//                                             | 'error' (settings.json unreadable)
//   installRelayAt({ settingsFile, origFile, command, backupDir })
//       keeps the original statusLine object (whole) in origFile as { had, statusLine }, then sets statusLine to
//       { ...original fields (padding, refreshInterval, …), type: 'command', command }. Already on: only the command
//       is refreshed (the kept original stays). A broken settings.json throws before anything is written.
//   uninstallRelayAt({ settingsFile, origFile })
//       puts the original statusLine back exactly (no original: the key is removed) when settings still run our relay;
//       a statusLine the user set meanwhile is left alone. origFile is removed either way.
import { readFileSync, existsSync, unlinkSync, renameSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonStrict, writeJsonAtomic, backupPrivate } from "../perm/settings.mjs";

export const RELAY_RE = /[\\/]\.roca[\\/]statusline-relay\.(sh|cmd|cjs)\b/;
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
export const isOurStatusLine = sl => isObj(sl) && typeof sl.command === "string" && RELAY_RE.test(sl.command);

function readOrig(origFile) {
  try { const o = JSON.parse(readFileSync(origFile, "utf-8")); return isObj(o) ? o : null; } catch { return null; }
}
function writeOrig(origFile, obj) {
  mkdirSync(dirname(origFile), { recursive: true, mode: 0o700 });
  const tmp = `${origFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, origFile);
}

export function relayState({ settingsFile, origFile }) {
  let s; try { s = readJsonStrict(settingsFile); } catch { return "error"; }
  if (isOurStatusLine(s.statusLine)) return "on";
  return existsSync(origFile) ? "replaced" : "off";
}

export function installRelayAt({ settingsFile, origFile, command, backupDir }) {
  if (typeof command !== "string" || !RELAY_RE.test(command)) throw new Error("invalid relay command");
  const s = readJsonStrict(settingsFile);
  if (isOurStatusLine(s.statusLine)) {
    if (s.statusLine.command === command && s.statusLine.type === "command") return { changed: false };
    s.statusLine = { ...s.statusLine, type: "command", command };
    writeJsonAtomic(settingsFile, s);
    return { changed: true };
  }
  if (backupDir) backupPrivate(settingsFile, backupDir, `claude-settings.backup-${Date.now()}.json`);
  const had = Object.prototype.hasOwnProperty.call(s, "statusLine");
  writeOrig(origFile, had ? { had: true, statusLine: s.statusLine } : { had: false });   // before settings change
  s.statusLine = { ...(isObj(s.statusLine) ? s.statusLine : {}), type: "command", command };
  writeJsonAtomic(settingsFile, s);
  return { changed: true };
}

export function uninstallRelayAt({ settingsFile, origFile }) {
  const s = readJsonStrict(settingsFile);   // throws on a broken file: nothing is touched
  let restored = false;
  if (isOurStatusLine(s.statusLine)) {
    const o = readOrig(origFile);
    if (o && o.had) s.statusLine = o.statusLine; else delete s.statusLine;
    writeJsonAtomic(settingsFile, s);
    restored = true;
  }
  try { unlinkSync(origFile); } catch {}
  return { restored };
}
