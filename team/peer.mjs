// Team sharing (phase 1): every AgentDesk on the office network publishes a read-only snapshot of its sessions over HTTP,
// and polls the peers listed in ~/.agentdesk/team.json. No WebSocket, no inbound control — a peer can only look.
//   GET /v1/ping                      → { name, at }
//   GET /v1/sessions  (Bearer token)  → { name, at, sessions: [...] }   (sanitized: no prompts, tool inputs or full paths)
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export const TEAM_CFG = join(homedir(), ".agentdesk", "team.json");
export const TEAM_EXAMPLE = {
  name: "me",
  token: "change-me-shared-secret",
  port: 7331,
  bind: "0.0.0.0",
  peers: [{ name: "teammate", host: "192.168.0.10:7331" }],
};

export function readTeamConfig(file = TEAM_CFG) {
  if (!existsSync(file)) return null;
  let cfg; try { cfg = JSON.parse(readFileSync(file, "utf-8")); } catch (e) { return { error: `team.json: ${e.message}` }; }
  if (!cfg || typeof cfg !== "object") return { error: "team.json: not an object" };
  if (!cfg.name || !cfg.token || cfg.token === TEAM_EXAMPLE.token) return { error: "team.json: name and a real token are required" };
  return {
    name: String(cfg.name), token: String(cfg.token),
    port: Number(cfg.port) || 7331, bind: cfg.bind || "0.0.0.0",
    peers: (Array.isArray(cfg.peers) ? cfg.peers : []).filter(p => p && p.name && p.host).map(p => ({ name: String(p.name), host: String(p.host) })),
  };
}
export function writeTeamExample(file = TEAM_CFG) {
  if (existsSync(file)) return false;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(TEAM_EXAMPLE, null, 2) + "\n", { mode: 0o600 });
  return true;
}

// what leaves the machine: enough to see what a session is doing, nothing that may carry a secret or a private path
const PUBLIC_FIELDS = ["id", "name", "branch", "status", "needsInput", "agent", "time", "tool", "ctxPct", "askSince", "stuck", "stuckSince", "hookOnly", "ended", "isSub", "parentId"];
export function sanitizeSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).map(s => {
    const o = {};
    for (const k of PUBLIC_FIELDS) if (s[k] !== undefined) o[k] = s[k];
    // worktree ids carry the checkout path ("<uuid>::/Users/…"): keep only the id part, never a path
    if (o.id != null) { o.id = String(o.id).split("::")[0]; if (o.id.includes("/")) o.id = basename(o.id); }
    if (o.parentId != null) o.parentId = String(o.parentId).split("::")[0];
    o.repo = s.repo ? basename(String(s.repo)) : "";
    o.cwd = s.cwd ? basename(String(s.cwd)) : "";
    if (s.now) o.now = String(s.now).slice(0, 200);
    if (s.loop) o.loop = { reason: s.loop.reason, tool: s.loop.tool };
    o.subagents = (s.subagents || []).filter(a => a.state === "running").length;
    return o;
  });
}

export function startTeamServer(cfg, getSnapshot) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method !== "GET") return json(405, { error: "GET only" });
    if (url.pathname === "/v1/ping") return json(200, { name: cfg.name, at: Date.now() });
    if (url.pathname !== "/v1/sessions") return json(404, { error: "not found" });
    if ((req.headers.authorization || "") !== `Bearer ${cfg.token}`) return json(401, { error: "bad token" });
    const snap = getSnapshot() || {};
    return json(200, { name: cfg.name, at: snap.at || 0, sessions: sanitizeSessions(snap.sessions) });
  });
  server.on("error", () => {});   // reported through listen's callback / the caller's error handler
  return server;
}

export async function fetchPeer(peer, token, timeoutMs = 2500) {
  const base = /^https?:\/\//.test(peer.host) ? peer.host : `http://${peer.host}`;
  try {
    const r = await fetch(`${base}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { name: peer.name, ok: false, error: r.status === 401 ? "token mismatch" : `HTTP ${r.status}` };
    const d = await r.json();
    return { name: peer.name, ok: true, at: Date.now(), theirAt: d.at || 0, remoteName: d.name, sessions: sanitizeSessions(d.sessions) };
  } catch (e) {
    return { name: peer.name, ok: false, error: e.name === "TimeoutError" ? "timeout" : (e.cause && e.cause.code) || e.message };
  }
}
