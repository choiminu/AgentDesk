// Team sharing: every AgentDesk on the office network publishes a read-only snapshot of its sessions over HTTP,
// and polls the peers listed in ~/.agentdesk/team.json. No WebSocket, no inbound control — a peer can only look,
// and (phase 2) leave a short note that lands in the receiver's inbox; it is never typed into a session by itself.
//   GET  /v1/ping                       → { name, at, instanceId }
//   GET  /v1/sessions  (Bearer token)   → { name, at, instanceId, sessions: [...] }  (sanitized: no prompts, tool inputs or full paths)
//        ?since=<at> / If-None-Match     → 304 with no body when nothing changed
//   POST /v1/notes     (Bearer token)   ← { to, toName?, from, text ≤ 500 }  → 202; 429 past 10 notes a minute from one sender
//   POST /v1/hello     (Bearer token)   ← { name, port, instanceId }  → the caller (its IP + port) is added to / updated in my peers
// An empty token (fresh install, not in a team yet) keeps the server up for ping and discovery but refuses everything else.
import { createServer } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
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
export const NOTE_MAX = 500;
export const NOTE_RATE = 10;   // notes per minute per sender

export function readTeamConfig(file = TEAM_CFG) {
  if (!existsSync(file)) return null;
  let cfg; try { cfg = JSON.parse(readFileSync(file, "utf-8")); } catch (e) { return { error: `team.json: ${e.message}` }; }
  if (!cfg || typeof cfg !== "object") return { error: "team.json: not an object" };
  // token "" = auto-created on first run and not joined to a team yet (an invite code fills it in); the example value is a mistake
  if (!cfg.name || (cfg.token !== "" && !cfg.token) || cfg.token === TEAM_EXAMPLE.token) return { error: "team.json: name and a real token are required" };
  return {
    name: String(cfg.name), token: String(cfg.token),
    port: Number(cfg.port) || 7331, bind: cfg.bind || "0.0.0.0",
    peers: (Array.isArray(cfg.peers) ? cfg.peers : []).filter(p => p && p.name && p.host).map(p => ({ name: String(p.name), host: String(p.host), ...(p.instanceId ? { instanceId: String(p.instanceId) } : {}) })),
    ...(cfg.instanceId ? { instanceId: String(cfg.instanceId) } : {}),
    ...(cfg.discovery === false ? { discovery: false } : {}),
  };
}
export function writeTeamExample(file = TEAM_CFG) {
  if (existsSync(file)) return false;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(TEAM_EXAMPLE, null, 2) + "\n", { mode: 0o600 });
  return true;
}
// team.json edits keep every other field (the token included) exactly as the user wrote it
function editTeamJson(file, fn) {
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  const out = fn(raw);
  if (out === false) return false;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  return true;
}
// a stable id per PC, so a teammate who renames themselves is still recognised as the same machine
export function ensureInstanceId(file = TEAM_CFG) {
  let id = "";
  editTeamJson(file, raw => { if (raw.instanceId) { id = String(raw.instanceId); return false; } raw.instanceId = id = randomUUID(); });
  return id;
}
export const HOST_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const isPlaceholder = p => p && p.name === TEAM_EXAMPLE.peers[0].name && p.host === TEAM_EXAMPLE.peers[0].host;
// pure: add or update one peer. Same instanceId → the host follows (the teammate's IP changed); same host → only the
// instanceId is filled in; otherwise a new entry, renamed "name-2" when the name is taken. Returns { peers, change, name }.
export function upsertPeer(peers, peer) {
  const list = (Array.isArray(peers) ? peers : []).filter(p => p && !isPlaceholder(p)).map(p => ({ ...p }));
  const host = String(peer.host || "").trim(), id = peer.instanceId ? String(peer.instanceId) : "";
  const byId = id && list.find(p => p.instanceId === id);
  if (byId) { if (byId.host === host) return { peers: list, change: "none", name: byId.name }; byId.host = host; return { peers: list, change: "updated", name: byId.name }; }
  const byHost = list.find(p => p.host === host);
  if (byHost) { if (id && !byHost.instanceId) { byHost.instanceId = id; return { peers: list, change: "updated", name: byHost.name }; } return { peers: list, change: "none", name: byHost.name }; }
  const base = String(peer.name || "").trim().slice(0, 36) || host.split(":")[0];
  let name = base; const taken = new Set(list.map(p => p.name));
  for (let k = 2; taken.has(name); k++) name = `${base}-${k}`;
  list.push({ name, host, ...(id ? { instanceId: id } : {}) });
  return { peers: list, change: "added", name };
}
// add a discovered / invited / greeting peer to team.json. Returns { ok, added, updated?, name } or { ok: false, error }.
export function addPeerToConfig(file, peer) {
  const host = String(peer && peer.host || "").trim();
  if (!HOST_RE.test(host)) return { ok: false, error: "host must be IP:port" };
  let r = null;
  editTeamJson(file, raw => { r = upsertPeer(raw.peers, { ...peer, host }); const before = JSON.stringify(raw.peers || []); raw.peers = r.peers; if (JSON.stringify(raw.peers) === before) return false; });
  return { ok: true, added: r.change === "added", ...(r.change === "updated" ? { updated: true } : {}), name: r.name };
}
// team.json name / token edits (UI: rename, invite). The token never goes anywhere but this file.
export function setTeamFields(file, fields) { editTeamJson(file, raw => { Object.assign(raw, fields); }); }
export function newTeamToken() { return randomBytes(24).toString("base64url"); }

// invite code: "agentdesk-team:v1:" + base64url(JSON { token, inviter: { name, host, instanceId } }) — carries the token,
// so it only goes to the clipboard and should travel 1:1 (Slack DM), never to a channel
export const INVITE_PREFIX = "agentdesk-team:v1:";
export function encodeInvite({ token, inviter }) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify({ token, inviter: { name: inviter.name, host: inviter.host, instanceId: inviter.instanceId || "" } })).toString("base64url");
}
export function decodeInvite(code) {
  const s = String(code || "").trim();
  if (!s.startsWith(INVITE_PREFIX)) return { error: "not an AgentDesk invite code" };
  let d; try { d = JSON.parse(Buffer.from(s.slice(INVITE_PREFIX.length), "base64url").toString("utf-8")); } catch { return { error: "damaged invite code" }; }
  const inv = d && d.inviter;
  if (!d || typeof d.token !== "string" || d.token.length < 8 || d.token === TEAM_EXAMPLE.token) return { error: "invite code has no valid token" };
  if (!inv || typeof inv.name !== "string" || !inv.name.trim() || typeof inv.host !== "string" || !HOST_RE.test(inv.host)) return { error: "invite code has no valid inviter" };
  return { token: d.token, inviter: { name: inv.name.trim().slice(0, 40), host: inv.host, instanceId: typeof inv.instanceId === "string" ? inv.instanceId.slice(0, 64) : "" } };
}

// what leaves the machine: enough to see what a session is doing, nothing that may carry a secret or a private path
const PUBLIC_FIELDS = ["id", "name", "branch", "status", "needsInput", "agent", "time", "tool", "ctxPct", "askSince", "stuck", "stuckSince", "hookOnly", "ended", "isSub", "parentId"];
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
// repo-relative paths only: an absolute path or one that climbs out with ".." keeps just the file name
function publicFile(f) {
  const s = String(f || "").replace(/\\/g, "/").trim(); if (!s) return "";
  const parts = s.split("/").filter(p => p && p !== ".");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || parts.includes("..") || parts[0] === "~") return parts.pop() || "";
  return parts.join("/").slice(0, 200);
}
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
    // phase 2: files touched in the last 10 minutes (repo-relative), today's REPORT summary, the ticket the session works on
    if (Array.isArray(s.files) && s.files.length) { const f = [...new Set(s.files.map(publicFile).filter(Boolean))].slice(0, 20); if (f.length) o.files = f; }
    const rep = s.report || s.lastReport;
    if (rep && rep.text) o.report = { text: String(rep.text).slice(0, 200), at: Number(rep.at) || 0 };
    if (s.jira && JIRA_KEY.test(String(s.jira))) o.jira = String(s.jira);
    return o;
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    // over the limit: stop buffering, drain the rest and answer 413 (destroying the socket here would drop the reply)
    const onData = c => { size += c.length; if (size > limit) { req.off("data", onData); req.resume(); reject(Object.assign(new Error("too large"), { code: 413 })); } else chunks.push(c); };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
export function validateNote(body) {
  const n = body && typeof body === "object" ? body : {};
  const to = typeof n.to === "string" ? n.to.trim() : "", from = typeof n.from === "string" ? n.from.trim() : "", text = typeof n.text === "string" ? n.text.trim() : "";
  if (!to || to.length > 200) return { error: "to is required" };
  if (!from || from.length > 64) return { error: "from is required" };
  if (!text) return { error: "text is required" };
  if ([...text].length > NOTE_MAX) return { error: `text over ${NOTE_MAX} characters` };
  return { note: { to, from, text, ...(typeof n.toName === "string" && n.toName.trim() ? { toName: n.toName.trim().slice(0, 80) } : {}) } };
}

// opts.onNote(note) receives accepted notes; opts.now() is injectable for the rate-limit test
export function startTeamServer(cfg, getSnapshot, opts = {}) {
  const now = opts.now || Date.now;
  const noteTimes = new Map();   // from → timestamps within the last minute
  let cache = { snap: null, body: "", etag: "" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v1/ping") return req.method === "GET" ? json(200, { name: cfg.name, at: now(), instanceId: cfg.instanceId || "" }) : json(405, { error: "GET only" });
    if (url.pathname !== "/v1/sessions" && url.pathname !== "/v1/notes" && url.pathname !== "/v1/hello") return json(404, { error: "not found" });
    if (!cfg.token || (req.headers.authorization || "") !== `Bearer ${cfg.token}`) return json(401, { error: cfg.token ? "bad token" : "not in a team yet" });
    if (url.pathname === "/v1/hello") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return json(400, { error: "bad json" }); }
      const port = Number(b && b.port), addr = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      if (!b || typeof b.name !== "string" || !b.name.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9.]+$/.test(addr)) return json(400, { error: "name, port required" });
      const peer = { name: b.name.trim().slice(0, 40), host: `${addr}:${port}`, instanceId: typeof b.instanceId === "string" ? b.instanceId.slice(0, 64) : "" };
      let r = { ok: true }; try { r = (opts.onHello && opts.onHello(peer)) || r; } catch (e) { r = { ok: false, error: e.message }; }
      return json(r.ok === false ? 500 : 200, { ok: r.ok !== false, name: cfg.name, instanceId: cfg.instanceId || "" });
    }
    if (url.pathname === "/v1/notes") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let body; try { body = JSON.parse(await readBody(req, 4096)); } catch (e) { return json(e.code === 413 ? 413 : 400, { error: e.code === 413 ? "too large" : "bad json" }, e.code === 413 ? { Connection: "close" } : {}); }
      const v = validateNote(body); if (v.error) return json(400, { error: v.error });
      const t = now(); const recent = (noteTimes.get(v.note.from) || []).filter(x => t - x < 60000);
      if (recent.length >= NOTE_RATE) { noteTimes.set(v.note.from, recent); return json(429, { error: "too many notes" }); }
      recent.push(t); noteTimes.set(v.note.from, recent);
      const note = { id: randomUUID(), at: t, ...v.note };
      try { opts.onNote && opts.onNote(note); } catch {}
      return json(202, { ok: true, id: note.id });
    }
    if (req.method !== "GET") return json(405, { error: "GET only" });
    const snap = getSnapshot() || {};
    if (cache.snap !== snap) {
      const body = JSON.stringify(sanitizeSessions(snap.sessions));
      cache = { snap, body, etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"` };
    }
    const since = Number(url.searchParams.get("since")) || 0;
    if ((since && snap.at && since >= snap.at) || req.headers["if-none-match"] === cache.etag) { res.writeHead(304, { ETag: cache.etag, "Cache-Control": "no-store" }); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ETag: cache.etag });
    res.end(`{"name":${JSON.stringify(cfg.name)},"at":${Number(snap.at) || 0},"instanceId":${JSON.stringify(cfg.instanceId || "")},"sessions":${cache.body}}`);
  });
  server.on("error", () => {});   // reported through listen's callback / the caller's error handler
  return server;
}

const baseOf = peer => /^https?:\/\//.test(peer.host) ? peer.host : `http://${peer.host}`;
const errText = e => e.name === "TimeoutError" ? "timeout" : (e.cause && e.cause.code) || e.message;
// opts: number (timeout, phase 1) or { timeoutMs, etag, since }. A 304 comes back as { ok: true, notModified: true }.
export async function fetchPeer(peer, token, opts = {}) {
  const o = typeof opts === "number" ? { timeoutMs: opts } : (opts || {});
  const headers = { Authorization: `Bearer ${token}` };
  if (o.etag) headers["If-None-Match"] = o.etag;
  const t0 = Date.now();
  try {
    const r = await fetch(`${baseOf(peer)}/v1/sessions${o.since ? `?since=${Number(o.since)}` : ""}`, { headers, signal: AbortSignal.timeout(o.timeoutMs || 2500) });
    const rtt = Date.now() - t0;
    if (r.status === 304) return { name: peer.name, ok: true, notModified: true, at: Date.now(), rtt, etag: r.headers.get("etag") || o.etag || "" };
    if (!r.ok) return { name: peer.name, ok: false, rtt, error: r.status === 401 ? "token mismatch" : `HTTP ${r.status}` };
    const d = await r.json();
    return { name: peer.name, ok: true, at: Date.now(), rtt, etag: r.headers.get("etag") || "", theirAt: d.at || 0, remoteName: d.name, instanceId: d.instanceId || "", sessions: sanitizeSessions(d.sessions) };
  } catch (e) {
    return { name: peer.name, ok: false, error: errText(e) };
  }
}

export async function postNote(peer, token, note, timeoutMs = 4000) {
  try {
    const r = await fetch(`${baseOf(peer)}/v1/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(note), signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, error: r.status === 401 ? "token mismatch" : r.status === 429 ? "too many notes" : d.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function postHello(peer, token, me, timeoutMs = 4000) {
  try {
    const r = await fetch(`${baseOf(peer)}/v1/hello`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: me.name, port: me.port, instanceId: me.instanceId || "" }), signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, name: d.name, instanceId: d.instanceId } : { ok: false, status: r.status, error: r.status === 401 ? "token mismatch" : d.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
export async function pingPeer(peer, timeoutMs = 2500) {
  try { const r = await fetch(`${baseOf(peer)}/v1/ping`, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? { ok: true, ...(await r.json()) } : { ok: false, error: `HTTP ${r.status}` }; }
  catch (e) { return { ok: false, error: errText(e) }; }
}
