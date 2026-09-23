#!/usr/bin/env node
// UserPromptSubmit hook: print up to 3 matching past notes as extra context (title + outcome + staleness), fast.
import { notes, close, changedSince, gitInfo, fmtNote } from "./lib.mjs";
if (process.env.AGENTDESK_RECALL) process.exit(0);
let raw = ""; process.stdin.setEncoding("utf-8");
process.stdin.on("data", d => raw += d);
process.stdin.on("end", async () => {
  const guard = setTimeout(() => process.exit(0), 2500);
  try {
    let ev = {}; try { ev = JSON.parse(raw); } catch {}
    const prompt = String(ev.prompt || "").trim();
    if (prompt.length < 12 || /^\//.test(prompt)) return;            // short prompts and slash commands: nothing to recall
    const g = gitInfo(ev.cwd || process.cwd());
    const c = await notes();
    const q = prompt.replace(/[^\p{L}\p{N}_.\-\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2).slice(0, 24).join(" ");
    if (!q) return;
    // same repo pool; notes written in this very worktree rank first (shared repos like a catch-all "etc" workspace hold unrelated tasks)
    const rows = await c.find({ $text: { $search: q }, repo: g.repo }, { projection: { score: { $meta: "textScore" }, title: 1, summary: 1, repo: 1, worktree: 1, commit: 1, createdAt: 1, files: 1 } })
      .sort({ score: { $meta: "textScore" } }).limit(8).toArray();
    // same worktree: a modest match is enough; another worktree of the same repo must match strongly (shared "etc"-style
    // workspaces hold unrelated tasks, and a note that merely shares a common word like "session" is noise)
    const good = rows.map(r => ({ ...r, sameWt: r.worktree === g.worktree, rank: r.score + (r.worktree === g.worktree ? 2 : 0) }))
      .filter(r => r.sameWt ? r.score >= 1.5 : r.score >= 4).sort((a, b) => b.rank - a.rank).slice(0, 3);
    if (!good.length) return;
    const lines = good.map(n => fmtNote(n, changedSince(g.root, n.commit, n.files)));
    process.stdout.write(`[agentdesk-recall] Past session notes that may match this request (run \`agentdesk-recall show <id>\` for the full note; verify against current code before relying on them):\n${lines.join("\n")}\n`);
  } catch { /* Mongo down or no index: stay silent */ }
  finally { clearTimeout(guard); await close().catch(() => {}); process.exit(0); }
});
