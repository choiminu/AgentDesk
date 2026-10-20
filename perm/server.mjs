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
//   every answer carries X-AD-Sig = hex HMAC-SHA256(token, body); the hook prints the body only when it verifies, so a
//   process that took over the socket path without the token cannot answer for the widget
// The hook prints nothing for any other status, so every failure falls back to the terminal.
// No rule is ever stored and nothing is decided automatically: decide() is only called from a button press.
import { createServer } from "node:http";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import "../core/mask.js";   // globalThis.AgentDeskMask (used by core/perm.js)
import "../core/perm.js";   // globalThis.AgentDeskPerm
const P = globalThis.AgentDeskPerm;

export const PERM_PATH = "/v1/permission";
export const PERM_MAX_PENDING = 20;
export const PERM_MAX_BODY = 2 * 1024 * 1024;   // a Write of a large file sends its whole content
export const PERM_TIMEOUT_DEFAULT = 90;          // seconds
export const PERM_SOCK = "perm.sock";
export const PERM_TOKEN = "perm-token";

// ~/.roca/perm-hook.sh, registered as a synchronous PermissionRequest command hook (timeout = timeoutSec + 10).
// The token never appears on a command line (ps shows those to every user): curl reads the header from a file
// descriptor, and the response HMAC is computed by hand (key XOR ipad / opad, fed to openssl dgst on stdin) instead of
// `openssl dgst -hmac <key>`. No openssl, no %header support in curl, a bad signature → nothing printed.
export const permHookScript = (timeoutSec) => `#!/bin/bash
# AgentDesk permission hook: ask the AgentDesk widget to allow / deny this Claude Code permission request.
# Prints the widget's signed decision JSON; prints nothing (→ the normal terminal prompt) when the widget is not
# running, nobody answered within ${timeoutSec}s, the answer is not signed with our token, or anything fails.
umask 077
[ -n "$AGENTDESK_RECALL" ] && exit 0
d="$HOME/.roca/perm"
sock="$d/${PERM_SOCK}"
[ -S "$sock" ] && [ -r "$d/${PERM_TOKEN}" ] || exit 0
command -v openssl >/dev/null 2>&1 || exit 0
tok=$(tr -dc 'a-f0-9' < "$d/${PERM_TOKEN}")
[ \${#tok} -eq 64 ] || exit 0
resp=$(curl -q -sf -m ${timeoutSec + 5} --connect-timeout 1 --unix-socket "$sock" -X POST -H 'Content-Type: application/json' \\
  -H @<(printf 'X-AD-Perm-Token: %s\\n' "$tok") -w '\\n%header{x-ad-sig}' --data-binary @- http://localhost${PERM_PATH} 2>/dev/null) || exit 0
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

// opts: { token, timeoutSec, maxPending, isKnownSession(sid) → bool|Promise<bool>, onRequest(entry), onResolved(id, why) }
// entry (what the renderer gets): { id, seq, sessionId, cwd, createdAt, expiresAt, summary } — never the token
export function createPermServer(opts = {}) {
  const pending = new Map();   // id → { entry, res, timer, toolName, inputKey }
  let seq = 0;
  let timeoutSec = Number(opts.timeoutSec) || PERM_TIMEOUT_DEFAULT;
  const maxPending = opts.maxPending || PERM_MAX_PENDING;
  const isKnown = opts.isKnownSession || (() => false);
  const onRequest = opts.onRequest || (() => {});
  const onResolved = opts.onResolved || (() => {});
  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-AD-Sig": signBody(opts.token || "", body) });
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
      if (req.method !== "POST" || (req.url || "").split("?")[0] !== PERM_PATH) return json(res, 404, { error: "not found" });
      // only the local hook: a browser page always sends Origin, and curl --unix-socket http://localhost sends this Host
      if (req.headers.origin) return json(res, 403, { error: "forbidden" });
      if (String(req.headers.host || "") !== "localhost") return json(res, 403, { error: "forbidden" });
      if (!tokenOk(opts.token, req.headers["x-ad-perm-token"])) return json(res, 401, { error: "unauthorized" });
      // too big: answer and close the connection without reading the rest
      const tooLarge = () => { res.shouldKeepAlive = false; json(res, 413, { error: "too large" }); };
      if (Number(req.headers["content-length"] || 0) > PERM_MAX_BODY) return tooLarge();
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > PERM_MAX_BODY) return tooLarge(); chunks.push(c); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return json(res, 400, { error: "bad json" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad json" });
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
  server.maxConnections = maxPending + 10;

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

// The app's endpoint: <dir> (0700) holds the socket (0600) and a fresh random token (0600) for this run.
// A socket or token left by a crashed run is removed first; when listening fails no token is left behind.
// close() removes both files before closing, so hooks stop connecting at once.
export async function openPermEndpoint(opts = {}) {
  const dir = opts.dir;
  ensurePrivateDir(dir);
  const sock = join(dir, PERM_SOCK), tokFile = join(dir, PERM_TOKEN);
  rm(sock); rm(tokFile);
  const token = randomBytes(32).toString("hex");
  const srv = createPermServer({ ...opts, token });
  try {
    await srv.listen(sock);
    try { chmodSync(sock, 0o600); } catch {}
    writePrivate(tokFile, token);
  } catch (e) {
    rm(tokFile); rm(sock);
    try { await srv.close(); } catch {}
    throw e;
  }
  const closeServer = srv.close;
  srv.close = () => { rm(tokFile); rm(sock); return closeServer(); };
  srv.socketPath = sock;
  return srv;
}
