#!/usr/bin/env node
// SessionEnd hook: hand the transcript to a detached worker and exit at once (hooks must not block the CLI).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
if (process.env.AGENTDESK_RECALL) process.exit(0);          // our own summarizer session — do not recurse
let raw = ""; process.stdin.setEncoding("utf-8");
process.stdin.on("data", d => raw += d);
process.stdin.on("end", () => {
  let ev = {}; try { ev = JSON.parse(raw); } catch {}
  if (!ev.transcript_path || !ev.session_id) process.exit(0);
  const agent = process.env.AGENTDESK_AGENT || "claude";
  const worker = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
  spawn(process.execPath, [worker, ev.session_id, ev.transcript_path, ev.cwd || process.cwd(), agent], { detached: true, stdio: "ignore", env: process.env }).unref();
  process.exit(0);
});
