// Team sharing: every AgentDesk on the office network publishes a read-only snapshot of its sessions over HTTP,
// and polls the peers listed in ~/.agentdesk/team.json. No WebSocket, no inbound control — a peer can only look,
// and (phase 2) leave a short note that lands in the receiver's inbox; it is never typed into a session by itself.
//   GET  /v1/ping                       → { at }   (open; signed → { at, instanceId })
//   GET  /v1/sessions  (signed)         → { name, at, instanceId, sessions: [...] }  (sanitized: no prompts, tool inputs or full paths)
//        ?since=<at> / If-None-Match     → 304 with no body when nothing changed
//   POST /v1/notes     (signed)         ← { to, toName?, text ≤ 500, port? }  → 202; "from" is the registered peer at the
//                                          caller's IP (403 when there is none); 429 past 10 notes a minute from one IP
//   POST /v1/hello     (signed)         ← { name, port, instanceId }  → the caller (its IP + port) is handed to onHello,
//                                          which queues it for the user's confirmation
// Signing (no token ever crosses the wire): request headers X-AD-Ts (ms), X-AD-Nonce (16 random bytes, hex) and
//   X-AD-Sig = HMAC-SHA256(token, METHOD \n host \n path \n ts \n nonce \n sha256(body))   (host = the peer's "ip:port",
//   also sent as the Host header; the server only accepts its own address and port, so a request cannot be relayed)
// The server accepts ts within ±120 s and each nonce once (250 s memory, 600 per caller IP), and signs every answer with
//   X-AD-Sig = HMAC-SHA256(token, status \n host \n ts \n nonce \n sha256(responseBody))   (request's ts / nonce; 304 → sha256(""))
// so a client also knows the reply came from a holder of the same token. An empty token (not in a team yet) keeps the
// server up for ping only and refuses everything else.
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, basename, dirname } from "node:path";
import "../core/mask.js";   // globalThis.AgentDeskMask
import "../core/team.js";   // globalThis.AgentDeskTeam (clean, publicSessionId)
const { mask } = globalThis.AgentDeskMask;
const { clean, publicSessionId } = globalThis.AgentDeskTeam;

export const TEAM_CFG = join(homedir(), ".agentdesk", "team.json");
export const TEAM_EXAMPLE = {
  name: "me",
  token: "change-me-shared-secret",
  port: 7331,
  bind: "0.0.0.0",
  peers: [{ name: "teammate", host: "192.168.0.10:7331" }],
};
export const NOTE_MAX = 500;
export const NOTE_RATE = 10;            // notes per minute per caller IP
export const SIG_SKEW_MS = 120000;      // accepted clock difference for X-AD-Ts
export const NONCE_TTL_MS = 2 * SIG_SKEW_MS + 10000;   // 250 s: past the whole ±120 s window, a replay fails on ts anyway
export const NONCE_MAX = 50000;
export const NONCE_PER_IP = 600;        // live nonces per caller IP (≈ 2.4 requests / s sustained)
export const RESPONSE_MAX = 512 * 1024; // a teammate's reply larger than this is dropped
export const SESSIONS_MAX = 200;
const NOTE_KEYS_MAX = 1000;

const isLoopback = h => /^(127\.|localhost$|::1$|\[::1\]$)/.test(String(h || ""));
// "shared" = in a team and listening beyond this PC; off (first run, or "stop sharing") = 127.0.0.1 and no beacon
export function isShared(cfg) { return !!(cfg && cfg.token && !isLoopback(cfg.bind)); }

export function readTeamConfig(file = TEAM_CFG) {
  if (!existsSync(file)) return null;
  let cfg; try { cfg = JSON.parse(readFileSync(file, "utf-8")); } catch (e) { return { error: `team.json: ${e.message}` }; }
  if (!cfg || typeof cfg !== "object") return { error: "team.json: not an object" };
  // token "" = auto-created on first run and not joined to a team yet (an invite code fills it in); the example value is a mistake
  if (!cfg.name || (cfg.token !== "" && !cfg.token) || cfg.token === TEAM_EXAMPLE.token) return { error: "team.json: name and a real token are required" };
  const token = String(cfg.token), port = Number(cfg.port);
  return {
    name: String(cfg.name), token,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7331,
    // not in a team → never listen beyond this PC, whatever the file says; in a team, an explicit bind wins
    bind: token ? String(cfg.bind || "0.0.0.0") : "127.0.0.1",
    peers: (Array.isArray(cfg.peers) ? cfg.peers : []).filter(p => p && p.name && p.host).map(p => ({ name: String(p.name), host: String(p.host), ...(p.instanceId ? { instanceId: String(p.instanceId) } : {}) })),
    ...(cfg.instanceId ? { instanceId: String(cfg.instanceId) } : {}),
    // the office network(s) ("a.b.c" = a /24) remembered when the team was created / joined
    ...(Array.isArray(cfg.homeSubnets) ? { homeSubnets: cfg.homeSubnets.map(String).filter(x => PREFIX_RE.test(x)).slice(0, 16) } : {}),
    ...(token && cfg.discovery !== false ? {} : { discovery: false }),
  };
}
// team.json (and its folder) stay private to this user; writes go through a temp file + rename so a crash never
// leaves half a file (and with it a lost token)
export function writeTeamJson(file, obj) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}
export function writeTeamExample(file = TEAM_CFG) {
  if (existsSync(file)) return false;
  writeTeamJson(file, TEAM_EXAMPLE);
  return true;
}
// team.json edits keep every other field (the token included) exactly as the user wrote it
function editTeamJson(file, fn) {
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  const out = fn(raw);
  if (out === false) return false;
  writeTeamJson(file, raw);
  return true;
}
// a stable id per PC, so a teammate who renames themselves is still recognised as the same machine
export function ensureInstanceId(file = TEAM_CFG) {
  let id = "";
  editTeamJson(file, raw => { if (raw.instanceId) { id = String(raw.instanceId); return false; } raw.instanceId = id = randomUUID(); });
  return id;
}
export const HOST_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// display names a teammate can give themselves: letters, digits, _ . - space and Hangul
export const NAME_RE = /^[\w.\-가-힣 ]{1,40}$/;
export const cleanName = s => clean(s, 40).replace(/[^\w.\-가-힣 ]/g, "").trim();
const isPlaceholder = p => p && p.name === TEAM_EXAMPLE.peers[0].name && p.host === TEAM_EXAMPLE.peers[0].host;
// pure: add or update one peer. Same instanceId → the host follows (the teammate's IP changed); same host → only the
// instanceId is filled in; otherwise a new entry, renamed "name-2" when the name is taken. Returns { peers, change, name }
// (change: "added" | "moved" (an existing peer's host changes) | "updated" (instance id filled in) | "none").
export function upsertPeer(peers, peer) {
  const list = (Array.isArray(peers) ? peers : []).filter(p => p && !isPlaceholder(p)).map(p => ({ ...p }));
  const host = String(peer.host || "").trim(), id = peer.instanceId ? String(peer.instanceId) : "";
  const byId = id && list.find(p => p.instanceId === id);
  if (byId) { if (byId.host === host) return { peers: list, change: "none", name: byId.name }; const from = byId.host; byId.host = host; return { peers: list, change: "moved", name: byId.name, from }; }
  const byHost = list.find(p => p.host === host);
  if (byHost) { if (id && !byHost.instanceId) { byHost.instanceId = id; return { peers: list, change: "updated", name: byHost.name }; } return { peers: list, change: "none", name: byHost.name }; }
  const base = String(peer.name || "").trim().slice(0, 36) || host.split(":")[0];
  let name = base; const taken = new Set(list.map(p => p.name));
  for (let k = 2; taken.has(name); k++) name = `${base}-${k}`;
  list.push({ name, host, ...(id ? { instanceId: id } : {}) });
  return { peers: list, change: "added", name };
}
// add a discovered / invited / confirmed peer to team.json. Returns { ok, added, updated?, name } or { ok: false, error }.
export function addPeerToConfig(file, peer) {
  const host = String(peer && peer.host || "").trim();
  if (!HOST_RE.test(host)) return { ok: false, error: "host must be IP:port" };
  let r = null;
  editTeamJson(file, raw => { r = upsertPeer(raw.peers, { ...peer, host }); const before = JSON.stringify(raw.peers || []); raw.peers = r.peers; if (JSON.stringify(raw.peers) === before) return false; });
  return { ok: true, added: r.change === "added", ...(r.change === "updated" || r.change === "moved" ? { updated: true } : {}), name: r.name };
}
// remove a teammate from my list (their token still works until the team token is reissued)
export function removePeerFromConfig(file, name) {
  let removed = false;
  editTeamJson(file, raw => { const before = (raw.peers || []).length; raw.peers = (raw.peers || []).filter(p => !(p && p.name === name)); removed = raw.peers.length !== before; if (!removed) return false; });
  return { ok: removed, ...(removed ? {} : { error: "unknown peer" }) };
}
// team.json name / token edits (UI: rename, invite). The token never goes anywhere but this file.
export function setTeamFields(file, fields) { editTeamJson(file, raw => { Object.assign(raw, fields); }); }
export function newTeamToken() { return randomBytes(24).toString("base64url"); }
// new token: every teammate's signature stops matching until they join again with a new invite code
export function rotateTeamToken(file = TEAM_CFG) { setTeamFields(file, { token: newTeamToken() }); return true; }

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
  if (!inv || typeof inv.name !== "string" || !cleanName(inv.name) || typeof inv.host !== "string" || !HOST_RE.test(inv.host)) return { error: "invite code has no valid inviter" };
  return { token: d.token, inviter: { name: cleanName(inv.name), host: inv.host, instanceId: typeof inv.instanceId === "string" && UUID_RE.test(inv.instanceId) ? inv.instanceId : "" } };
}

// ── subnet check: teammates are polled / greeted only on my own office network (/24 of any of my IPv4 interfaces) ──
export function myPrefixes(ifaces = networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(ifaces || {})) for (const i of list || []) {
    if ((i.family !== "IPv4" && i.family !== 4) || i.internal || !i.address) continue;
    out.add(i.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}
const PREFIX_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// am I on the office network? true when any of my interfaces is in one of the remembered /24s. No list (a team.json
// from before homeSubnets) → true, so existing installs keep working until "add this network" is pressed.
export function onHomeNetwork(homeSubnets, ifaces = networkInterfaces()) {
  if (!Array.isArray(homeSubnets) || !homeSubnets.length) return true;
  const mine = myPrefixes(ifaces);
  return homeSubnets.some(p => mine.includes(p));
}
// "add this network as an office network": the current /24s merged into the list (capped at 16)
export function withHomeSubnets(homeSubnets, ifaces = networkInterfaces()) {
  return [...new Set([...(Array.isArray(homeSubnets) ? homeSubnets : []), ...myPrefixes(ifaces)])].filter(x => PREFIX_RE.test(x)).slice(-16);
}
export function sameSubnet(host, ifaces = networkInterfaces()) {
  const ip = String(host || "").replace(/^https?:\/\//, "").split(":")[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  if (ip.startsWith("127.")) return true;   // this PC
  return myPrefixes(ifaces).includes(ip.split(".").slice(0, 3).join("."));
}

// ── what leaves the machine (and what is accepted from a teammate): enough to see what a session is doing, nothing
//    that may carry a secret or a private path. The same function runs on both sides, so a modified teammate cannot
//    push markup, oversized text or odd types into my UI either. ──
const STATUSES = new Set(["running", "waiting", "done", "error"]);
const AGENTS = new Set(["claude", "gemini", "codex", ""]);
const BOOL_FIELDS = ["needsInput", "stuck", "ended", "isSub", "hookOnly"];
const TIME_FIELDS = ["time", "askSince", "stuckSince"];
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
// cut first (4× the kept length is enough for a masked token to still be recognised), then mask, then bound
const text = (v, max) => clean(mask(String(v ?? "").slice(0, max * 4)), max);
// repo-relative paths only: an absolute path or one that climbs out with ".." keeps just the file name
function publicFile(f) {
  const s = String(f || "").replace(/\\/g, "/").trim(); if (!s) return "";
  const parts = s.split("/").filter(p => p && p !== ".");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || parts.includes("..") || parts[0] === "~") return parts.pop() || "";
  return parts.join("/");
}
export function sanitizeSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter(s => s && typeof s === "object").slice(0, SESSIONS_MAX).map(s => {
    const o = {};
    // worktree ids carry the checkout path ("<uuid>::/Users/…"): keep only the id part, never a path
    if (s.id != null) o.id = publicSessionId(s.id);
    if (s.name !== undefined) o.name = text(s.name, 120);
    if (s.branch !== undefined) o.branch = text(s.branch, 120);
    o.status = STATUSES.has(s.status) ? s.status : "done";
    if (s.agent !== undefined) o.agent = AGENTS.has(s.agent) ? s.agent : "";
    for (const k of BOOL_FIELDS) if (s[k] !== undefined) o[k] = s[k] === true;
    for (const k of TIME_FIELDS) if (s[k] !== undefined) { const n = Number(s[k]); if (Number.isFinite(n) && n >= 0) o[k] = n; }
    if (s.tool !== undefined) o.tool = text(s.tool, 40);
    if (s.ctxPct !== undefined && s.ctxPct !== null) { const n = Number(s.ctxPct); if (Number.isFinite(n)) o.ctxPct = Math.min(100, Math.max(0, Math.round(n))); }
    if (s.parentId != null) o.parentId = publicSessionId(s.parentId);
    o.repo = s.repo ? clean(basename(String(s.repo)), 120) : "";
    o.cwd = s.cwd ? clean(basename(String(s.cwd)), 120) : "";
    if (s.now) o.now = text(s.now, 200);
    if (s.loop && typeof s.loop === "object") o.loop = { reason: s.loop.reason === "fail" ? "fail" : "repeat", tool: text(s.loop.tool, 40) };
    // a local snapshot carries the subagent list, a teammate's already the running count
    const subs = s.subagents;
    o.subagents = Array.isArray(subs) ? subs.filter(a => a && a.state === "running").length : Number.isInteger(subs) && subs > 0 ? Math.min(subs, 1000) : 0;
    // phase 2: files touched in the last 10 minutes (repo-relative), today's REPORT summary, the ticket the session works on
    if (Array.isArray(s.files) && s.files.length) { const f = [...new Set(s.files.slice(0, 200).map(x => text(publicFile(String(x ?? "").slice(0, 800)), 200)).filter(Boolean))].slice(0, 20); if (f.length) o.files = f; }
    const rep = s.report || s.lastReport;
    if (rep && typeof rep === "object" && rep.text) { const at = Number(rep.at); o.report = { text: text(rep.text, 200), at: Number.isFinite(at) && at > 0 ? at : 0 }; }
    if (typeof s.jira === "string" && s.jira.length <= 32 && JIRA_KEY.test(s.jira)) o.jira = s.jira;
    return o;
  });
}

// ── request / response signing ──
// Both directions are bound to the receiving PC's address ("ip:port", the Host header): a request signed for one
// teammate cannot be relayed to another, and a reply carries its status code, so a 401 / 304 / 403 cannot be forged
// out of another reply either.
const sha256hex = s => createHash("sha256").update(s == null ? "" : String(s)).digest("hex");
export function requestSignature(token, method, host, path, ts, nonce, body) {
  return createHmac("sha256", String(token)).update(`${String(method).toUpperCase()}\n${host}\n${path}\n${ts}\n${nonce}\n${sha256hex(body)}`).digest("hex");
}
export function responseSignature(token, status, host, ts, nonce, body) {
  return createHmac("sha256", String(token)).update(`${Number(status)}\n${host}\n${ts}\n${nonce}\n${sha256hex(body)}`).digest("hex");
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export function signRequest(token, method, host, path, body = "", now = Date.now()) {
  const ts = String(now), nonce = randomBytes(16).toString("hex");
  return { ts, nonce, headers: { "X-AD-Ts": ts, "X-AD-Nonce": nonce, "X-AD-Sig": requestSignature(token, method, host, path, ts, nonce, body) } };
}
// replay guard: each nonce once within NONCE_TTL_MS (longer than the ±120 s window, so an expired nonce can never be
// replayed with a valid ts). Per caller IP at most NONCE_PER_IP live nonces ("busy-ip" → 429 for that IP only); the
// whole table is capped at NONCE_MAX ("busy").
export function createNonceGuard({ ttlMs = NONCE_TTL_MS, max = NONCE_MAX, perIp = NONCE_PER_IP } = {}) {
  const seen = new Map();    // nonce → { at, ip } (insertion order = time order)
  const byIp = new Map();    // ip → live nonce count
  return {
    check(nonce, t, ip = "") {
      for (const [n, e] of seen) {
        if (t - e.at <= ttlMs) break;
        seen.delete(n); const c = (byIp.get(e.ip) || 1) - 1; if (c > 0) byIp.set(e.ip, c); else byIp.delete(e.ip);
      }
      if (seen.has(nonce)) return "replayed";
      if ((byIp.get(ip) || 0) >= perIp) return "busy-ip";
      if (seen.size >= max) return "busy";
      seen.set(nonce, { at: t, ip }); byIp.set(ip, (byIp.get(ip) || 0) + 1);
      return "ok";
    },
    get size() { return seen.size; },
  };
}
// headers: lower-cased (node's req.headers); host: the Host header value (already checked to be mine).
// Returns { ok, ts, nonce } or { ok: false, error }.
export function verifyRequest(token, { method, host, path, headers, body, ip }, guard, t = Date.now()) {
  if (!token) return { ok: false, error: "not in a team yet" };
  const h = headers || {};
  const ts = String(h["x-ad-ts"] || ""), nonce = String(h["x-ad-nonce"] || ""), sig = String(h["x-ad-sig"] || "");
  if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: "unsigned request" };
  if (Math.abs(t - Number(ts)) > SIG_SKEW_MS) return { ok: false, error: "clock skew" };
  if (!safeEqual(sig, requestSignature(token, method, host, path, ts, nonce, body || ""))) return { ok: false, error: "bad signature" };
  const g = guard.check(nonce, t, ip || "");
  if (g !== "ok") return { ok: false, error: g };
  return { ok: true, ts, nonce };
}
// Host header must name this PC: one of my interface addresses and the port the request arrived on
export function isMyHost(host, localPort, ifaces = networkInterfaces()) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(host || ""));
  if (!m || Number(m[2]) !== Number(localPort)) return false;
  for (const list of Object.values(ifaces || {})) for (const i of list || []) if ((i.family === "IPv4" || i.family === 4) && i.address === m[1]) return true;
  return false;
}
// sliding one-minute window per key (caller IP); the map is pruned of keys idle for 10 minutes and capped
export function noteRateCheck(times, key, t, limit = NOTE_RATE) {
  for (const [k, list] of times) if (!list.length || t - list[list.length - 1] > 600000) times.delete(k);
  while (times.size >= NOTE_KEYS_MAX && !times.has(key)) times.delete(times.keys().next().value);
  const recent = (times.get(key) || []).filter(x => t - x < 60000);
  if (recent.length >= limit) { times.set(key, recent); return false; }
  recent.push(t); times.set(key, recent);
  return true;
}
// Host header: an IP literal, localhost or nothing — a DNS name means a browser was pointed here (DNS rebinding)
const HOST_HEADER_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]|localhost)(?::\d{1,5})?$/i;
export const validHostHeader = h => h == null || h === "" || HOST_HEADER_RE.test(String(h));
const remoteIp = req => String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
const hostIp = h => String(h || "").split(":")[0];

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
// note fields: "from" is filled in by the receiving server (the registered peer at the caller's IP), never trusted
export function validateNote(body) {
  const n = body && typeof body === "object" ? body : {};
  const strip = s => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  const to = typeof n.to === "string" ? clean(n.to) : "", from = typeof n.from === "string" ? clean(n.from) : "", text = typeof n.text === "string" ? strip(n.text) : "";
  if (!to || to.length > 200) return { error: "to is required" };
  if (!from || from.length > 64) return { error: "from is required" };
  if (!text) return { error: "text is required" };
  if ([...text].length > NOTE_MAX) return { error: `text over ${NOTE_MAX} characters` };
  return { note: { to, from, text, ...(typeof n.toName === "string" && clean(n.toName) ? { toName: clean(n.toName, 80) } : {}) } };
}

// cfg is read on every request (a live view in the app): { name, token, instanceId, peers }.
// opts.onNote(note) receives accepted notes; opts.onHello(peer) a signed greeting (returns { ok, pending? });
// opts.now() is injectable for the rate-limit test (signatures always use the real clock); opts.ifaces for isMyHost
export function startTeamServer(cfg, getSnapshot, opts = {}) {
  const now = opts.now || Date.now;
  const guard = opts.nonceGuard || createNonceGuard();
  const noteTimes = new Map();   // caller IP → timestamps within the last minute
  let cache = { snap: null, body: "", etag: "" };
  const server = createServer(async (req, res) => {
    // set as soon as the request carries well-formed signing headers and I have a token: from then on every answer
    // (401 / 304 / 4xx included) is signed over its status, my address and the request's ts / nonce
    let sig = null;
    const send = (code, body, headers = {}) => {
      const h = { "Cache-Control": "no-store", ...headers };
      if (sig) h["X-AD-Sig"] = responseSignature(cfg.token, code, sig.host, sig.ts, sig.nonce, body);
      res.writeHead(code, h); res.end(body);
    };
    const json = (code, body, headers = {}) => send(code, JSON.stringify(body), { "Content-Type": "application/json", ...headers });
    const host = String(req.headers.host || "");
    if (!validHostHeader(req.headers.host)) { req.resume(); return json(400, { error: "bad host" }); }
    let url; try { url = new URL(req.url, "http://x"); } catch { req.resume(); return json(400, { error: "bad url" }); }
    const known = ["/v1/ping", "/v1/sessions", "/v1/notes", "/v1/hello"].includes(url.pathname);
    if (!known) { req.resume(); return json(404, { error: "not found" }); }
    const ts = String(req.headers["x-ad-ts"] || ""), nonce = String(req.headers["x-ad-nonce"] || "");
    const signedReq = !!req.headers["x-ad-sig"];
    if (cfg.token && signedReq && /^\d{1,16}$/.test(ts) && /^[0-9a-f]{32}$/.test(nonce)) sig = { host, ts, nonce };
    // open ping: only "I am up" (no name, no id — the beacon does discovery). A signed ping also gets my instance id.
    if (url.pathname === "/v1/ping" && !signedReq) { req.resume(); return req.method === "GET" ? json(200, { at: now() }) : json(405, { error: "GET only" }); }
    if (!cfg.token || !signedReq) { req.resume(); return json(401, { error: cfg.token ? "unsigned request" : "not in a team yet" }); }
    if (!isMyHost(host, req.socket.localPort, opts.ifaces)) { req.resume(); return json(401, { error: "wrong host" }); }
    // the body is part of the signature, so it is read (small limit) before the check
    let raw;
    try { raw = await readBody(req, url.pathname === "/v1/notes" ? 4096 : 2048); }
    catch (e) { return json(e.code === 413 ? 413 : 400, { error: e.code === 413 ? "too large" : "bad body" }, { Connection: "close" }); }
    const v = verifyRequest(cfg.token, { method: req.method, host, path: req.url, headers: req.headers, body: raw, ip: remoteIp(req) }, guard);
    if (!v.ok) return json(v.error === "busy-ip" ? 429 : v.error === "busy" ? 503 : 401, { error: v.error });
    if (url.pathname === "/v1/ping") return req.method === "GET" ? json(200, { at: now(), instanceId: cfg.instanceId || "" }) : json(405, { error: "GET only" });
    if (url.pathname === "/v1/hello") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let b; try { b = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      const port = Number(b && b.port), addr = remoteIp(req), name = b && typeof b.name === "string" ? cleanName(b.name) : "";
      if (!name || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9.]+$/.test(addr)) return json(400, { error: "name, port required" });
      const peer = { name, host: `${addr}:${port}`, instanceId: typeof b.instanceId === "string" && UUID_RE.test(b.instanceId) ? b.instanceId : "" };
      let r = { ok: true }; try { r = (opts.onHello && opts.onHello(peer)) || r; } catch (e) { r = { ok: false, error: e.message }; }
      return json(r.ok === false ? 500 : 200, { ok: r.ok !== false, ...(r.pending ? { pending: true } : {}), name: cfg.name, instanceId: cfg.instanceId || "" });
    }
    if (url.pathname === "/v1/notes") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let body; try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      // the sender is whoever I registered at that IP (the port hint picks between two on one PC) — never the body's "from"
      const ip = remoteIp(req), hint = Number(body && body.port);
      const at = (cfg.peers || []).filter(p => hostIp(p.host) === ip);
      const sender = at.find(p => Number(String(p.host).split(":")[1]) === hint) || at[0];
      if (!sender) return json(403, { error: "not a registered teammate" });
      const v2 = validateNote({ ...(body && typeof body === "object" ? body : {}), from: sender.name }); if (v2.error) return json(400, { error: v2.error });
      const t = now();
      if (!noteRateCheck(noteTimes, ip, t)) return json(429, { error: "too many notes" });
      const note = { id: randomUUID(), at: t, ...v2.note };
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
    if ((since && snap.at && since >= snap.at) || req.headers["if-none-match"] === cache.etag) return send(304, "", { ETag: cache.etag });
    return send(200, `{"name":${JSON.stringify(cfg.name)},"at":${Number(snap.at) || 0},"instanceId":${JSON.stringify(cfg.instanceId || "")},"sessions":${cache.body}}`, { "Content-Type": "application/json", ETag: cache.etag });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 50;
  server.on("error", () => {});   // reported through listen's callback / the caller's error handler
  return server;
}

const baseOf = peer => `http://${String(peer.host).replace(/^https?:\/\//, "")}`;
const errText = e => e.name === "TimeoutError" ? "timeout" : e.code === "TOO_LARGE" ? "response too large" : (e.cause && e.cause.code) || e.message;
async function readCapped(r, max) {
  const tooLarge = () => Object.assign(new Error("response too large"), { code: "TOO_LARGE" });
  if (Number(r.headers.get("content-length") || 0) > max) { try { await r.body?.cancel(); } catch {} throw tooLarge(); }
  if (!r.body) return "";
  const reader = r.body.getReader(); const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { try { await reader.cancel(); } catch {} throw tooLarge(); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
// one signed round trip, bound to the peer's "ip:port" (signed; fetch sends it as the Host header from the URL). Redirects are never
// followed; a reply is trusted only when its signature (status, host, my ts / nonce, body) checks out.
async function signedFetch(peer, token, method, path, body, { timeoutMs = 2500, headers = {} } = {}) {
  const host = String(peer.host).replace(/^https?:\/\//, "");
  const s = signRequest(token, method, host, path, body || "");
  const r = await fetch(`http://${host}${path}`, { method, headers: { ...headers, ...s.headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body || undefined, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (r.status >= 300 && r.status < 400 && r.status !== 304) { try { await r.body?.cancel(); } catch {} return { r, text: "", signed: false, redirect: true }; }
  const text = r.status === 304 ? "" : await readCapped(r, RESPONSE_MAX);
  const signed = safeEqual(r.headers.get("x-ad-sig") || "", responseSignature(token, r.status, host, s.ts, s.nonce, text));
  return { r, text, signed };
}
const parseJson = t => { try { return JSON.parse(t); } catch { return {}; } };
// a 401 is "token mismatch" unless the (verifiable) reply says why
const authError = (signed, text) => (signed && parseJson(text).error) || "token mismatch";
const uuidOr = v => typeof v === "string" && UUID_RE.test(v) ? v : "";
// opts: number (timeout, phase 1) or { timeoutMs, etag, since }. A 304 comes back as { ok: true, notModified: true }.
export async function fetchPeer(peer, token, opts = {}) {
  const o = typeof opts === "number" ? { timeoutMs: opts } : (opts || {});
  const t0 = Date.now();
  try {
    const { r, text, signed, redirect } = await signedFetch(peer, token, "GET", `/v1/sessions${o.since ? `?since=${Number(o.since)}` : ""}`, "", { timeoutMs: o.timeoutMs || 2500, headers: o.etag ? { "If-None-Match": o.etag } : {} });
    const rtt = Date.now() - t0;
    if (redirect) return { name: peer.name, ok: false, rtt, error: "redirect refused" };
    if (r.status === 401) return { name: peer.name, ok: false, rtt, error: authError(signed, text) };
    if (!signed) return { name: peer.name, ok: false, rtt, error: "bad signature" };
    if (r.status === 304) return { name: peer.name, ok: true, notModified: true, at: Date.now(), rtt, etag: r.headers.get("etag") || o.etag || "" };
    if (!r.ok) return { name: peer.name, ok: false, rtt, error: `HTTP ${r.status}` };
    const d = parseJson(text);
    return { name: peer.name, ok: true, at: Date.now(), rtt, etag: r.headers.get("etag") || "", theirAt: Number(d.at) || 0, remoteName: cleanName(d.name || ""), instanceId: uuidOr(d.instanceId), sessions: sanitizeSessions(d.sessions) };
  } catch (e) {
    return { name: peer.name, ok: false, error: errText(e) };
  }
}

export async function postNote(peer, token, note, timeoutMs = 4000) {
  try {
    const { r, text, signed, redirect } = await signedFetch(peer, token, "POST", "/v1/notes", JSON.stringify(note), { timeoutMs });
    if (redirect) return { ok: false, error: "redirect refused" };
    if (r.status === 401) return { ok: false, status: 401, error: authError(signed, text) };
    if (!signed) return { ok: false, status: r.status, error: "bad signature" };
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, error: r.status === 429 ? "too many notes" : r.status === 403 ? "not registered on their side" : parseJson(text).error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function postHello(peer, token, me, timeoutMs = 4000) {
  try {
    const { r, text, signed, redirect } = await signedFetch(peer, token, "POST", "/v1/hello", JSON.stringify({ name: me.name, port: me.port, instanceId: me.instanceId || "" }), { timeoutMs });
    if (redirect) return { ok: false, error: "redirect refused" };
    if (r.status === 401) return { ok: false, status: 401, error: authError(signed, text) };
    if (!signed) return { ok: false, status: r.status, error: "bad signature" };
    const d = parseJson(text);
    return r.ok ? { ok: true, pending: !!d.pending, name: cleanName(d.name || ""), instanceId: uuidOr(d.instanceId) } : { ok: false, status: r.status, error: d.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
// open ping: is anything answering? ({ at } only)
export async function pingPeer(peer, timeoutMs = 2500) {
  try {
    const r = await fetch(`${baseOf(peer)}/v1/ping`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { try { await r.body?.cancel(); } catch {} return { ok: false, error: `HTTP ${r.status}` }; }
    const d = parseJson(await readCapped(r, 4096));
    return { ok: true, at: Number(d.at) || 0 };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
// signed ping: an AgentDesk of my team is answering at this address → { ok, instanceId }
export async function pingPeerSigned(peer, token, timeoutMs = 2500) {
  try {
    const { r, text, signed, redirect } = await signedFetch(peer, token, "GET", "/v1/ping", "", { timeoutMs });
    if (redirect || !signed || r.status !== 200) return { ok: false, error: redirect ? "redirect refused" : !signed ? "bad signature" : `HTTP ${r.status}` };
    return { ok: true, instanceId: uuidOr(parseJson(text).instanceId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
// a hello says "instance X moved from oldHost to a new address". If X (or an AgentDesk of my team that does not say
// who it is) still answers a signed ping at oldHost, the old address is alive → "reject" (someone else claims X).
// Only when the old address is silent (or now answers as a different instance) is it a real move → "pending".
export async function classifyMove({ oldHost, instanceId }, token, ping = pingPeerSigned) {
  const r = await ping({ name: "old", host: oldHost }, token);
  if (r.ok && (!r.instanceId || !instanceId || r.instanceId === instanceId)) return "reject";
  return "pending";
}
