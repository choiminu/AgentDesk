#!/usr/bin/env node
// SessionStart hook: inject only notes relevant to what this checkout is about right now.
// No prompt exists yet, so relevance comes from the branch name, files modified in the working tree and files
// touched by the last commits; a note must match that text AND (same worktree or overlapping files) to be shown.
import { notes, close, changedSince, gitInfo, fmtNote } from "./lib.mjs";
import { execFileSync } from "node:child_process";
if (process.env.AGENTDESK_RECALL) process.exit(0);
let raw = ""; process.stdin.setEncoding("utf-8");
process.stdin.on("data", d => raw += d);
process.stdin.on("end", async () => {
  const guard = setTimeout(() => process.exit(0), 2500);
  try {
    let ev = {}; try { ev = JSON.parse(raw); } catch {}
    if (ev.source === "clear") return;
    const cwd = ev.cwd || process.cwd(); const g = gitInfo(cwd);
    const git = (args) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
    // context signature: branch words + basenames of dirty files and of files in the last 5 commits
    const dirty = git(["status", "--porcelain"]).split("\n").map(l => l.slice(3).trim()).filter(Boolean);
    const recent = git(["log", "-5", "--name-only", "--format="]).split("\n").filter(Boolean);
    const files = [...new Set([...dirty, ...recent])];
    const words = new Set();
    for (const w of (g.branch || "").split(/[-_\/.]/)) if (w.length >= 3 && !/^(main|master|dev|develop|feature|fix|refs|heads)$/i.test(w)) words.add(w);
    for (const f of files) for (const w of f.split("/").pop().replace(/\.[a-z0-9]+$/i, "").split(/[-_.]|(?=[A-Z])/)) if (w.length >= 3) words.add(w);
    if (g.worktree && g.worktree !== g.repo) words.add(g.worktree);
    const q = [...words].slice(0, 30).join(" ");
    if (!q) return;
    const c = await notes();
    const rows = await c.find({ $text: { $search: q }, repo: g.repo, sessionId: { $ne: ev.session_id } }, { projection: { score: { $meta: "textScore" }, body: 0 } })
      .sort({ score: { $meta: "textScore" } }).limit(10).toArray();
    const fileSet = new Set(files);
    const ranked = rows.map(n => {
      const overlap = (n.files || []).map(f => f.split(":")[0]).filter(f => fileSet.has(f)).length;
      const sameWt = n.worktree === g.worktree;
      return { n, overlap, sameWt, rank: n.score + (sameWt ? 2 : 0) + overlap * 3 };
    }).filter(r => (r.sameWt && (r.overlap > 0 || r.n.score >= 2)) || r.overlap > 0).sort((a, b) => b.rank - a.rank).slice(0, 2);
    if (!ranked.length) return;
    const lines = ranked.map(r => fmtNote(r.n, changedSince(g.root, r.n.commit, r.n.files)) + (r.overlap ? ` (touches ${r.overlap} file(s) you are working on)` : ""));
    process.stdout.write(`[agentdesk-recall] Earlier session notes relevant to this checkout (branch ${g.branch}${dirty.length ? `, ${dirty.length} modified file(s)` : ""}); verify against current code before relying on them, /recall for more:\n${lines.join("\n")}\n`);
  } catch { /* Mongo down: stay silent */ }
  finally { clearTimeout(guard); await close().catch(() => {}); process.exit(0); }
});
