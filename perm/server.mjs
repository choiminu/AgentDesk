// Permission decisions from the widget: a long-poll HTTP endpoint on a Unix domain socket that the PermissionRequest
// command hook (~/.roca/perm-hook.sh) posts Claude Code's hook input to, and that answers only once a person pressed a
// button.
//   socket ~/.roca/perm/perm.sock (directory 0700, socket 0600) — no TCP port, so no other local process can stand in
//   for the widget on a port it left behind after a crash, and no other user can connect at all
//   POST /v1/permission   Host: localhost   X-AD-Perm-Token: <~/.roca/perm/perm-token>   body: the hook's stdin JSON
//     401 wrong / missing token · 403 unknown session, a browser (Origin) or another Host · 413 body too big
//     429 too many pending
//     200 {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny",...}}}
//     200 {}  — no decision (timed out, [터미널로], stale, app quitting): Claude Code keeps its own terminal prompt
//   POST /v1/guard        same auth; body: the PreToolUse hook's stdin JSON → 200 opts.onGuard(body) at once
//     ({} or a PreToolUse ask / deny — see guard/guard.mjs); no long-poll, no queue
//   every answer carries X-AD-Sig = hex HMAC-SHA256(token, body); the hook prints the body only when it verifies, so a
//   process that took over the socket path without the token cannot answer for the widget
// The hook prints nothing for any other status, so every failure falls back to the terminal.
// Windows (no Unix sockets there, no bash / curl / openssl by default): the server listens on a named pipe with a fresh
// random name per run (\\.\pipe\agentdesk-perm-<32 hex>, created first-instance by libuv, so a pipe someone else
// opened first makes listen fail instead of being shared), written next to the token in <dir>/perm-addr. The hook is a
// Node script (perm-hook.cjs / guard-hook.cjs, run by node or by this app in Node mode through a .cmd wrapper) that
// never sends the token itself: it sends X-AD-Nonce (32 hex) and X-AD-Perm-Auth = HMAC(token, nonce + "\n" +
// sha256(body)), and the answer is signed over nonce + "\n" + body — so whatever answers the pipe learns nothing it
// could reuse, and an old signed answer cannot be replayed. Same paths, limits, timeouts and outputs as the bash hook.
// No rule is ever stored and nothing is decided automatically: decide() is only called from a button press.
import { createServer } from "node:http";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import "../core/mask.js";   // globalThis.AgentDeskMask (used by core/perm.js)
import "../core/perm.js";   // globalThis.AgentDeskPerm
import "../core/guard.js";  // globalThis.AgentDeskGuard (outputAllowed)
const P = globalThis.AgentDeskPerm;
const G = globalThis.AgentDeskGuard;

// a guard body cut at 2 MB is not valid JSON: take the fields the guard needs from the text. A JSON string value cannot
// hold an unescaped quote, so `"command":"` only matches the real key; a value cut short is kept as far as it goes.
function jsonStringAt(text, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text); if (!m) return undefined;
  let i = m.index + m[0].length, j = i;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  let lit = text.slice(i, Math.min(j, text.length));
  for (let k = 0; k < 8; k++) { try { return JSON.parse(`"${lit}"`); } catch { lit = lit.slice(0, -1); } }
  return undefined;
}
export function guardFieldsFromPartial(text) {
  const t = String(text || "");
  const pick = k => { const v = jsonStringAt(t, k); return typeof v === "string" ? v : undefined; };
  const tool_input = {};
  for (const k of ["command", "file_path", "notebook_path"]) { const v = pick(k); if (v !== undefined) tool_input[k] = v; }
  const out = { tool_input };
  for (const k of ["session_id", "cwd", "tool_name", "permission_mode", "hook_event_name"]) { const v = pick(k); if (v !== undefined) out[k] = v; }
  return out;
}

export const PERM_PATH = "/v1/permission";
export const GUARD_PATH = "/v1/guard";
export const PERM_MAX_PENDING = 20;
export const PERM_MAX_BODY = 2 * 1024 * 1024;   // a Write of a large file sends its whole content
export const PERM_TIMEOUT_DEFAULT = 90;          // seconds
export const PERM_SOCK = "perm.sock";
export const PERM_TOKEN = "perm-token";
export const PERM_ADDR = "perm-addr";   // the address the hooks connect to (socket path, or the pipe name on Windows)
export const PIPE_RE = /^\\\\\.\\pipe\\agentdesk-perm-[0-9a-f]{32}$/;
// where the server listens: the 0600 socket inside the private dir, or on Windows a pipe nobody can guess
export function permAddress(dir, platform = process.platform, rand = () => randomBytes(16).toString("hex")) {
  return platform === "win32" ? `\\\\.\\pipe\\agentdesk-perm-${rand()}` : join(dir, PERM_SOCK);
}

// ~/.roca/perm-hook.sh, registered as a synchronous PermissionRequest command hook (timeout = timeoutSec + 10), and
// ~/.roca/guard-hook.sh (PreToolUse guardrail, timeout 3 s) — the same script around a different path and time limit.
// The token never appears on a command line (ps shows those to every user): curl reads the header from a file
// descriptor, and the response HMAC is computed by hand (key XOR ipad / opad, fed to openssl dgst on stdin) instead of
// `openssl dgst -hmac <key>`. No openssl, no %header support in curl, a bad signature → nothing printed.
function signedHookScript({ comment, path, maxTime, filter }) {
  return `#!/bin/bash
${comment}
umask 077
[ -n "$AGENTDESK_RECALL" ] && exit 0
d="$HOME/.roca/perm"
sock="$d/${PERM_SOCK}"
[ -S "$sock" ] && [ -r "$d/${PERM_TOKEN}" ] || exit 0
command -v openssl >/dev/null 2>&1 || exit 0
tok=$(tr -dc 'a-f0-9' < "$d/${PERM_TOKEN}")
[ \${#tok} -eq 64 ] || exit 0
${filter || ""}resp=$(${filter ? 'printf "%s" "$input" | ' : ""}curl -q -sf -m ${maxTime} --connect-timeout 1 --noproxy '*' --unix-socket "$sock" -X POST -H 'Content-Type: application/json' \\
  -H @<(printf 'X-AD-Perm-Token: %s\\n' "$tok") -w '\\n%header{x-ad-sig}' --data-binary @- http://localhost${path} 2>/dev/null) || exit 0
sig=\${resp##*$'\\n'}; body=\${resp%$'\\n'*}
[ "$body" != "$resp" ] && [ -n "$body" ] && [ \${#sig} -eq 64 ] || exit 0
ip=''; op=''
for ((i = 0; i < 64; i++)); do
  printf -v c '%d' "'\${tok:i:1}"
  printf -v x '\\\\x%02x' $((c ^ 0x36)); ip+=$x
  printf -v x '\\\\x%02x' $((c ^ 0x5c)); op+=$x
done
mac=$( { printf "$op"; { printf "$ip"; printf '%s' "$body"; } | openssl dgst -sha256 -binary; } | openssl dgst -sha256 -r 2>/dev/null )
mac=\${mac%% *}
[ \${#mac} -eq 64 ] && [ "$mac" = "$sig" ] || exit 0
printf '%s\\n' "$body"
exit 0
`;
}
export const permHookScript = (timeoutSec) => signedHookScript({ path: PERM_PATH, maxTime: timeoutSec + 5, comment:
`# AgentDesk permission hook: ask the AgentDesk widget to allow / deny this Claude Code permission request.
# Prints the widget's signed decision JSON; prints nothing (→ the normal terminal prompt) when the widget is not
# running, nobody answered within ${timeoutSec}s, the answer is not signed with our token, or anything fails.` });
// fail-open: no widget, no token, a slow or unsigned answer → nothing printed → the tool call goes on as usual
// only the fields the guard reads are sent when jq is there (a Write's content can be megabytes); without jq, or when
// jq fails, the whole input goes as before and the server reads at most 2 MB of it
const GUARD_FILTER = `input=$(cat)
if command -v jq >/dev/null 2>&1; then
  small=$(printf '%s' "$input" | jq -c '{session_id, cwd, permission_mode, hook_event_name, tool_name, tool_input: (.tool_input | if type == "object" then {command, file_path, notebook_path} else null end)}' 2>/dev/null) && [ -n "$small" ] && input=$small
fi
`;
export const guardHookScript = () => signedHookScript({ path: GUARD_PATH, maxTime: 2, filter: GUARD_FILTER, comment:
`# AgentDesk guardrail hook (PreToolUse): ask the AgentDesk widget whether this tool call matches a dangerous-command
# rule (~/.roca/guard.json). Prints the widget's signed answer (ask / deny); prints nothing — no effect, the tool call
# goes through Claude Code's normal permission flow — when the widget is not running, the answer is not signed with
# our token, takes over 2s, or anything fails.` });

// ── Windows hooks (Node): perm-hook.cjs / guard-hook.cjs ──
// kind "perm": the whole input, answer within timeoutSec + 5 s. kind "guard": only the fields the guard reads (when
// the input parses), 2 s. Prints the answer only when it is a 200 with a valid signature over this request's nonce
// and parses as a JSON object; anything else → nothing printed, exit 0 (the terminal prompt / the normal flow).
export function nodeHookScript({ kind, dir, timeoutSec }) {
  const isGuard = kind === "guard";
  const path = isGuard ? GUARD_PATH : PERM_PATH, maxMs = (isGuard ? 2 : Number(timeoutSec || PERM_TIMEOUT_DEFAULT) + 5) * 1000;
  return `// AgentDesk ${isGuard ? "guardrail hook (PreToolUse)" : "permission hook (PermissionRequest)"} for Windows — written by AgentDesk, rewritten on start.
// Asks the AgentDesk widget over its private pipe and prints the widget's signed answer; prints nothing when the widget
// is not running, the answer is late (${maxMs / 1000}s) or not signed for this request, or anything fails.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto");
const DIR = ${JSON.stringify(dir)};
const done = () => process.exit(0);
if (process.env.AGENTDESK_RECALL) done();
setTimeout(done, ${maxMs});
let tok = "", addr = "";
try { tok = fs.readFileSync(path.join(DIR, ${JSON.stringify(PERM_TOKEN)}), "utf8").replace(/[^a-f0-9]/g, ""); addr = fs.readFileSync(path.join(DIR, ${JSON.stringify(PERM_ADDR)}), "utf8").trim(); } catch { done(); }
if (tok.length !== 64 || !(${PIPE_RE.toString()}.test(addr) || addr === path.join(DIR, ${JSON.stringify(PERM_SOCK)}))) done();
const hmac = (s) => crypto.createHmac("sha256", tok).update(s).digest("hex");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("error", done);
process.stdin.on("end", () => {
  let body = Buffer.concat(chunks);
  if (!body.length) done();
${isGuard ? `  try {
    const j = JSON.parse(body.toString("utf8")), ti = j && j.tool_input && typeof j.tool_input === "object" ? j.tool_input : null;
    body = Buffer.from(JSON.stringify({ session_id: j.session_id, cwd: j.cwd, permission_mode: j.permission_mode, hook_event_name: j.hook_event_name, tool_name: j.tool_name,
      tool_input: ti ? { command: ti.command, file_path: ti.file_path, notebook_path: ti.notebook_path } : null }));
  } catch {}
` : ""}  const nonce = crypto.randomBytes(16).toString("hex");
  const auth = hmac(nonce + "\\n" + crypto.createHash("sha256").update(body).digest("hex"));
  const req = http.request({ socketPath: addr, path: ${JSON.stringify(path)}, method: "POST", headers: { Host: "localhost", "Content-Type": "application/json", "Content-Length": body.length, "X-AD-Nonce": nonce, "X-AD-Perm-Auth": auth } }, (res) => {
    const got = []; let size = 0;
    res.on("data", (c) => { size += c.length; if (size > 65536) done(); got.push(c); });
    res.on("error", done);
    res.on("end", () => {
      const text = Buffer.concat(got).toString("utf8"), sig = String(res.headers["x-ad-sig"] || "");
      if (res.statusCode !== 200 || sig.length !== 64) done();
      const want = Buffer.from(hmac(nonce + "\\n" + text)), have = Buffer.from(sig);
      if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) done();
      let o; try { o = JSON.parse(text); } catch { done(); }
      if (!o || typeof o !== "object" || Array.isArray(o)) done();
      process.stdout.write(text + "\\n", done);
    });
  });
  req.on("error", done);
  req.end(body);
});
`;
}
// a path that goes between double quotes on a Windows command line or in a .cmd file: no quote, no line break
function winPathOk(p) {
  const s = String(p || "");
  if (!s || /["\r\n\0]/.test(s)) throw new Error(`unusable path for a Windows hook: ${JSON.stringify(s)}`);
  return s;
}
// the .cmd launcher next to the Node script: starts it with node, or with this app's own binary in Node mode (the
// Windows package keeps the RunAsNode fuse for this). Inside a .cmd file % starts a variable, so it is doubled.
// Exit code is always 0 — a hook's exit code 2 would mean "block" to Claude Code.
export function winHookCmd({ runner, script }) {
  const q = (p) => winPathOk(p).replace(/%/g, "%%");
  return `@echo off\r\nrem AgentDesk hook launcher (written by AgentDesk, rewritten on start)\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${q(runner)}" "${q(script)}"\r\nexit /b 0\r\n`;
}
// the command registered in Claude Code's settings on Windows. It must run the same from cmd.exe and from Git Bash:
// with a system node.exe, node and the script with forward slashes ("C:/…/node.exe" "C:/…/perm-hook.cjs");
// otherwise cmd.exe runs the launcher (cmd /d /c "C:\…\perm-hook.cmd": /d skips AutoRun). A % in that path would be
// expanded by cmd.exe on the command line and cannot be escaped there, so it is refused.
export function winHookCommand({ systemNode, script, launcher }) {
  const fwd = (p) => winPathOk(p).replace(/\\/g, "/");
  if (systemNode) return `"${fwd(systemNode)}" "${fwd(script)}"`;
  const l = winPathOk(launcher);
  if (l.includes("%")) throw new Error(`unusable path for a Windows hook: ${JSON.stringify(l)}`);
  return `cmd /d /c "${l}"`;
}
// which binary runs the Node hook on Windows: a system node.exe when there is one; else the installed app binary
// (NSIS install path, stable across updates); the portable build runs from a temp copy that disappears → null
export function winHookRunner({ execPath, portable, systemNode }) {
  if (systemNode) return systemNode;
  if (portable || !execPath) return null;
  return execPath;
}

function tokenOk(want, got) {
  const a = Buffer.from(String(want || "")), b = Buffer.from(String(got || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export const signBody = (token, body) => createHmac("sha256", String(token)).update(body).digest("hex");
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
}
export function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, file); try { chmodSync(file, 0o600); } catch {}
}
const rm = f => { try { unlinkSync(f); } catch {} };

// opts: { token, timeoutSec, maxPending, isKnownSession(sid) → bool|Promise<bool>, onRequest(entry), onResolved(id, why),
//         onGuard(body) → PreToolUse hook output (object; {} = no effect) }
// entry (what the renderer gets): { id, seq, sessionId, cwd, createdAt, expiresAt, summary } — never the token
export function createPermServer(opts = {}) {
  const pending = new Map();   // id → { entry, res, timer, toolName, inputKey }
  let seq = 0;
  const lastHookAt = { perm: null, guard: null };   // when a hook last got through auth (ms) — the widget can tell a silent hook
  let timeoutSec = Number(opts.timeoutSec) || PERM_TIMEOUT_DEFAULT;
  const maxPending = opts.maxPending || PERM_MAX_PENDING;
  const isKnown = opts.isKnownSession || (() => false);
  const onRequest = opts.onRequest || (() => {});
  const onResolved = opts.onResolved || (() => {});
  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    const nonce = res.adNonce || "";   // a Node hook's request: the signature covers its nonce too
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-AD-Sig": signBody(opts.token || "", nonce ? `${nonce}\n${body}` : body) });
    res.end(body);
  };

  function finish(id, out, why) {
    const p = pending.get(id); if (!p) return false;
    pending.delete(id); clearTimeout(p.timer);
    try { if (!p.res.writableEnded) json(p.res, 200, out); } catch {}
    try { onResolved(id, why); } catch {}
    return true;
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || "").split("?")[0];
      if (req.method !== "POST" || (path !== PERM_PATH && path !== GUARD_PATH)) return json(res, 404, { error: "not found" });
      // only the local hook: a browser page always sends Origin, and curl --unix-socket http://localhost sends this Host
      if (req.headers.origin) return json(res, 403, { error: "forbidden" });
      if (String(req.headers.host || "") !== "localhost") return json(res, 403, { error: "forbidden" });
      // bash hook: the token itself; Node hook: a nonce and an HMAC over the body, checked once the body is read
      const macAuth = req.headers["x-ad-perm-auth"];
      if (macAuth !== undefined) {
        const nonce = String(req.headers["x-ad-nonce"] || "");
        if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(String(macAuth))) return json(res, 401, { error: "unauthorized" });
        res.adNonce = nonce;
      } else if (!tokenOk(opts.token, req.headers["x-ad-perm-token"])) return json(res, 401, { error: "unauthorized" });
      const bodyHash = macAuth !== undefined ? createHash("sha256") : null;
      // too big: answer and close the connection without reading the rest
      const tooLarge = () => { res.shouldKeepAlive = false; json(res, 413, { error: "too large" }); };
      const isGuard = path === GUARD_PATH;
      // the guardrail never refuses a big body (that would let a 2 MB Write through unchecked): the first 2 MB are read,
      // the rest is drained, and the fields it needs are taken from what was read
      // the Node hook (MAC auth) sends only the fields the guard reads, so it never needs the cut-and-drain path either
      const capped = !isGuard || bodyHash;
      if (capped && Number(req.headers["content-length"] || 0) > PERM_MAX_BODY) return tooLarge();
      const chunks = []; let size = 0, truncated = false;
      for await (const c of req) {
        if (bodyHash) bodyHash.update(c);
        if (truncated) continue;
        if (size + c.length > PERM_MAX_BODY) {
          if (capped) return tooLarge();
          chunks.push(c.subarray(0, PERM_MAX_BODY - size)); size = PERM_MAX_BODY; truncated = true; continue;
        }
        size += c.length; chunks.push(c);
      }
      if (bodyHash && !tokenOk(signBody(opts.token || "", `${res.adNonce}\n${bodyHash.digest("hex")}`), String(macAuth))) return json(res, 401, { error: "unauthorized" });
      lastHookAt[isGuard ? "guard" : "perm"] = Date.now();
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body;
      try { body = JSON.parse(raw); } catch { if (!truncated) return json(res, 400, { error: "bad json" }); body = guardFieldsFromPartial(raw); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad json" });
      // guardrail: answered at once. It can only add a question or a refusal, never an allow, so it does not need the
      // known-session check. Only {} or a PreToolUse ask / deny ever leaves here; a failure answers onGuardFail()
      if (isGuard) {
        if (body.hook_event_name && body.hook_event_name !== "PreToolUse") return json(res, 400, { error: "not a PreToolUse" });
        if (truncated) body.__truncated = true;
        // whether the answer reached the hook: "finish" = written out; "close" before that = curl had given up
        let settleFn = null, settled = false, finished = false, closed = false;
        const fire = ok => { if (settled || !settleFn) return; settled = true; try { settleFn(ok); } catch {} };
        res.on("finish", () => { finished = true; fire(true); });
        res.on("close", () => { closed = true; if (!res.writableFinished) fire(false); });
        const settle = fn => { settleFn = fn; if (finished) fire(true); else if (closed || res.destroyed || (res.socket && res.socket.destroyed)) fire(false); };
        let out = {};
        try { out = (opts.onGuard && await opts.onGuard(body, { settle })) || {}; }
        catch { try { out = (opts.onGuardFail && opts.onGuardFail()) || {}; } catch { out = {}; } }
        return json(res, 200, G.outputAllowed(out) ? out : {});
      }
      if (body.hook_event_name && body.hook_event_name !== "PermissionRequest") return json(res, 400, { error: "not a PermissionRequest" });
      const sid = typeof body.session_id === "string" ? body.session_id.slice(0, 200) : "";
      if (!sid || !(await isKnown(sid))) return json(res, 403, { error: "unknown session" });
      if (pending.size >= maxPending) return json(res, 429, { error: "too many pending" });
      const now = Date.now();
      const entry = {
        id: randomUUID(), seq: ++seq, sessionId: sid, cwd: typeof body.cwd === "string" ? P.revealInvisible(body.cwd.slice(0, 1000)) : "",
        createdAt: now, expiresAt: now + timeoutSec * 1000, summary: P.summarize(body),
      };
      const timer = setTimeout(() => finish(entry.id, P.timeoutOutput(), "timeout"), timeoutSec * 1000);
      let inputKey = ""; try { inputKey = JSON.stringify(body.tool_input ?? null); } catch {}
      pending.set(entry.id, { entry, res, timer, toolName: String(body.tool_name || ""), inputKey });
      // the hook went away first (Claude Code cancelled it, Ctrl+C)
      res.on("close", () => { if (pending.has(entry.id) && !res.writableFinished) { const p = pending.get(entry.id); pending.delete(entry.id); clearTimeout(p.timer); try { onResolved(entry.id, "cancelled"); } catch {} } });
      try { onRequest(entry); } catch {}
    } catch {
      try { if (!res.headersSent) json(res, 500, { error: "error" }); } catch {}
    }
  });
  server.requestTimeout = 15000;   // receiving the request; the long-poll answer itself is bounded by timeoutSec
  server.maxConnections = 80;   // guard calls from many sessions share the socket with up to 20 held approvals

  return {
    server,
    listen(socketPath) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.off("error", reject); resolve(socketPath); });
      });
    },
    // behavior: "allow" | "deny" | "pass" (no decision → terminal prompt). Only ids that are pending right now.
    decide(id, behavior, message) {
      if (!pending.has(id)) return false;
      if (behavior === "pass") return finish(id, P.timeoutOutput(), "pass");
      if (behavior !== "allow" && behavior !== "deny") return false;
      return finish(id, P.decisionOutput(behavior, message), behavior);
    },
    list() { return P.sortQueue([...pending.values()].map(p => p.entry)); },
    lastHookAt() { return { ...lastHookAt }; },
    // Claude Code keeps the hook running after the user answered in the terminal, so the logged hook events tell us
    // a request is stale: the same tool call ran / failed / was denied, or the turn ended. Answered with {} (no
    // decision) — this path can never produce allow or deny.
    staleFromEvent(ev) {
      if (!ev || typeof ev.session_id !== "string") return 0;
      const name = ev.hook_event_name;
      const turnOver = name === "Stop" || name === "StopFailure" || name === "UserPromptSubmit" || name === "SessionEnd";
      const toolDone = name === "PostToolUse" || name === "PostToolUseFailure" || name === "PermissionDenied";
      if (!turnOver && !toolDone) return 0;
      let key = ""; if (toolDone) { try { key = JSON.stringify(ev.tool_input ?? null); } catch {} }
      let n = 0;
      for (const [id, p] of [...pending]) {
        if (p.entry.sessionId !== ev.session_id) continue;
        if (turnOver || (p.toolName === String(ev.tool_name || "") && p.inputKey === key)) { finish(id, P.timeoutOutput(), "stale"); n++; }
      }
      return n;
    },
    setTimeoutSec(s) { const n = Number(s); if (n >= 10 && n <= 600) timeoutSec = n; },
    close() {
      for (const id of [...pending.keys()]) finish(id, P.timeoutOutput(), "closed");
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// The app's endpoint: <dir> (0700) holds the socket (0600; on Windows a named pipe instead, see above), a fresh random
// token (0600) for this run and the address file. Windows ignores these mode bits: there the files are kept from other
// users by the ACL of the user profile (%USERPROFILE%\.roca\perm) they live in. A socket, token or address left by a crashed run is removed first;
// when listening fails no token is left behind. close() removes the files before closing, so hooks stop connecting.
// Only one app instance may own <dir>: main.mjs takes the single-instance lock before it ever opens this.
export async function openPermEndpoint(opts = {}) {
  const dir = opts.dir, platform = opts.platform || process.platform;
  ensurePrivateDir(dir);
  const sock = permAddress(dir, platform), tokFile = join(dir, PERM_TOKEN), addrFile = join(dir, PERM_ADDR);
  const isPipe = platform === "win32";
  if (!isPipe) rm(sock);
  rm(tokFile); rm(addrFile);
  const token = randomBytes(32).toString("hex");
  const srv = createPermServer({ ...opts, token });
  const rmAll = () => { rm(tokFile); rm(addrFile); if (!isPipe) rm(sock); };
  try {
    await srv.listen(sock);
    if (!isPipe) { try { chmodSync(sock, 0o600); } catch {} }
    writePrivate(tokFile, token);
    writePrivate(addrFile, sock);
  } catch (e) {
    rmAll();
    try { await srv.close(); } catch {}
    throw e;
  }
  const closeServer = srv.close;
  srv.close = () => { rmAll(); return closeServer(); };
  srv.socketPath = sock;
  return srv;
}
