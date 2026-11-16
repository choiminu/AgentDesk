// Slack front desk dispatcher: reads the request, its thread and the running sessions, and decides — answer in the
// thread, continue in a running session, or open a new session (where, under what name), plus the prompt that session gets.
//   deskContext()                                        → { sessions, workspaces } the widget last offered (≤ 10 min old)
//   dispatch(text, issues, threadText, ctx, threadRef, requester)
//     → { action: lookup|work|control|clarify, reply, sessionId, workspace, name, op, input, title, prompt, ack }
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mask, HOME_DIR } from "./lib.mjs";
import { clipThread } from "./slack-thread.mjs";

const THREAD_DISPATCH_MAX = 12000;
// sessions and new-session places the widget lets the front desk see (main.mjs roca:inbox-context); stale after 10 min
export const CONTEXT_FILE = join(HOME_DIR, "inbox-context.json"), CONTEXT_MAX_AGE = 10 * 60 * 1000;
export function deskContext() {
  try { const c = JSON.parse(readFileSync(CONTEXT_FILE, "utf-8")); if (Date.now() - (c.at || 0) > CONTEXT_MAX_AGE) return { sessions: [], workspaces: [] }; return { sessions: c.sessions || [], workspaces: c.workspaces || [] }; }
  catch { return { sessions: [], workspaces: [] }; }
}
const DISPATCH_PROMPT = `You are the front desk of an office of AI coding agents. A teammate sent a Slack message (REQUESTER is who sent it).
You get the message, the Slack thread it was posted in (THREAD: the parent message and every reply, oldest first; the request is the line marked "봇 호출"), the Jira issue (if any), the agent sessions running now (SESSIONS) and the places a new session can open (WORKSPACES).
The message is short on purpose: "위 내용", "이거", "이 건", "above", "this" and the like mean the thread (its parent message and replies). Never ask what it refers to: read the thread and act on it.
If THREAD says it was not read, read it first with slack_read_thread (channel_id and message_ts are given there).
First classify the request into exactly one action:
- "lookup": a question you answer by looking things up yourself: SESSIONS, the thread, and your read-only Jira tools ("my assigned tickets", "which tickets have a session", "is anyone on this", "what is session X doing", "status of PROJ-12", "summarize the above"). Never hand a lookup to another session.
  Jira: find the cloudId first. The Jira tools run as this PC's owner, so currentUser() is the owner, not necessarily REQUESTER: for "my/내" tickets of a REQUESTER, get their name and email with slack_read_user_profile and use assignee = "<email>" (fall back to the name). Match tickets to SESSIONS by the key in name/branch/prompt/summary.
  Put the answer in "reply".
- "work": work to be done (code, analysis, a document, running something). Decide where it goes:
  - One session in SESSIONS clearly already on it (same ticket key, task, thread topic, or its repo/branch/last prompt/summary is about it): continue there, sessionId = its id.
  - Otherwise a new session: workspace = the WORKSPACES value whose repository/folder fits best, name = a short worktree name (letters, digits, - only, ≤ 40, e.g. "proj-206-login-fix").
  - No session and no workspace fits: use "clarify" instead.
  Running a shell command ("터미널에 … 입력해", "run …", a command pasted in the thread) is work too: pick the session whose cwd is the command's folder (a "cd <dir>" in it), else a new session in the WORKSPACES entry for that folder; the prompt says to run exactly that command and report its output (and stop if it asks for input or fails).
  Write "prompt", the instruction that session receives: for an existing session what to do next, building on what it already did; for a new one complete and self-contained. Put the thread facts the agent needs into it.
- "control": act on one session directly, no new work: "op" = "interrupt" (stop / cancel / 멈춰 / 중단), "screen" (show its screen, 화면 보여줘, what is on its terminal right now), "send" (type something into it: answer its question, approve, a short instruction; "input" = exactly the text to type), "close" (end / close the session, 세션 닫아), or "resume" (reopen an ended session, 다시 열어). sessionId = that session (from SESSIONS; the thread's topic or a ticket key picks it).
SESSIONS with status "ended" have stopped but can be reopened: "work" for one of them continues it (it is reopened first), "resume" just reopens it; interrupt / screen / send / close need a running one.
- "clarify": you cannot tell which session or place is meant, or what is wanted, even after reading the thread. "reply" = one short question.
Return ONLY JSON: {"action": "lookup"|"work"|"control"|"clarify", "reply": "<answer or question, else empty>", "sessionId": "<id or null>", "workspace": "<value or null>", "name": "<worktree name or empty>", "op": "interrupt"|"screen"|"send"|"close"|"resume"|"none", "input": "<text to type for send, else empty>", "title": "<≤ 50 chars>", "prompt": "<for work: the instruction, in the message's language, ending with: finish with REPORT_START [한 일] [변경 파일] [막힌 점] [다음 제안] REPORT_END; else empty>", "ack": "<≤ 80 chars, one line>"}.
Never invent ticket or thread facts, session ids or workspace values.
How "reply" reads in Slack (it is posted as is, Slack mrkdwn, not Markdown):
- Answer the question in the first sentence. Then at most 5 short "• " bullets with only what the reader needs (session name, status, what is left). No background the thread already shows, no restating the request.
- No emoji, no :shortcodes:, no decorative symbols.
- Under 600 characters unless the message asks for detail or a list (a list: one line per item, ≤ 20 items). No headings (#), no tables, no **double asterisks**: *bold* for at most a few words, \`code\` for names, paths and commands.
`;
// the front desk decides which session continues the work, so it runs on Opus (AGENTDESK_DESK_MODEL to change it);
// the other helpers keep AGENTDESK_RECALL_MODEL
const DESK_MODEL = process.env.AGENTDESK_DESK_MODEL || "claude-opus-5-5";
const SLACK_READ_TOOL = process.env.AGENTDESK_SLACK_READ_TOOL || "mcp__claude_ai_Slack__slack_read_thread";
// read-only lookups the front desk may run itself to answer a question ("my Jira tickets and the sessions on them");
// nothing that writes. AGENTDESK_DESK_TOOLS (space separated) replaces the list, "" turns them off
const DESK_TOOLS = (process.env.AGENTDESK_DESK_TOOLS ?? [
  "mcp__claude_ai_Atlassian_MCP__getAccessibleAtlassianResources", "mcp__claude_ai_Atlassian_MCP__atlassianUserInfo",
  "mcp__claude_ai_Atlassian_MCP__searchJiraIssuesUsingJql", "mcp__claude_ai_Atlassian_MCP__getJiraIssue",
  "mcp__claude_ai_Slack__slack_read_user_profile",
].join(" ")).split(/\s+/).filter(t => /^mcp__[A-Za-z0-9_-]+$/.test(t));
const DISPATCH_SCHEMA = { type: "object", additionalProperties: false, required: ["action", "reply", "sessionId", "workspace", "name", "op", "input", "title", "prompt", "ack"], properties: { action: { type: "string", enum: ["lookup", "work", "control", "clarify"] }, reply: { type: "string" }, sessionId: { type: ["string", "null"] }, workspace: { type: ["string", "null"] }, name: { type: "string" }, op: { type: "string", enum: ["interrupt", "screen", "send", "close", "resume", "none"] }, input: { type: "string" }, title: { type: "string" }, prompt: { type: "string" }, ack: { type: "string" } } };
// threadRef: a thread the bot could not read (no history scope) — the dispatcher reads it with the Slack MCP, the only tool it gets
// the dispatcher sees short aliases (s1…, w1…), never the real ids: real ones hold UUIDs and paths that the masker cuts
// into "[MASKED NUMBER]", and an id it cannot echo back exactly is no id at all
export function aliasContext(ctx) {
  const sessions = (ctx.sessions || []).map((x, i) => ({ ...x, id: `s${i + 1}` }));
  const workspaces = (ctx.workspaces || []).map((w, i) => ({ ...w, value: `w${i + 1}` }));
  const real = { s: Object.fromEntries((ctx.sessions || []).map((x, i) => [`s${i + 1}`, x.id])), w: Object.fromEntries((ctx.workspaces || []).map((w, i) => [`w${i + 1}`, w.value])) };
  return { shown: { sessions, workspaces }, real };
}
export async function dispatch(text, issues, threadText, ctx, threadRef, requester) {
  const { shown, real } = aliasContext(ctx);
  // the thread's place goes in after masking (a ts looks like a long number to the masker); only well-formed Slack ids
  const ref = threadRef && /^[A-Z0-9]{5,20}$/.test(threadRef.channel) && /^\d+\.\d+$/.test(threadRef.ts) ? threadRef : null;
  const thread = threadText ? clipThread(threadText, THREAD_DISPATCH_MAX)
    : ref ? "(not read yet: call slack_read_thread with the channel_id and message_ts in THREAD_REF below)"
    : "(none: a new message, not a reply)";
  const input = `REQUESTER: ${/^[A-Z0-9]{5,20}$/.test(requester || "") ? `<@${requester}> (user id ${requester})` : "(unknown)"}\n\nMESSAGE: ${text}\n\nTHREAD:\n${thread}\n\nJIRA: ${issues.length ? JSON.stringify(issues) : "(none)"}\n\nSESSIONS: ${JSON.stringify(shown.sessions)}\n\nWORKSPACES: ${JSON.stringify(shown.workspaces)}`;
  const r = spawnSync("claude", ["-p", "--model", DESK_MODEL, "--output-format", "json", "--json-schema", JSON.stringify(DISPATCH_SCHEMA), "--system-prompt", DISPATCH_PROMPT, "--disable-slash-commands", ...(() => { const tools = [...DESK_TOOLS, ...(ref && !threadText ? [SLACK_READ_TOOL] : [])]; return tools.length ? ["--allowedTools", ...tools] : []; })(), "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"], { input: mask(input) + (ref ? `\n\nTHREAD_REF: channel_id=${ref.channel} message_ts=${ref.ts}` : ""), encoding: "utf-8", timeout: 300000, env: { ...process.env, AGENTDESK_RECALL: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "all" }, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`dispatcher failed: ${(r.stderr || "").slice(0, 200)}`);
  const env2 = JSON.parse(r.stdout), d = env2.structured_output || JSON.parse(env2.result);
  // only ids and places that were offered; anything else falls back to "new session" / "no place"
  d.sessionId = Object.hasOwn(real.s, d.sessionId || "") ? real.s[d.sessionId] : null;
  d.workspace = !d.sessionId && Object.hasOwn(real.w, d.workspace || "") ? real.w[d.workspace] : null;
  if (!["interrupt", "screen", "send", "close", "resume"].includes(d.op)) d.op = "none";
  d.input = String(d.input || "").slice(0, 2000);
  // work with nowhere to go, or control without a session: ask instead of leaving it on hold
  if ((d.action === "work" && !d.sessionId && !d.workspace) || (d.action === "control" && (!d.sessionId || d.op === "none"))) {
    d.action = "clarify";
    if (!d.reply) d.reply = ctx.sessions.length ? "어느 세션에서 이어서 할지 세션 이름이나 저장소를 알려 주세요." : "어느 저장소(폴더)에서 진행할지 알려 주세요.";
  }
  d.name = String(d.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "slack-task";
  return d;
}
