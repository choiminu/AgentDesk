#!/usr/bin/env node
// Detached worker: digest → summarize (claude -p) → mask → upsert into MongoDB.
import { notes, ensureIndexes, close, digest, summarize, mask, gitInfo, log } from "./lib.mjs";
const [sessionId, transcriptPath, cwd, agent = "claude", trigger = ""] = process.argv.slice(2);
try {
  const d = digest(transcriptPath, agent);
  if (!d) { log("skip: no transcript", sessionId); process.exit(0); }
  if (d.userCount < 2 || d.text.length < 800) { log("skip: trivial session", sessionId, `turns=${d.userCount}`); process.exit(0); }
  const g = gitInfo(cwd);
  const c = await notes(); await ensureIndexes();
  const prev = await c.findOne({ sessionId }, { projection: { digestLen: 1 } });
  if (prev && prev.digestLen === d.text.length) { log("skip: unchanged", sessionId); await close(); process.exit(0); }
  const s = summarize(d.text, { repo: g.repo, branch: g.branch, commit: g.commit, title: d.title });
  if (s.skip) { log("skip: model judged trivial", sessionId); await close(); process.exit(0); }
  const note = {
    sessionId, agent, repo: g.repo, worktree: g.worktree, root: g.root, cwd, branch: g.branch, commit: g.commit,
    title: mask(d.title || s.title || "(untitled)").slice(0, 120), summary: mask(s.summary || "").slice(0, 500),
    keywords: Array.isArray(s.keywords) ? s.keywords.map(k => mask(String(k)).slice(0, 40)).slice(0, 16) : [],
    files: Array.isArray(s.files) ? s.files.map(String).slice(0, 20) : [],
    body: mask(s.body || "").slice(0, 12000), digestLen: d.text.length, turns: d.userCount,
    createdAt: new Date(), transcriptPath, lastTrigger: trigger || "manual",
  };
  await c.updateOne({ sessionId }, { $set: note }, { upsert: true });
  log("saved", trigger || "manual", sessionId, g.repo, JSON.stringify(note.title));
} catch (e) { log("error", sessionId, e.message); }
finally { await close().catch(() => {}); }
