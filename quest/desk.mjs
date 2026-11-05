// AgentDesk Quest board: the front desk. One headless `claude -p` call proposes who takes a ticket (an idle session of
// mine or a new worktree in a known repo). The proposal is only a suggestion: nothing dispatches without the owner's click.
//
//   deskArgs()                       → argv for `claude` (model AGENTDESK_QUEST_MODEL || haiku, JSON schema, no tools, no MCP, no settings)
//   askDesk({ issue, party, repos, run, signal, timeoutMs })
//        → Promise<{ ok: true, choice, reason } | { ok: false, error: 'timeout'|'invalid'|'failed'|'cancelled'|'busy' }>
//        run(input, { signal }) → Promise<{ code, stdout }>; input = the masked front-desk prompt (stdin)
//   createDesk({ run, now, timeoutMs, maxInflight }) → { ask({ key, issue, party, repos }), cancel(key), pending(key) }
//        at most maxInflight (2) calls across tickets; another ticket's ask then gets { ok: false, error: 'busy' }
//        one call per ticket at a time (a second ask joins the first), ok proposals cached per ticket 10 minutes
//        (re-checked against the current party / repos on a hit)
//   spawnRun({ cmd, env, killGraceMs }) → a `run` that spawns `claude` with deskArgs(), stdin input; on abort SIGTERM, SIGKILL 3 s later
//        env (when given) is used as is: the caller passes PATH and the hook-quiet variables
//   killAllDesk() → kill every running desk child (app quit)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import "../core/mask.js";    // globalThis.AgentDeskMask
import "../core/quest.js";   // globalThis.AgentDeskQuest

export const DESK_TIMEOUT_MS = 90000;
export const DESK_CACHE_MS = 10 * 60000;
export const DESK_MAX_INFLIGHT = 2;
export const DESK_KILL_GRACE_MS = 3000;
const HOOK_QUIET = { AGENTDESK_RECALL: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "all" };
const REASON_MAX = 300;
const OUT_MAX = 1024 * 1024;
const Q = () => globalThis.AgentDeskQuest;
const mask = s => globalThis.AgentDeskMask.mask(String(s ?? ""));

export function deskArgs() {
  // isolation: the ticket text is someone else's, so the run gets no tools at all (--tools ""), no MCP server
  // (--strict-mcp-config with no --mcp-config), and no user / project / local settings (--setting-sources "": their
  // allowlists, hooks and MCP entries do not apply). --disallowedTools stays as a second fence. It is variadic: keep it last.
  return ["-p", "--model", process.env.AGENTDESK_QUEST_MODEL || "haiku", "--output-format", "json", "--json-schema", Q().DESK_SCHEMA,
    "--system-prompt", Q().DESK_SYSTEM, "--disable-slash-commands", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
    "--no-session-persistence",   // the ticket and the session list are not kept as a transcript on disk
    "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"];
}

const DESC_HARD_MAX = 20000;
function maskDesc(issue) {
  if (!issue || typeof issue !== "object") return issue;
  const cut = v => (v == null || v === "" ? v : mask(String(v).slice(0, DESC_HARD_MAX)));   // both places deskPrompt reads
  const out = { ...issue, description: cut(issue.description) };
  if (issue.fields && typeof issue.fields === "object") out.fields = { ...issue.fields, description: cut(issue.fields.description) };
  return out;
}

// the `--output-format json` envelope: structured_output (with --json-schema), else `result` as a JSON string / object
function answerOf(stdout) {
  let env;
  try { env = JSON.parse(String(stdout || "")); } catch { return null; }
  if (!env || typeof env !== "object") return null;
  if (env.structured_output && typeof env.structured_output === "object") return env.structured_output;
  if (typeof env.result === "string") { try { return JSON.parse(env.result); } catch { return null; } }
  return env.result && typeof env.result === "object" ? env.result : null;
}

export async function askDesk({ issue, party, repos, run, signal, timeoutMs = DESK_TIMEOUT_MS } = {}) {
  if (typeof run !== "function") return { ok: false, error: "failed" };
  if (signal && signal.aborted) return { ok: false, error: "cancelled" };
  // everything that leaves the machine (ticket, session names, repos, branches, summaries) is masked as one text. The
  // description is masked whole first (main caps it at 20,000 chars), so the prompt's 1,500-char cut never splits a secret
  const input = mask(Q().deskPrompt(maskDesc(issue), party, repos));
  const ac = new AbortController();
  let why = null;
  const onAbort = () => { why = why || "cancelled"; ac.abort(); };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  let timer;
  const stop = new Promise(res => {
    timer = setTimeout(() => { why = why || "timeout"; ac.abort(); res(); }, timeoutMs);
    ac.signal.addEventListener("abort", () => res(), { once: true });
  });
  try {
    let started;
    try { started = Promise.resolve(run(input, { signal: ac.signal })); } catch (e) { started = Promise.reject(e); }
    const r = await Promise.race([started.then(v => ({ v }), e => ({ e })), stop.then(() => null)]);
    if (why) return { ok: false, error: why };
    if (!r || r.e || !r.v || r.v.code !== 0) return { ok: false, error: "failed" };
    const ans = answerOf(r.v.stdout);
    const choice = ans ? Q().acceptProposal(ans, party, repos) : null;
    if (!choice) return { ok: false, error: "invalid" };
    const reason = mask(typeof ans.reason === "string" ? ans.reason : "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, REASON_MAX);
    return { ok: true, choice, reason };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (!ac.signal.aborted) ac.abort();   // let the run clean up (kill the child) whatever happened
  }
}

export function createDesk({ run, now = Date.now, timeoutMs = DESK_TIMEOUT_MS, maxInflight = DESK_MAX_INFLIGHT } = {}) {
  const inflight = new Map();   // key → { promise, ac }
  const cache = new Map();      // key → { at, result }
  return {
    ask({ key, issue, party, repos }) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < DESK_CACHE_MS && Q().acceptProposal({ choice: hit.result.choice }, party, repos)) return Promise.resolve({ ...hit.result });
      if (hit) cache.delete(key);
      const cur = inflight.get(key);
      if (cur) return cur.promise;
      if (inflight.size >= maxInflight) return Promise.resolve({ ok: false, error: "busy" });
      const ac = new AbortController();
      const promise = askDesk({ issue, party, repos, run, signal: ac.signal, timeoutMs }).catch(() => ({ ok: false, error: "failed" })).then(res => {
        if (inflight.get(key) && inflight.get(key).ac === ac) inflight.delete(key);
        if (res.ok) cache.set(key, { at: now(), result: res });
        return res;
      });
      inflight.set(key, { promise, ac });
      return promise;
    },
    cancel(key) {
      const cur = inflight.get(key);
      if (!cur) return false;
      inflight.delete(key);
      cur.ac.abort();
      return true;
    },
    pending(key) { return inflight.has(key); },
  };
}

const children = new Set();
function killChild(child, graceMs = child.__deskGrace || DESK_KILL_GRACE_MS) {
  try { child.kill("SIGTERM"); } catch {}
  const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} } }, graceMs);
  if (t.unref) t.unref();
}
export function killAllDesk() { for (const c of children) killChild(c); }

// an empty folder of our own as the working directory: no project CLAUDE.md or .claude/ of wherever the app started
let deskDir = "";
function deskCwd() {
  if (!deskDir) { const d = join(homedir(), ".roca", "desk"); mkdirSync(d, { recursive: true, mode: 0o700 }); deskDir = d; }
  return deskDir;
}

export function spawnRun({ cmd = "claude", env, killGraceMs = DESK_KILL_GRACE_MS } = {}) {
  // headless run: our own hooks stay quiet (AGENTDESK_RECALL), OMC keyword triggers / hooks off
  const runEnv = env || { ...process.env, ...HOOK_QUIET };
  return (input, { signal } = {}) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, deskArgs(), { cwd: deskCwd(), env: runEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) { reject(e); return; }
    child.__deskGrace = killGraceMs;
    children.add(child);
    let out = "", done = false;
    const kill = () => killChild(child);
    if (signal) { if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true }); }
    child.stdout.setEncoding("utf8");   // a Korean character split across chunks stays whole
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => { if (out.length < OUT_MAX) out += d; });
    child.stderr.on("data", () => {});   // drained, never shown (it may quote the prompt)
    const finish = () => { children.delete(child); if (signal) signal.removeEventListener("abort", kill); };
    child.on("error", e => { finish(); if (!done) { done = true; reject(e); } });
    child.on("close", code => { finish(); if (!done) { done = true; resolve({ code, stdout: out }); } });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
