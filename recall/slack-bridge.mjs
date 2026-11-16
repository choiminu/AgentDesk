#!/usr/bin/env node
// Slack front desk: "@agentdesk PROJ-206 이 티켓 처리해줘" in Slack → a task file for the widget → the agent's REPORT comes back in the thread.
// Config ~/.agentdesk/slack.json: { "appToken": "xapp-…", "botToken": "xoxb-…", "allowUsers": ["U…"] (optional), "allowChannels": ["C…"] (optional),
//   "owner": "U…" (optional: this PC's owner; requests the guardrail flags go ahead only for them), "threadSource": "mcp" (optional) }
// Jira details come from ~/.agentdesk/jira.json when present. Communication with the widget goes through files under
// ~/.agentdesk/inbox/ (tasks) and ~/.agentdesk/inbox/replies/ (results), so no port is opened.
// A mention inside a thread also reads the parent message and every reply (recall/slack-thread.mjs) into
// ~/.agentdesk/inbox/threads/<task id>.md; the task names that file (threadFile) for the session. Without the bot's
// history scope (or "threadSource": "mcp" in slack.json) the task carries threadRef and the session reads it via the Slack MCP.
// The dispatcher sees the running sessions (~/.agentdesk/inbox-context.json, written by the widget) and picks one to
// continue (sessionId) or a place for a new session (workspace + name); the widget routes it (core/outbound.js inboxTarget).
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { replyPayload, answerPayload, routeFromTask } from "./slack-format.mjs";
import { fetchThread, formatThread } from "./slack-thread.mjs";
import { dispatch, deskContext } from "./slack-desk.mjs";
import { join } from "node:path";
import { log, mask, HOME_DIR } from "./lib.mjs";

const CFG_FILE = join(HOME_DIR, "slack.json"), JIRA_CFG = join(HOME_DIR, "jira.json");
const INBOX = join(HOME_DIR, "inbox"), REPLIES = join(INBOX, "replies"), THREADS = join(INBOX, "threads");
mkdirSync(REPLIES, { recursive: true }); mkdirSync(THREADS, { recursive: true });
const THREAD_FILES_MAX = 50;
let cfg; try { cfg = JSON.parse(readFileSync(CFG_FILE, "utf-8")); } catch { console.error("slack.json missing or invalid"); process.exit(1); }
if (!cfg.appToken || !cfg.botToken) { console.error("slack.json needs appToken (xapp-) and botToken (xoxb-)"); process.exit(1); }
const web = new WebClient(cfg.botToken);
const sock = new SocketModeClient({ appToken: cfg.appToken });
let botUserId = null;

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
async function threadContext(ev) {
  const r = await fetchThread(web, ev.channel, ev.thread_ts);
  if (r.error) { log("slack thread read failed", r.error, r.needed || ""); return { error: r.error, needed: r.needed }; }
  const kept = r.messages.filter(m => !(botUserId && m.user === botUserId));
  return { text: formatThread(r.messages, { botUserId, mentionTs: ev.ts }), count: kept.length };
}
function pruneThreads() {
  try { const fs = readdirSync(THREADS).filter(f => f.endsWith(".md")).sort(); for (const f of fs.slice(0, Math.max(0, fs.length - THREAD_FILES_MAX))) unlinkSync(join(THREADS, f)); } catch {}
}
// the same request again in the same thread within 3 minutes (sent twice, "요약해줘" then "요약해줘.", a Slack retry): once
const recent = new Map(), RECENT_MS = 3 * 60 * 1000;
function seenRecently(ev, thread, text) {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > RECENT_MS) recent.delete(k);
  const key = `${ev.channel}:${thread}:${ev.user}:${text.replace(/[\s.!?~。]+/g, "").toLowerCase()}`;
  const hit = recent.has(key) || recent.has(`ts:${ev.ts}`);
  recent.set(key, now); recent.set(`ts:${ev.ts}`, now);
  return hit;
}
async function handle(ev) {
  if (!ev || ev.bot_id || (botUserId && ev.user === botUserId)) return;
  if (cfg.allowUsers && !cfg.allowUsers.includes(ev.user)) return;
  if (cfg.allowChannels && !cfg.allowChannels.includes(ev.channel)) return;
  const text = String(ev.text || "").replace(/<@[A-Z0-9]+>/g, "").trim(); if (!text) return;
  const thread = ev.thread_ts || ev.ts;
  // an option number ("1") may answer a new question each time: only the same event (ts) counts as a repeat for it
  const dedupeText = ev.thread_ts && globalThis.AgentDeskOutbound.slackChoice(text) ? `${text}@${ev.ts}` : text;
  if (seenRecently(ev, thread, dedupeText)) { log("slack duplicate skipped", ev.channel, thread); return; }
  const keys = [...new Set((text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []))].slice(0, 3);
  // "owner" in slack.json: this PC's owner. A request the guardrail flags goes ahead only for them (widget inboxGuard)
  const fromOwner = !!cfg.owner && ev.user === cfg.owner;
  // "2" / "2번" in a thread answers the question its session is asking: straight to the widget, no dispatcher round trip
  const pick = ev.thread_ts ? globalThis.AgentDeskOutbound.slackChoice(text) : 0;
  if (pick) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(join(INBOX, `${id}.json`), JSON.stringify({ id, ts: Date.now(), channel: ev.channel, thread, user: ev.user, fromOwner, text, kind: "control", op: "choose", input: String(pick), sessionId: null, title: `${pick}번 선택` }, null, 2));
    log("slack choice", id, pick);
    return;
  }
  try {
    const issues = (await Promise.all(keys.map(jiraIssue))).filter(Boolean);
    // a mention inside a thread: read the parent and every reply so the agent gets the whole conversation.
    // Without the history scope (or with threadSource "mcp") the session reads it itself with the Slack MCP (threadRef)
    const th = ev.thread_ts && cfg.threadSource !== "mcp" ? await threadContext(ev) : null;
    const threadRef = ev.thread_ts && !th?.text ? { channel: ev.channel, ts: ev.thread_ts } : null;
    const d = await dispatch(text, issues, th?.text || "", deskContext(), threadRef, ev.user);
    // lookup (a question) and clarify (one question back): answered in the thread, nothing is handed to a session
    if (d.action === "lookup" || d.action === "clarify") {
      await web.chat.postMessage({ channel: ev.channel, thread_ts: thread, ...answerPayload(d.reply || d.ack, d.title) });
      log("slack answer", JSON.stringify(d.title));
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task = { id, ts: Date.now(), channel: ev.channel, thread, user: ev.user, fromOwner, text, tickets: keys, issues, sessionId: d.sessionId, workspace: d.workspace, name: d.name, title: d.title, prompt: d.prompt };
    // control: the widget acts on that session (stop it, read its screen, type into it) and answers in the thread
    if (d.action === "control") Object.assign(task, { kind: "control", op: d.op, input: d.input });
    if (th?.text) { const f = join(THREADS, `${id}.md`); writeFileSync(f, th.text); task.threadFile = f; task.threadCount = th.count; pruneThreads(); }
    else if (threadRef) task.threadRef = threadRef;
    if (th?.error) task.threadError = th.error;
    writeFileSync(join(INBOX, `${id}.json`), JSON.stringify(task, null, 2));
    // no "received" post here: the widget posts the one line that says which session took it (▶ …)
    log("slack task", id, JSON.stringify(d.title));
  } catch (e) {
    log("slack error", e.message);
    await web.chat.postMessage({ channel: ev.channel, thread_ts: thread, text: `접수 실패: ${mask(e.message)}` }).catch(() => {});
  }
}
// replies written by the widget → Slack thread
// replyPayload masks every text field (the file may have been written by anything, not only the widget)
// a reply file is claimed by renaming it first, so two bridges (e.g. a dev widget next to the installed one) never post it twice
function pumpReplies() {
  for (const f of readdirSync(REPLIES).filter(f => f.endsWith(".json"))) {
    const p = join(REPLIES, f), claimed = p + ".sending";
    try { renameSync(p, claimed); } catch { continue; }
    let r; try { r = JSON.parse(readFileSync(claimed, "utf-8")); } catch { unlinkSync(claimed); continue; }
    // same checks as the main process: a file written by anything else must still name a plain channel and thread
    if (!routeFromTask(r)) { log("slack reply dropped: bad channel/thread", f); unlinkSync(claimed); continue; }
    web.chat.postMessage({ channel: r.channel, thread_ts: r.thread, ...replyPayload(r) })
      .then(() => unlinkSync(claimed))
      .catch(e => { log("slack reply error", e.message); try { renameSync(claimed, p); } catch {} });
  }
}
sock.on("app_mention", async ({ event, ack }) => { await ack(); handle(event); });
sock.on("message", async ({ event, ack }) => { await ack(); if (event && event.channel_type === "im" && !event.subtype) handle(event); });
(async () => {
  try { const me = await web.auth.test(); botUserId = me.user_id; log("slack bridge up as", me.user); } catch (e) { console.error("auth.test failed:", e.message); process.exit(1); }
  await sock.start();
  setInterval(pumpReplies, 3000);
})();
