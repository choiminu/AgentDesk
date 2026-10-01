#!/usr/bin/env node
// Morning briefing: read yesterday's session notes (open questions, dead ends), hook activity and — when
// ~/.agentdesk/jira.json exists — Jira issues due today, then ask Claude (Haiku) for a short briefing the
// office writes on its whiteboard. Output: ~/.agentdesk/briefing.json
import { notes, close, mask, log, HOME_DIR } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = join(HOME_DIR, "briefing.json");
const JIRA_CFG = join(HOME_DIR, "jira.json");   // { "baseUrl": "https://x.atlassian.net", "email": "...", "token": "...", "jql": "optional" }

function sectionOf(body, names) {
  const re = new RegExp(`^##\\s*(?:${names.join("|")})[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, "mi");
  const m = String(body || "").match(re); return m ? m[1].trim() : "";
}
function hookStats(sinceMs) {
  const f = join(homedir(), ".roca", "events.jsonl"); if (!existsSync(f)) return null;
  const sessions = new Map(); let asks = 0;
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    if (!line.startsWith("{")) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    const ts = (r.ts || 0) * 1000; if (ts < sinceMs) continue; const ev = r.ev || {}; if (!ev.session_id) continue;
    const s = sessions.get(ev.session_id) || { agent: r.agent || "claude", cwd: ev.cwd, prompts: 0, tools: 0 };
    if (ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "BeforeAgent") s.prompts++;
    if (ev.hook_event_name === "PreToolUse" || ev.hook_event_name === "BeforeTool") s.tools++;
    if (ev.hook_event_name === "PermissionRequest" || (ev.hook_event_name === "Notification" && /permission|needs_input|ToolPermission|elicitation/i.test(ev.notification_type || ""))) asks++;
    sessions.set(ev.session_id, s);
  }
  const byRepo = {}; for (const s of sessions.values()) { const k = (s.cwd || "").split("/").filter(Boolean).pop() || "?"; byRepo[k] = (byRepo[k] || 0) + 1; }
  return { sessions: sessions.size, prompts: [...sessions.values()].reduce((a, s) => a + s.prompts, 0), tools: [...sessions.values()].reduce((a, s) => a + s.tools, 0), asks, byRepo };
}
async function jiraDue() {
  if (!existsSync(JIRA_CFG)) return null;
  let cfg; try { cfg = JSON.parse(readFileSync(JIRA_CFG, "utf-8")); } catch { return { error: "jira.json is not valid JSON" }; }
  if (!cfg.baseUrl || !cfg.email || !cfg.token) return { error: "jira.json needs baseUrl, email, token" };
  const jql = cfg.jql || "assignee = currentUser() AND statusCategory != Done AND (duedate <= endOfDay() OR priority in (Highest, High)) ORDER BY duedate ASC";
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/rest/api/3/search/jql`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64") }, body: JSON.stringify({ jql, maxResults: 15, fields: ["summary", "status", "duedate", "priority"] }), signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `Jira HTTP ${res.status}` };
    const j = await res.json();
    return { issues: (j.issues || []).map(i => ({ key: i.key, summary: i.fields?.summary || "", status: i.fields?.status?.name || "", due: i.fields?.duedate || null, priority: i.fields?.priority?.name || "" })) };
  } catch (e) { return { error: e.message }; }
}
const BRIEF_PROMPT = `You write the morning whiteboard briefing for a developer whose AI coding agents worked yesterday.
Input: recent session notes (title, outcome, open questions, dead ends), activity counts, and optionally Jira issues due today.
Return ONLY JSON: {"headline": "<≤ 60 chars, the one thing to know this morning>", "lines": ["<3–6 bullets, ≤ 90 chars each: unresolved questions to pick up, tickets due today, risks, and one concrete suggested first task>"], "open_questions": ["<verbatim-ish short items>"], "mood": "calm|busy|urgent"}.
Write in the language of the notes (Korean if they are Korean). Be specific: name repos, tickets and files. No greetings, no filler. If there is nothing notable, say so in one line.`;

export async function makeBriefing() {
  const since = Date.now() - 36 * 3600 * 1000;
  const c = await notes();
  const rows = await c.find({ createdAt: { $gte: new Date(since) } }, { projection: { title: 1, summary: 1, body: 1, repo: 1, worktree: 1, keywords: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(25).toArray();
  const noteText = rows.map(n => `- [${n.repo}/${n.worktree}] ${n.title} — ${n.summary}\n  open: ${sectionOf(n.body, ["남은 의문", "Open questions"]).replace(/\s+/g, " ").slice(0, 300) || "-"}\n  dead ends: ${sectionOf(n.body, ["실패한 시도", "Dead ends"]).replace(/\s+/g, " ").slice(0, 200) || "-"}`).join("\n");
  const stats = hookStats(since); const jira = await jiraDue();
  const input = `===== SESSION NOTES (last 36h) =====\n${noteText || "(none)"}\n\n===== ACTIVITY =====\n${stats ? JSON.stringify(stats) : "(no hook data)"}\n\n===== JIRA DUE / HIGH =====\n${jira ? (jira.error ? `error: ${jira.error}` : JSON.stringify(jira.issues)) : "(jira not configured)"}\n\nToday: ${new Date().toISOString().slice(0, 10)}`;
  const r = spawnSync("claude", ["-p", "--model", process.env.AGENTDESK_RECALL_MODEL || "haiku", "--output-format", "json", "--json-schema", JSON.stringify({ type: "object", additionalProperties: false, required: ["headline", "lines", "open_questions", "mood"], properties: { headline: { type: "string" }, lines: { type: "array", items: { type: "string" } }, open_questions: { type: "array", items: { type: "string" } }, mood: { type: "string", enum: ["calm", "busy", "urgent"] } } }), "--system-prompt", BRIEF_PROMPT, "--disable-slash-commands", "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"], { input: mask(input), encoding: "utf-8", timeout: 180000, env: { ...process.env, AGENTDESK_RECALL: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "all" }, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude -p failed: ${(r.stderr || "").slice(0, 200)}`);
  const env2 = JSON.parse(r.stdout); const obj = env2.structured_output || (typeof env2.result === "string" ? JSON.parse(env2.result) : env2.result);
  const out = { date: new Date().toISOString().slice(0, 10), generatedAt: Date.now(), headline: obj.headline, lines: obj.lines || [], open_questions: obj.open_questions || [], mood: obj.mood || "calm", notes: rows.length, stats, jira: jira && !jira.error ? { count: jira.issues.length, keys: jira.issues.map(i => i.key) } : (jira ? { error: jira.error } : null) };
  mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2));
  log("briefing", out.date, JSON.stringify(out.headline));
  return out;
}
if (process.argv[1] && process.argv[1].endsWith("brief.mjs")) {
  makeBriefing().then(o => { console.log(o.headline); for (const l of o.lines) console.log("•", l); }).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => close().catch(() => {}));
}
