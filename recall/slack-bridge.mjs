#!/usr/bin/env node
// Slack front desk: "@agentdesk ICV-206 정산 존에 넣어줘" in Slack → a task file for the widget → the agent's REPORT comes back in the thread.
// Config ~/.agentdesk/slack.json: { "appToken": "xapp-…", "botToken": "xoxb-…", "allowUsers": ["U…"] (optional), "allowChannels": ["C…"] (optional) }
// Jira details come from ~/.agentdesk/jira.json when present. Communication with the widget goes through files under
// ~/.agentdesk/inbox/ (tasks) and ~/.agentdesk/inbox/replies/ (results), so no port is opened.
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, mask, HOME_DIR } from "./lib.mjs";

const CFG_FILE = join(HOME_DIR, "slack.json"), JIRA_CFG = join(HOME_DIR, "jira.json");
const INBOX = join(HOME_DIR, "inbox"), REPLIES = join(INBOX, "replies");
mkdirSync(REPLIES, { recursive: true });
let cfg; try { cfg = JSON.parse(readFileSync(CFG_FILE, "utf-8")); } catch { console.error("slack.json missing or invalid"); process.exit(1); }
if (!cfg.appToken || !cfg.botToken) { console.error("slack.json needs appToken (xapp-) and botToken (xoxb-)"); process.exit(1); }
const web = new WebClient(cfg.botToken);
const sock = new SocketModeClient({ appToken: cfg.appToken });
let botUserId = null;

function zones() { try { const z = JSON.parse(readFileSync(join(homedir(), ".roca", "zones.json"), "utf-8")); return (z.zones || []).map(x => ({ id: x.id, name: x.name, icon: x.icon })); } catch { return []; } }
async function jiraIssue(key) {
  if (!existsSync(JIRA_CFG)) return null;
  try {
    const j = JSON.parse(readFileSync(JIRA_CFG, "utf-8"));
    const res = await fetch(`${j.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${key}?fields=summary,description,status,priority,assignee,labels`, { headers: { Accept: "application/json", Authorization: "Basic " + Buffer.from(`${j.email}:${j.token}`).toString("base64") }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { key, error: `HTTP ${res.status}` };
    const d = await res.json(); const f = d.fields || {};
    const text = (node) => !node ? "" : typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : (node.text || "") + (node.content ? text(node.content) + (node.type === "paragraph" ? "\n" : "") : "");
    return { key, summary: f.summary || "", status: f.status?.name || "", priority: f.priority?.name || "", assignee: f.assignee?.displayName || "", labels: f.labels || [], description: text(f.description).slice(0, 2500) };
  } catch (e) { return { key, error: e.message }; }
}
const DISPATCH_PROMPT = `You are the front desk of an office of AI coding agents. A teammate sent a Slack message asking for work.
Given the message, the Jira issue (if any) and the list of prompt zones (work categories), decide where it goes and write the instruction the agent will receive.
Return ONLY JSON: {"zoneId": "<zone id or null>", "title": "<≤ 50 chars>", "prompt": "<complete, self-contained instruction in the message's language: what to do, the ticket facts that matter, what to deliver, and: finish with REPORT_START [한 일] [변경 파일] [막힌 점] [다음 제안] REPORT_END>", "ack": "<one short sentence for the Slack thread saying what was understood and where it went>"}.
Pick the zone whose name best matches the work; null when none fits. Never invent ticket facts.`;
async function dispatch(text, issues) {
  const input = `MESSAGE: ${text}\n\nJIRA: ${issues.length ? JSON.stringify(issues) : "(none)"}\n\nZONES: ${JSON.stringify(zones())}`;
  const r = spawnSync("claude", ["-p", "--model", process.env.AGENTDESK_RECALL_MODEL || "haiku", "--output-format", "json", "--json-schema", JSON.stringify({ type: "object", additionalProperties: false, required: ["zoneId", "title", "prompt", "ack"], properties: { zoneId: { type: ["string", "null"] }, title: { type: "string" }, prompt: { type: "string" }, ack: { type: "string" } } }), "--system-prompt", DISPATCH_PROMPT, "--disable-slash-commands", "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"], { input: mask(input), encoding: "utf-8", timeout: 120000, env: { ...process.env, AGENTDESK_RECALL: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "all" }, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`dispatcher failed: ${(r.stderr || "").slice(0, 200)}`);
  const env2 = JSON.parse(r.stdout); return env2.structured_output || JSON.parse(env2.result);
}
async function handle(ev) {
  if (!ev || ev.bot_id || (botUserId && ev.user === botUserId)) return;
  if (cfg.allowUsers && !cfg.allowUsers.includes(ev.user)) return;
  if (cfg.allowChannels && !cfg.allowChannels.includes(ev.channel)) return;
  const text = String(ev.text || "").replace(/<@[A-Z0-9]+>/g, "").trim(); if (!text) return;
  const thread = ev.thread_ts || ev.ts;
  const keys = [...new Set((text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []))].slice(0, 3);
  try {
    await web.reactions.add({ channel: ev.channel, timestamp: ev.ts, name: "eyes" }).catch(() => {});
    const issues = (await Promise.all(keys.map(jiraIssue))).filter(Boolean);
    const d = await dispatch(text, issues);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task = { id, ts: Date.now(), channel: ev.channel, thread, user: ev.user, text, tickets: keys, issues, zoneId: d.zoneId, title: d.title, prompt: d.prompt };
    writeFileSync(join(INBOX, `${id}.json`), JSON.stringify(task, null, 2));
    await web.chat.postMessage({ channel: ev.channel, thread_ts: thread, text: `📥 ${d.ack}` });
    log("slack task", id, JSON.stringify(d.title));
  } catch (e) {
    log("slack error", e.message);
    await web.chat.postMessage({ channel: ev.channel, thread_ts: thread, text: `⚠️ 접수 실패: ${e.message}` }).catch(() => {});
  }
}
// replies written by the widget → Slack thread
function pumpReplies() {
  for (const f of readdirSync(REPLIES).filter(f => f.endsWith(".json"))) {
    const p = join(REPLIES, f); let r; try { r = JSON.parse(readFileSync(p, "utf-8")); } catch { unlinkSync(p); continue; }
    web.chat.postMessage({ channel: r.channel, thread_ts: r.thread, text: r.text }).then(() => unlinkSync(p)).catch(e => log("slack reply error", e.message));
  }
}
sock.on("app_mention", async ({ event, ack }) => { await ack(); handle(event); });
sock.on("message", async ({ event, ack }) => { await ack(); if (event && event.channel_type === "im" && !event.subtype) handle(event); });
(async () => {
  try { const me = await web.auth.test(); botUserId = me.user_id; log("slack bridge up as", me.user); } catch (e) { console.error("auth.test failed:", e.message); process.exit(1); }
  await sock.start();
  setInterval(pumpReplies, 3000);
})();
