#!/usr/bin/env node
// agentdesk-recall CLI: search | show | list | summarize | backfill | install | ensure-index
import { notes, ensureIndexes, close, digest, summarize, mask, gitInfo, changedSince, fmtNote, LOG_FILE } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? (rest.splice(i, 2)[1]) : null; };
const has = (n) => { const i = rest.indexOf(n); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
const usage = `agentdesk-recall <command>
  search <query> [--repo NAME|--worktree NAME|--all] [--limit N]   full-text search over session notes (current repo by default)
  show <id>                                        print one note in full
  list [--repo NAME|--all] [--limit N]             newest notes
  summarize <transcript.jsonl> [--cwd DIR] [--agent claude|gemini|codex]   make a note from one transcript now
  backfill [--since 7d] [--project DIR]            summarize past Claude Code transcripts of a project (default: all projects)
  install                                          register SessionEnd + PreCompact + prompt hooks (Claude Code; Gemini/Codex if present) and the /recall skill
  ensure-index                                     create MongoDB indexes
Env: AGENTDESK_MONGO_URL (default mongodb://127.0.0.1:27017), AGENTDESK_MONGO_DB (agentdesk), AGENTDESK_RECALL_MODEL (haiku)`;

async function main() {
  if (!cmd || cmd === "help") { console.log(usage); return; }
  if (cmd === "ensure-index") { await ensureIndexes(); console.log("indexes ok"); return; }
  if (cmd === "search" || cmd === "list") {
    const all = has("--all"); const repo = flag("--repo"); const wt = flag("--worktree"); const limit = Number(flag("--limit") || 10);
    const g = gitInfo(process.cwd()); const scope = all ? {} : wt ? { worktree: wt } : { repo: repo || g.repo };
    const c = await notes(); await ensureIndexes();
    let rows;
    if (cmd === "search") {
      const q = rest.join(" ").trim(); if (!q) throw new Error("query required");
      rows = await c.find({ ...scope, $text: { $search: q } }, { projection: { score: { $meta: "textScore" }, body: 0 } }).sort({ score: { $meta: "textScore" } }).limit(limit).toArray();
    } else rows = await c.find(scope, { projection: { body: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
    if (!rows.length) { console.log(`(no notes${all ? "" : ` for repo ${scope.repo}`})`); return; }
    for (const n of rows) console.log(fmtNote(n, changedSince(g.root, n.commit, n.files)) + (n.keywords?.length ? `\n    keywords: ${n.keywords.join(", ")}` : ""));
    return;
  }
  if (cmd === "show") {
    const { ObjectId } = await import("mongodb");
    const id = rest[0]; if (!id) throw new Error("id required");
    const c = await notes(); const n = await c.findOne(ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { sessionId: id });
    if (!n) { console.log("not found"); return; }
    const g = gitInfo(process.cwd()); const changed = changedSince(g.root, n.commit, n.files);
    console.log(`# ${n.title}\n${n.summary}\n\nrepo ${n.repo} · branch ${n.branch} · commit ${n.commit} · ${n.agent} session ${n.sessionId} · ${new Date(n.createdAt).toISOString()}\nkeywords: ${(n.keywords || []).join(", ")}\nfiles: ${(n.files || []).join(", ")}${changed.length ? `\n⚠ changed since this note: ${changed.join(", ")}` : ""}\n\n${n.body}`);
    return;
  }
  if (cmd === "summarize") {
    const path = rest[0]; const cwd = flag("--cwd") || process.cwd(); const agent = flag("--agent") || "claude";
    if (!path) throw new Error("transcript path required");
    const sid = path.split("/").pop().replace(/\.jsonl$/, "");
    await runWorker(sid, path, cwd, agent, true);
    return;
  }
  if (cmd === "backfill") {
    const since = parseDur(flag("--since") || "30d"); const project = flag("--project");
    const projectsDir = join(homedir(), ".claude", "projects");
    const dirs = project ? [join(projectsDir, project.replace(/\//g, "-"))] : readdirSync(projectsDir).map(d => join(projectsDir, d));
    const c = await notes(); await ensureIndexes();
    let n = 0;
    for (const dir of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const cwd = "/" + dir.split("/").pop().replace(/^-/, "").replace(/-/g, "/");   // best-effort: project dir name encodes the cwd
      for (const f of readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
        const p = join(dir, f); const st = statSync(p);
        if (Date.now() - st.mtimeMs > since) continue;
        const sid = f.replace(/\.jsonl$/, "");
        if (await c.findOne({ sessionId: sid }, { projection: { _id: 1 } })) continue;
        n++; console.log(`summarizing ${sid} (${cwd})`);
        await runWorker(sid, p, existsSync(cwd) ? cwd : homedir(), "claude", false);
      }
    }
    console.log(`backfill done: ${n} transcript(s) processed`);
    return;
  }
  if (cmd === "install") { await install(); return; }
  console.log(usage);
}
async function runWorker(sid, path, cwd, agent, verbose) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [join(HERE, "worker.mjs"), sid, path, cwd, agent], { stdio: "inherit", env: process.env });
  if (verbose) { const tail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8").trim().split("\n").slice(-1)[0] : ""; console.log(tail || `exit ${r.status}`); }
}
function parseDur(s) { const m = String(s).match(/^(\d+)([hdw])$/); if (!m) return 30 * 86400000; return Number(m[1]) * ({ h: 3600000, d: 86400000, w: 7 * 86400000 })[m[2]]; }

// hooks + skill registration
async function install() {
  const node = process.execPath;
  const entry = (script, agent) => ({ hooks: [{ type: "command", command: `${agent && agent !== "claude" ? `AGENTDESK_AGENT=${agent} ` : ""}"${node}" "${join(HERE, script)}"`, timeout: agent === "gemini" ? 10000 : 10 }] });
  const isOurs = (e) => Array.isArray(e?.hooks) && e.hooks.some(h => /agentdesk-recall|\/recall\/on-(session-end|prompt)\.mjs/.test(h.command || ""));
  // a note is (re)written when a session ends AND right before its context is compacted — compaction is a natural
  // chapter boundary and the only chance to capture long-lived sessions that are never closed
  const targets = [
    { agent: "claude", file: join(homedir(), ".claude", "settings.json"), end: "SessionEnd", compact: "PreCompact", prompt: "UserPromptSubmit" },
    { agent: "gemini", file: join(homedir(), ".gemini", "settings.json"), end: "SessionEnd", compact: "PreCompress", prompt: "BeforeAgent" },
    { agent: "codex", file: join(homedir(), ".codex", "hooks.json"), end: "SessionEnd", compact: "PreCompact", prompt: "UserPromptSubmit" },
  ];
  for (const t of targets) {
    if (!existsSync(dirname(t.file))) continue;
    let s = {}; try { s = JSON.parse(readFileSync(t.file, "utf-8")); } catch {}
    if (existsSync(t.file)) { mkdirSync(join(homedir(), ".agentdesk", "backups"), { recursive: true }); copyFileSync(t.file, join(homedir(), ".agentdesk", "backups", `${t.agent}-settings-${Date.now()}.json`)); }
    s.hooks = s.hooks || {};
    for (const [ev, script] of [[t.end, "on-session-end.mjs"], [t.compact, "on-session-end.mjs"], [t.prompt, "on-prompt.mjs"]]) {
      const arr = (Array.isArray(s.hooks[ev]) ? s.hooks[ev] : []).filter(e => !isOurs(e));
      arr.push(entry(script, t.agent)); s.hooks[ev] = arr;
    }
    writeFileSync(t.file, JSON.stringify(s, null, 2) + "\n");
    console.log(`hooks registered for ${t.agent}: ${t.file}`);
  }
  const skillDir = join(homedir(), ".claude", "skills", "recall"); mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---
name: recall
description: Search notes distilled from past agent sessions (this repo by default) before re-analyzing code. Use when the user refers to earlier work ("지난번에", "전에 분석했던", "how did we…") or before a deep code investigation.
---

# recall — past session notes

Notes are written automatically when a session ends (\`agentdesk-recall\`, MongoDB \`agentdesk.session_notes\`). Each note has a title, outcome, keywords, files with line numbers, the git commit it was written at, and a body with findings / decisions / dead ends / open questions.

## How to use
1. Search: \`"${node}" "${join(HERE, "cli.mjs")}" search "<keywords>"\` (add \`--all\` to search every repo). Results show \`⚠ N file(s) changed since\` when the files a note relies on changed after it was written — treat those notes as hints, not facts.
2. Open a promising note: \`"${node}" "${join(HERE, "cli.mjs")}" show <id>\`.
3. Use the findings to skip work you would otherwise redo, but re-verify any file:line claim against the current code before acting on it, and say in the reply which note you used.
4. Nothing relevant → say so briefly and proceed normally. Never paste whole notes into the reply; summarize what matters.
`);
  console.log(`skill installed: ${join(skillDir, "SKILL.md")}`);
  await ensureIndexes().then(() => console.log("indexes ok")).catch(e => console.log(`indexes skipped (${e.message}) — run ensure-index once MongoDB is up`));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => close().catch(() => {}));
