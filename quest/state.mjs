// AgentDesk Quest board: the quest state file (~/.roca/quests.json), mode 0600, atomic writes.
//   { v: 1, quests: { [ticketKey]: { kind: 'session'|'worktree', sessionId?, repo?, at, reportAt? } } }
//
//   createQuestState({ file, now }) → { load(), get(key), set(key, entry), report(key, at), drop(key), all(), prune(doneKeys, projects) }
//     set     → stores a cleaned copy (unknown fields dropped; 'session' needs sessionId, 'worktree' needs repo; throws otherwise)
//     report  → marks reportAt (now() when at is not given); false when the ticket has no entry
//     prune   → removes the listed keys (strings) and, for Jira issues (objects), tickets done more than 30 days ago;
//               projects (keys of a successful, complete load) also drops their entries the load did not return that are
//               quiet for over 30 days (core/quest.js pruneState)
//     all()   → a deep copy of the file object
//     load    → keys that are not ticket keys (QUEST_KEY_RE: __proto__, junk) are dropped
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import "../core/quest.js";   // globalThis.AgentDeskQuest.pruneState

export const QUEST_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const empty = () => ({ v: 1, quests: Object.create(null) });
const isStr = v => typeof v === "string" && v.length > 0;
const isTime = v => typeof v === "number" && Number.isFinite(v);

function cleanEntry(e, now) {
  if (!e || typeof e !== "object") return null;
  if (e.kind === "session" && !isStr(e.sessionId)) return null;
  if (e.kind === "worktree" && !isStr(e.repo)) return null;
  if (e.kind !== "session" && e.kind !== "worktree") return null;
  const out = { kind: e.kind };
  if (isStr(e.sessionId)) out.sessionId = e.sessionId;
  if (isStr(e.repo)) out.repo = e.repo;
  out.at = isTime(e.at) ? e.at : now;
  if (isTime(e.reportAt)) out.reportAt = e.reportAt;
  return out;
}

export function createQuestState({ file, now = Date.now } = {}) {
  if (!file) throw new Error("quest state: file is required");
  let data = empty();   // quests is a null-prototype map: only ticket keys (QUEST_KEY_RE) ever land in it
  // atomic and private from the first byte: the temp file is created 0600 and renamed over the old one
  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.agentdesk-${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch {}   // an old leftover temp file keeps its mode on overwrite
      renameSync(tmp, file);
    } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
  };
  return {
    load() {
      data = empty();
      let o = null;
      try { o = JSON.parse(readFileSync(file, "utf-8")); } catch { return data; }
      const q = o && typeof o === "object" && o.quests && typeof o.quests === "object" ? o.quests : {};
      for (const k of Object.keys(q)) { if (!QUEST_KEY_RE.test(k)) continue; const e = cleanEntry(q[k], 0); if (e && e.at) data.quests[k] = e; }
      return data;
    },
    get(key) { const e = typeof key === "string" && Object.prototype.hasOwnProperty.call(data.quests, key) ? data.quests[key] : undefined; return e ? { ...e } : undefined; },
    set(key, entry) {
      const e = cleanEntry(entry, now());
      if (typeof key !== "string" || !QUEST_KEY_RE.test(key) || !e) throw new Error("quest state: invalid entry");
      data.quests[key] = e;
      save();
      return { ...e };
    },
    report(key, at) {
      const e = Object.prototype.hasOwnProperty.call(data.quests, key) ? data.quests[key] : null;
      if (!e) return false;
      e.reportAt = isTime(at) ? at : now();
      save();
      return true;
    },
    drop(key) {
      if (!Object.prototype.hasOwnProperty.call(data.quests, key)) return false;
      delete data.quests[key];
      save();
      return true;
    },
    all() { return { v: 1, quests: JSON.parse(JSON.stringify(data.quests)) }; },
    prune(doneKeys, projects) {
      const list = Array.isArray(doneKeys) ? doneKeys : [];
      const before = Object.keys(data.quests).length;
      for (const k of list) if (typeof k === "string") delete data.quests[k];
      const issues = list.filter(i => i && typeof i === "object");
      const ps = Array.isArray(projects) ? projects.filter(p => typeof p === "string") : [];
      if (issues.length || ps.length) data = { v: 1, quests: Object.assign(Object.create(null), globalThis.AgentDeskQuest.pruneState(data, issues, now(), ps).quests) };
      if (Object.keys(data.quests).length !== before) save();
      return Object.keys(data.quests).length;
    },
  };
}
