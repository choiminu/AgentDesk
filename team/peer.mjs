// Team sharing: every AgentDesk on the office network publishes a read-only snapshot of its sessions over HTTP,
// and polls the peers listed in ~/.agentdesk/team.json. No WebSocket, no inbound control — a peer can only look,
// and (phase 2) leave a short note that lands in the receiver's inbox; it is never typed into a session by itself.
//   GET  /v1/ping                       → { at }   (open; signed → { at, instanceId, pubkey? })
//   GET  /v1/sessions  (signed)         → { name, at, instanceId, sessions: [...], safety? }  (sanitized: no prompts, tool inputs or full paths;
//                                          safety = { guard, perm, rulesHash, blocksToday } — never a rule body / label / pattern)
//        ?since=<at> / If-None-Match     → 304 with no body when nothing changed
//   POST /v1/notes     (signed)         ← { to, toName?, text ≤ 500, port? }  → 202; "from" is the teammate whose pinned key
//                                          signed it (v1: the keyless entry at the caller's IP; 403 when there is none);
//                                          429 past 10 notes a minute from one key (v1: one IP)
//   POST /v1/hello     (signed)         ← { name, port, instanceId } (v1) | { v: 2, …, pubkey, ticket? } (key-signed by
//                                          that pubkey) → handed to onHello, which queues it for the user's confirmation
// Phase 3 — per-session delegation (team/remote.mjs). Only a session its owner delegated to one teammate (key id),
// with a random per-delegation grant that only that teammate receives (inside its signed /v1/sessions answer):
//   POST /v1/sessions/:id/input     (signed) ← { grant, text ≤ 4000 }  → 200 { ok, accepted } | 403 not delegated / blocked
//                                              | 409 busy (not waiting for input, or another input in flight) | 429 (20/min/session)
//   POST /v1/sessions/:id/interrupt (signed) ← { grant }               → 200 { ok }
//   POST /v1/sessions/:id/last      (signed) ← { grant }               → { text ≤ 8000 (masked), at } — the last answer only
//   POST /v1/sessions/:id/screen    (signed) ← { grant }               → { lines: [≤ 200, each ≤ 400 chars, ≤ 24 KB in all,
//                                              masked, no ANSI / control characters], status, needsInput, ended, at }
//                                              | 409 busy (session not placeable / screen unreadable) | 429 (90/min per
//                                              session and caller, a budget of its own — reads never use the input /
//                                              interrupt one). One read per session at a time, reused for 1 s. Read-only:
//                                              the remote terminal view polls it; typing still goes through /input only.
// :id is the public id (s_ + 24 hex of sha256(local id)). The grant must belong to the teammate whose PINNED key signed
// the request (an address identifies nobody; grants and safety in /v1/sessions follow the same rule). Permission
// prompts, closing terminals, worktrees and delegation itself have no remote endpoint.
// Signing (no token ever crosses the wire): request headers X-AD-Ts (ms), X-AD-Nonce (16 random bytes, hex) and
//   X-AD-Sig = HMAC-SHA256(token, METHOD \n host \n path \n ts \n nonce \n sha256(body))   (host = the peer's "ip:port",
//   also sent as the Host header; the server only accepts its own address and port, so a request cannot be relayed)
// The server accepts ts within ±120 s and each nonce once (250 s memory, 600 per caller IP), and signs every answer with
//   X-AD-Sig = HMAC-SHA256(token, status \n host \n ts \n nonce \n sha256(responseBody))   (request's ts / nonce; 304 → sha256(""))
// so a client also knows the reply came from a holder of the same token. An empty token (not in a team yet) keeps the
// server up for ping only and refuses everything else.
// Key layer (0.2.2, docs/design/ed25519-identity.md §4; team/identity.mjs): on top of the HMAC, a request carries
//   X-AD-Ver 2, X-AD-Kid, X-AD-Pub, X-AD-To (the receiver's kid or "-") and X-AD-KSig = Ed25519 over reqKeyInput, and
//   every answer X-AD-Ver / X-AD-Kid / X-AD-Pub / X-AD-KSig over resKeyInput (status, host, ts, nonce, body, both kids,
//   team tag). A client that pinned the server's key refuses an answer without that key's signature (no downgrade).
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, basename, dirname } from "node:path";
import "../core/mask.js";   // globalThis.AgentDeskMask
import "../core/team.js";   // globalThis.AgentDeskTeam (clean, publicSessionId)
import "../core/guard.js";  // globalThis.AgentDeskGuard (isDangerous)
import { kidOf, teamTag, reqKeyInput, resKeyInput, verifyKey, PUB_RE, KID_RE, KSIG_RE, KEY_TRUST } from "./identity.mjs";
import { validateRemoteText, resolveDelegatedSession, permissionOk, hostIpv4, GRANT_RE, REMOTE_RATE, REMOTE_LAST_MAX, REMOTE_SCREEN_RATE, REMOTE_SCREEN_LINES, REMOTE_SCREEN_LINE_MAX, REMOTE_SCREEN_BYTES, REMOTE_SCREEN_LOG_MS, REMOTE_SCREEN_CACHE_MS } from "./remote.mjs";
const { mask, secretRanges } = globalThis.AgentDeskMask;
const { clean, publicSessionId, PUBLIC_ID_RE, sanitizeSafety } = globalThis.AgentDeskTeam;
const { isDangerous } = globalThis.AgentDeskGuard;

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
    peers: (Array.isArray(cfg.peers) ? cfg.peers : []).filter(p => p && p.name && p.host).map(p => ({ name: String(p.name), host: String(p.host), ...(p.instanceId ? { instanceId: String(p.instanceId) } : {}), ...peerKeyFields(p) })),
    ...(cfg.instanceId ? { instanceId: String(cfg.instanceId) } : {}),
    // Ed25519 identity (team/identity.mjs): requireKeys → v1 (HMAC-only) requests get 401 "upgrade required";
    // identity = this PC's public key, for display only (the key file is the source of truth)
    ...(cfg.requireKeys === true ? { requireKeys: true } : {}),
    ...(cfg.identity && typeof cfg.identity === "object" && PUB_RE.test(String(cfg.identity.pub || "")) ? { identity: { kid: kidOf(String(cfg.identity.pub)), pub: String(cfg.identity.pub) } } : {}),
    // the office network(s) ("a.b.c" = a /24) remembered when the team was created / joined
    ...(Array.isArray(cfg.homeSubnets) ? { homeSubnets: cfg.homeSubnets.map(String).filter(x => PREFIX_RE.test(x)).slice(0, 16) } : {}),
    ...(token && cfg.discovery !== false ? {} : { discovery: false }),
  };
}
// a teammate's key fields as kept in team.json: pubkey (b64url 43) with how it came to be trusted (keyTrust "invite" =
// from my invite code / their invite code, "confirmed" = the user compared the fingerprint) and when (keyAt); expectKid
// = the key id a beacon announced (unauthenticated: the first signed reply must carry it). Malformed values are dropped.
function peerKeyFields(p) {
  const o = {};
  if (typeof p.pubkey === "string" && kidOf(p.pubkey) && KEY_TRUST.has(p.keyTrust)) {
    o.pubkey = p.pubkey; o.keyTrust = p.keyTrust;
    const at = Number(p.keyAt); if (Number.isFinite(at) && at > 0) o.keyAt = at;
  }
  if (typeof p.expectKid === "string" && KID_RE.test(p.expectKid)) o.expectKid = p.expectKid;
  return o;
}
// a teammate's pinned public key ("" when none): only a key with a trust reason counts
export const pinnedKeyOf = p => (p && typeof p.pubkey === "string" && KEY_TRUST.has(p.keyTrust) && kidOf(p.pubkey)) ? p.pubkey : "";
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
// pure: add or update one peer. Returns { peers, change, name, from? }.
// With a public key (peer.pubkey; written only together with a keyTrust of "invite" / "confirmed", plus keyAt):
//   same pinned key        → "moved" (host follows: the same key is the same person) / "updated" (instance id changed) / "none"
//   an entry with that instance id or host and a DIFFERENT pinned key → "rekey" — nothing changes unless peer.rekey === true
//                            (the user confirmed the new key; then the key, host and instance id are replaced)
//   that entry has no key  → "bind" (the key is added when it comes with a keyTrust; host / instance id follow)
//   otherwise              → "added"
// Without a key (an older teammate): same instanceId → "moved"; same host → "updated" (instance id filled in) / "none";
// otherwise "added". A keyless greeting for an entry that has a pinned key → "keyless": never applied.
// New entries are renamed "name-2" when the name is taken.
export function upsertPeer(peers, peer) {
  const list = (Array.isArray(peers) ? peers : []).filter(p => p && !isPlaceholder(p)).map(p => ({ ...p }));
  const host = String(peer.host || "").trim(), id = peer.instanceId ? String(peer.instanceId) : "";
  const pub = typeof peer.pubkey === "string" && kidOf(peer.pubkey) ? peer.pubkey : "";
  const trusted = pub && KEY_TRUST.has(peer.keyTrust);
  const keyOf = () => ({ pubkey: pub, keyTrust: peer.keyTrust, keyAt: Number(peer.keyAt) > 0 ? Number(peer.keyAt) : Date.now() });
  if (pub) {
    const byKey = list.find(p => pinnedKeyOf(p) === pub);
    if (byKey) {
      if (byKey.host !== host) { const from = byKey.host; byKey.host = host; if (id) byKey.instanceId = id; return { peers: list, change: "moved", name: byKey.name, from }; }
      if (id && byKey.instanceId !== id) { byKey.instanceId = id; return { peers: list, change: "updated", name: byKey.name }; }
      return { peers: list, change: "none", name: byKey.name };
    }
    const seat = (id && list.find(p => p.instanceId === id)) || list.find(p => p.host === host);
    if (seat) {
      const change = pinnedKeyOf(seat) ? "rekey" : "bind", from = seat.host;
      if (trusted && (change === "bind" || peer.rekey === true)) { Object.assign(seat, keyOf(), { host }); delete seat.expectKid; if (id) seat.instanceId = id; }
      return { peers: list, change, name: seat.name, ...(from !== host ? { from } : {}) };
    }
  }
  const byId = id && list.find(p => p.instanceId === id);
  if (!pub && list.some(p => pinnedKeyOf(p) && ((id && p.instanceId === id) || p.host === host))) {
    const p = list.find(x => pinnedKeyOf(x) && ((id && x.instanceId === id) || x.host === host));
    return { peers: list, change: "keyless", name: p.name };
  }
  if (byId) { if (byId.host === host) return { peers: list, change: "none", name: byId.name }; const from = byId.host; byId.host = host; return { peers: list, change: "moved", name: byId.name, from }; }
  const byHost = list.find(p => p.host === host);
  if (byHost) { if (id && !byHost.instanceId) { byHost.instanceId = id; return { peers: list, change: "updated", name: byHost.name }; } return { peers: list, change: "none", name: byHost.name }; }
  const base = String(peer.name || "").trim().slice(0, 36) || host.split(":")[0];
  let name = base; const taken = new Set(list.map(p => p.name));
  for (let k = 2; taken.has(name); k++) name = `${base}-${k}`;
  list.push({ name, host, ...(id ? { instanceId: id } : {}), ...(trusted ? keyOf() : {}), ...(!trusted && typeof peer.expectKid === "string" && KID_RE.test(peer.expectKid) ? { expectKid: peer.expectKid } : {}) });
  return { peers: list, change: "added", name };
}
// add a discovered / invited / confirmed peer to team.json (key fields: see upsertPeer). Returns { ok, added, updated?,
// change, name } or { ok: false, error }.
export function addPeerToConfig(file, peer) {
  const host = String(peer && peer.host || "").trim();
  if (!HOST_RE.test(host)) return { ok: false, error: "host must be IP:port" };
  let r = null;
  editTeamJson(file, raw => { r = upsertPeer(raw.peers, { ...peer, host }); const before = JSON.stringify(raw.peers || []); raw.peers = r.peers; if (JSON.stringify(raw.peers) === before) return false; });
  const wrote = r.change === "updated" || r.change === "moved" || ((r.change === "bind" || r.change === "rekey") && pinnedKeyOf(r.peers.find(p => p.name === r.name)) === peer.pubkey);
  return { ok: true, added: r.change === "added", ...(wrote ? { updated: true } : {}), ...(r.change !== "added" && r.change !== "none" && r.change !== "updated" && r.change !== "moved" ? { change: r.change } : {}), name: r.name };
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
// so it only goes to the clipboard and should travel 1:1 (Slack DM), never to a channel.
// With the inviter's public key (0.2.2): { v: 2, token, inviter: { name, host, instanceId, pubkey }, ticket } under the
// SAME v1 prefix — 0.2.1 ignores the fields it does not know, so it can still join. The joiner pins inviter.pubkey
// (keyTrust "invite") and proves in its hello that it holds the code: ticketProof(ticket, its own pubkey).
// 0.2.3 switches to the v2 prefix; decodeInvite takes both, and refuses a code without a pubkey under v2 (or when
// opts.requirePubkey).
export const INVITE_PREFIX = "agentdesk-team:v1:";
export const INVITE_PREFIX_V2 = "agentdesk-team:v2:";
const TICKET_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url
export function encodeInvite({ token, inviter, ticket }, { prefix = INVITE_PREFIX } = {}) {
  const pub = inviter && typeof inviter.pubkey === "string" && kidOf(inviter.pubkey) ? inviter.pubkey : "";
  const inv = { name: inviter.name, host: inviter.host, instanceId: inviter.instanceId || "", ...(pub ? { pubkey: pub } : {}) };
  const d = pub ? { v: 2, token, inviter: inv, ...(typeof ticket === "string" && TICKET_RE.test(ticket) ? { ticket } : {}) } : { token, inviter: inv };
  return prefix + Buffer.from(JSON.stringify(d)).toString("base64url");
}
export function decodeInvite(code, { requirePubkey = false } = {}) {
  const s = String(code || "").trim();
  const prefix = [INVITE_PREFIX, INVITE_PREFIX_V2].find(p => s.startsWith(p));
  if (!prefix) return { error: "not an AgentDesk invite code" };
  let d; try { d = JSON.parse(Buffer.from(s.slice(prefix.length), "base64url").toString("utf-8")); } catch { return { error: "damaged invite code" }; }
  const inv = d && d.inviter;
  if (!d || typeof d.token !== "string" || d.token.length < 8 || d.token === TEAM_EXAMPLE.token) return { error: "invite code has no valid token" };
  if (!inv || typeof inv.name !== "string" || !cleanName(inv.name) || typeof inv.host !== "string" || !HOST_RE.test(inv.host)) return { error: "invite code has no valid inviter" };
  const pub = typeof inv.pubkey === "string" && kidOf(inv.pubkey) ? inv.pubkey : "";
  if (!pub && (requirePubkey || prefix === INVITE_PREFIX_V2)) return { error: "invite code has no key (made by an older AgentDesk)" };
  return { token: d.token, inviter: { name: cleanName(inv.name), host: inv.host, instanceId: typeof inv.instanceId === "string" && UUID_RE.test(inv.instanceId) ? inv.instanceId : "", ...(pub ? { pubkey: pub } : {}) },
    ...(pub && typeof d.ticket === "string" && TICKET_RE.test(d.ticket) ? { ticket: d.ticket } : {}) };
}
// join ticket (docs/design/ed25519-identity.md §13): 16 random bytes in the invite code; the joiner's hello v2 carries
// HMAC-SHA256(ticket, its pubkey) so the inviter knows the key came from someone holding the code. One use, 24 h.
export const TICKET_TTL_MS = 24 * 3600 * 1000;
export const ticketProof = (ticket, pubkey) => createHmac("sha256", Buffer.from(String(ticket), "base64url")).update(String(pubkey)).digest("hex");
export function createTicketStore({ now = Date.now, ttlMs = TICKET_TTL_MS, max = 50, initial = [] } = {}) {
  let items = (Array.isArray(initial) ? initial : []).filter(t => t && TICKET_RE.test(String(t.ticket)) && Number(t.at) > 0).map(t => ({ ticket: String(t.ticket), at: Number(t.at) }));
  const prune = () => { const t = now(); items = items.filter(x => t - x.at < ttlMs).slice(-max); };
  return {
    issue() { prune(); const ticket = randomBytes(16).toString("base64url"); items.push({ ticket, at: now() }); if (items.length > max) items.shift(); return ticket; },
    // true (and the ticket is used up) when proof = ticketProof(one live ticket, pubkey)
    check(proof, pubkey) {
      prune();
      if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof) || !kidOf(pubkey)) return false;
      const i = items.findIndex(x => safeEqual(proof, ticketProof(x.ticket, pubkey)));
      if (i < 0) return false;
      items.splice(i, 1); return true;
    },
    list() { prune(); return items.map(x => ({ ...x })); },
    get size() { prune(); return items.length; },
  };
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
const BOOL_FIELDS = ["needsInput", "stuck", "ended", "isSub", "hookOnly", "delegated"];
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
// key: { identity, targetKid } adds the Ed25519 layer (§4.2): X-AD-Ver 2, X-AD-Kid (mine), X-AD-Pub (my public key, so a
// server that has not pinned it yet can still check the signature), X-AD-To (the receiver's kid, "-" when I have not
// pinned one) and X-AD-KSig over reqKeyInput. The HMAC headers stay exactly as in v1.
export function signRequest(token, method, host, path, body = "", now = Date.now(), key = null) {
  const ts = String(now), nonce = randomBytes(16).toString("hex");
  const headers = { "X-AD-Ts": ts, "X-AD-Nonce": nonce, "X-AD-Sig": requestSignature(token, method, host, path, ts, nonce, body) };
  const id = key && key.identity;
  if (id && id.kid && typeof id.sign === "function") {
    const to = key.targetKid && KID_RE.test(key.targetKid) ? key.targetKid : "-";
    Object.assign(headers, { "X-AD-Ver": "2", "X-AD-Kid": id.kid, "X-AD-Pub": id.pub, "X-AD-To": to,
      "X-AD-KSig": id.sign(reqKeyInput({ method, host, path, ts, nonce, body: body || "", callerKid: id.kid, targetKid: to, tag: teamTag(token) })) });
  }
  return { ts, nonce, headers };
}
// replay guard: each nonce once within NONCE_TTL_MS (longer than the ±120 s window, so an expired nonce can never be
// replayed with a valid ts). Per bucket at most NONCE_PER_IP live nonces ("busy-ip" → 429 for that bucket only); the
// whole table is capped at NONCE_MAX ("busy"). The bucket is the caller's key id for a key-signed (v2) request and its
// IP for an HMAC-only (v1) one, so two teammates behind one address do not share a budget.
export function createNonceGuard({ ttlMs = NONCE_TTL_MS, max = NONCE_MAX, perIp = NONCE_PER_IP } = {}) {
  const seen = new Map();    // nonce → { at, key } (insertion order = time order)
  const byKey = new Map();   // bucket → live nonce count
  return {
    check(nonce, t, key = "") {
      for (const [n, e] of seen) {
        if (t - e.at <= ttlMs) break;
        seen.delete(n); const c = (byKey.get(e.key) || 1) - 1; if (c > 0) byKey.set(e.key, c); else byKey.delete(e.key);
      }
      if (seen.has(nonce)) return "replayed";
      if ((byKey.get(key) || 0) >= perIp) return "busy-ip";
      if (seen.size >= max) return "busy";
      seen.set(nonce, { at: t, key }); byKey.set(key, (byKey.get(key) || 0) + 1);
      return "ok";
    },
    get size() { return seen.size; },
  };
}
// headers: lower-cased (node's req.headers); host: the Host header value (already checked to be mine).
// keys (the Ed25519 layer, optional): { myKid, lookup(kid) → pinned pubkey | "" }. Without keys (v1 mode) the key
// headers are not looked at and the result is { ok, ts, nonce } as before 0.2.2. With keys, order (§4.4): header format, ts,
// HMAC, then for X-AD-Ver 2: X-AD-To must be "-" or my kid ("wrong peer"), the key is the pinned one or X-AD-Pub (whose
// kid must be X-AD-Kid; neither → "unknown key"), the key signature, and last the nonce (bucket: kid, or IP for v1).
// keys.allowUnpinned: a key that is not pinned is accepted at all (the server allows it on /v1/ping, /v1/sessions and
// /v1/hello only); otherwise → "unknown key". The nonce bucket is the kid only for a PINNED key — an unpinned key
// (anyone with the token can make a new one per request) shares its IP's bucket, so it cannot get round the cap.
// Returns { ok, ts, nonce, ver: 1 | 2, kid, pubkey, pinned } or { ok: false, error } (with keys: hmacOk once the HMAC
// has checked out — the server key-signs only those answers).
export function verifyRequest(token, { method, host, path, headers, body, ip }, guard, t = Date.now(), keys = null) {
  if (!token) return { ok: false, error: "not in a team yet" };
  const h = headers || {};
  const ts = String(h["x-ad-ts"] || ""), nonce = String(h["x-ad-nonce"] || ""), sig = String(h["x-ad-sig"] || "");
  if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: "unsigned request" };
  const ver = !keys || h["x-ad-ver"] === undefined ? 1 : String(h["x-ad-ver"]) === "2" ? 2 : 0;
  const kid = String(h["x-ad-kid"] || ""), to = String(h["x-ad-to"] || ""), ksig = String(h["x-ad-ksig"] || ""), hpub = h["x-ad-pub"] === undefined ? "" : String(h["x-ad-pub"]);
  if (ver === 0 || (ver === 2 && (!KID_RE.test(kid) || !(to === "-" || KID_RE.test(to)) || !KSIG_RE.test(ksig) || (hpub && !PUB_RE.test(hpub))))) return { ok: false, error: "bad key headers" };
  if (Math.abs(t - Number(ts)) > SIG_SKEW_MS) return { ok: false, error: "clock skew" };
  if (!safeEqual(sig, requestSignature(token, method, host, path, ts, nonce, body || ""))) return { ok: false, error: "bad signature" };
  // past the HMAC: a failure from here on is answered by a holder of the team token (key mode marks it)
  const fail = error => keys ? { ok: false, error, hmacOk: true } : { ok: false, error };
  let pubkey = "", pinned = false;
  if (ver === 2) {
    if (to !== "-" && to !== (keys.myKid || "")) return fail("wrong peer");
    const p = typeof keys.lookup === "function" ? keys.lookup(kid) : "";
    if (p && kidOf(p) === kid) { pubkey = p; pinned = true; }
    else if (keys.allowUnpinned && hpub && kidOf(hpub) === kid) pubkey = hpub;
    else return fail("unknown key");
    if (!verifyKey(pubkey, reqKeyInput({ method, host, path, ts, nonce, body: body || "", callerKid: kid, targetKid: to, tag: teamTag(token) }), ksig)) return fail("bad key signature");
  }
  const g = guard.check(nonce, t, ver === 2 && pinned ? `k:${kid}` : (ip || ""));
  if (g !== "ok") return fail(g);
  return { ok: true, ts, nonce, ...(keys ? { ver } : {}), ...(ver === 2 ? { kid, pubkey, pinned } : {}) };
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
// phase 3: /v1/sessions/<public session id>/(input|interrupt|last|screen)
const REMOTE_PATH_RE = /^\/v1\/sessions\/([^/]{1,320})\/(input|interrupt|last|screen)$/;
const REMOTE_BODY_MAX = 24 * 1024;   // 4,000 characters of Hangul are 12 KB of UTF-8, plus the JSON around them
// ANSI sequences: CSI; OSC ended by BEL / ST, or cut short by the next ESC; an unterminated OSC loses only its
// "ESC ] Ps ;" head (the text after it stays); any other two-byte ESC sequence
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\|(?=\u001b))|\u001b\][0-9]*;?|\u001b[@-_]/g;
// invisible format characters (zero-width space / joiners, bidi marks, BOM …) would split a token so no pattern matches
const FORMAT_RE = /\p{Cf}/gu;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, PEM_END_RE = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;
const KEY_ROW_RE = /^[A-Za-z0-9+\/]{60,}={0,2}$/, KEY_RUN_ROW_RE = /^[A-Za-z0-9+\/]{40,}={0,2}$/, B64_ROW_RE = /^[A-Za-z0-9+\/]+={0,2}$/;
const MASKED_KEY = "[MASKED PRIVATE KEY]";
// key body looks random: digits, upper- and lower-case letters all present (a row of "xxxx…" or "====…" is not one)
const keyRow = (t, re) => re.test(t) && /[0-9]/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t);
// rows of text (a terminal screen, an answer split at its line breaks) masked so that nothing leaks at a row boundary:
//  - a secret wrapped over rows is found in the rows joined WITHOUT a separator and cut out of every row it touches
//  - a private key: from a BEGIN line on (to its END line, or to the last row when END is not there), back from an END
//    line whose BEGIN scrolled off, and rows that look like key body (one base64 row of 60+ characters, or 3+ rows of
//    40+ in a row, with the short base64 row that ends them; digits and both cases present)
//  - then mask() per row. The result has exactly one row per input row.
export function maskRows(rows) {
  const src = (Array.isArray(rows) ? rows : []).map(r => String(r ?? ""));
  const out = src.slice();
  const starts = []; let pos = 0;
  for (const r of src) { starts.push(pos); pos += r.length; }
  const cuts = src.map(() => []);
  for (const [a, b] of secretRanges(src.join(""))) {
    let i = 0; while (i + 1 < src.length && starts[i + 1] <= a) i++;
    if (i + 1 >= src.length || starts[i + 1] >= b) continue;   // inside one row: mask() below sees it whole
    for (; i < src.length && starts[i] < b; i++) {
      const s = Math.max(a, starts[i]) - starts[i], e = Math.min(b, starts[i] + src[i].length) - starts[i];
      if (e > s) cuts[i].push([s, e]);
    }
  }
  cuts.forEach((c, i) => {
    if (!c.length) return;
    c.sort((x, y) => x[0] - y[0]);
    let s = "", at = 0;
    for (const [a, b] of c) { if (b <= at) continue; s += src[i].slice(at, Math.max(a, at)) + "[MASKED]"; at = b; }
    out[i] = s + src[i].slice(at);
  });
  const key = src.map(() => false);
  let inPem = false;
  for (let i = 0; i < src.length; i++) {
    if (inPem) { key[i] = true; if (PEM_END_RE.test(src[i])) inPem = false; continue; }
    const b = src[i].search(PEM_BEGIN_RE);
    if (b >= 0) {
      if (PEM_END_RE.test(src[i].slice(b))) continue;   // one-line key: mask() below
      inPem = true; const bo = out[i].search(PEM_BEGIN_RE);
      out[i] = bo >= 0 ? out[i].slice(0, bo) + MASKED_KEY : MASKED_KEY; continue;
    }
    if (PEM_END_RE.test(src[i])) {   // BEGIN is above the rows I have
      key[i] = true;
      for (let j = i - 1; j >= 0 && !key[j] && (B64_ROW_RE.test(src[j].trim()) || !src[j].trim()); j--) key[j] = true;
    }
  }
  for (let i = 0; i < src.length; i++) {
    const t = src[i].trim();
    if (keyRow(t, KEY_ROW_RE)) key[i] = true;
    if (keyRow(t, KEY_RUN_ROW_RE)) {
      let j = i; while (j < src.length && keyRow(src[j].trim(), KEY_RUN_ROW_RE)) j++;
      if (j - i >= 3) { for (let k = i; k < j; k++) key[k] = true; if (j < src.length && B64_ROW_RE.test(src[j].trim())) key[j] = true; }
      i = j - 1;
    }
  }
  return out.map((l, i) => key[i] ? MASKED_KEY : mask(l));
}
// a session's last answer as it may leave (server) or enter (client): masked (maskRows over its lines, after invisible
// format characters are dropped), line breaks kept, other control characters gone, at most REMOTE_LAST_MAX characters
export function lastText(v) {
  const rows = String(v ?? "").slice(0, REMOTE_LAST_MAX * 4).replace(FORMAT_RE, "").replace(/\r\n?/g, "\n").split("\n");
  return maskRows(rows).map(l => l.replace(CTRL_RE, " ").replace(/\s+$/, "")).join("\n").trim().slice(0, REMOTE_LAST_MAX);
}
// a session's screen as it may leave (server) or enter (client): ANSI sequences, invisible format characters and other
// control characters gone, masked by maskRows over a wider window than is kept (a key's BEGIN line may sit above it),
// then the last REMOTE_SCREEN_LINES lines, each at most REMOTE_SCREEN_LINE_MAX characters and all of them at most
// REMOTE_SCREEN_BYTES of UTF-8 (the newest lines are kept)
export function screenLines(v) {
  const src = (Array.isArray(v) ? v : []).slice(-REMOTE_SCREEN_LINES * 2)
    .map(l => String(l ?? "").slice(0, REMOTE_SCREEN_LINE_MAX * 4).replace(ANSI_RE, "").replace(FORMAT_RE, "").replace(/[\r\n]/g, " "));
  if (!src.length) return [];
  const masked = maskRows(src).slice(-REMOTE_SCREEN_LINES);
  const out = []; let size = 0;
  for (let i = masked.length - 1; i >= 0 && out.length < REMOTE_SCREEN_LINES; i--) {
    const l = masked[i].replace(CTRL_RE, " ").replace(/\s+$/, "").slice(0, REMOTE_SCREEN_LINE_MAX);
    size += Buffer.byteLength(l) + 1; if (size > REMOTE_SCREEN_BYTES) break;
    out.push(l);
  }
  return out.reverse();
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

// cfg is read on every request (a live view in the app): { name, token, instanceId, peers, requireKeys? }.
// opts.onNote(note) receives accepted notes; opts.onHello(peer) a signed greeting (returns { ok, pending? }) —
//   v1: { name, host, instanceId }; v2: { name, host, instanceId, v: 2, pubkey, kid, ticketOk } (the request was signed
//   by that very key: proof of possession; ticketOk = opts.checkTicket(proof, pubkey) said the invite's join ticket fits);
// opts.identity: this PC's identity (team/identity.mjs) or a function returning it — every answer to a signed request is
//   then key-signed too, and X-AD-To must name it; never put it into cfg (cfg may be shown to the renderer);
// opts.pinnedKeys() → { name: pubkey } (or a Map): the teammates whose key is pinned (default: cfg.peers entries with a
//   pubkey and a keyTrust of "invite" / "confirmed"). Only a request signed by a pinned key gets grants, safety, the
//   remote endpoints, and is the sender of a note; any valid key signature (or a v1 HMAC-only request) may list sessions;
// opts.requireKeys (or cfg.requireKeys): HMAC-only (v1) requests get a signed 401 "upgrade required";
// Without opts.identity the server runs in v1 mode, exactly as before 0.2.2: key headers are ignored, and the caller
// is the teammate registered at the request's IP (grants, safety, notes and remote endpoints by instance id; two
// entries at one IP → "ambiguous teammate"); pinnedKeys / requireKeys / checkTicket do nothing.
// opts.safety() → this PC's safety summary (core/team.js safetySummary), served in /v1/sessions as `safety`;
// opts.now() is injectable for the rate-limit test (signatures always use the real clock); opts.ifaces for isMyHost
export function startTeamServer(cfg, getSnapshot, opts = {}) {
  const now = opts.now || Date.now;
  const guard = opts.nonceGuard || createNonceGuard();
  const noteTimes = new Map();   // caller kid (v2) / IP (v1) → timestamps within the last minute
  const store = opts.delegations || null;   // phase 3: team/remote.mjs createDelegationStore (null → no remote endpoints)
  const remoteTimes = new Map();            // session id → input / interrupt timestamps within the last minute
  const inflight = new Set();               // sessions with a remote input being typed right now
  const screenTimes = new Map();            // "session id|kid" (v1: "|instance id") → screen reads within the last minute (own budget)
  const screenReads = new Map();            // session id → { p, done, at }: the read in flight, or the last one (reused for REMOTE_SCREEN_CACHE_MS)
  const screenLogged = new Map();           // "session id|kid" (v1: "|instance id") → when a "screen viewed" event was last logged
  let cache = { snap: null, body: "", etag: "" };
  // the last safety JSON served and when it last changed (bumps `at` for ?since=: a server re-created on a bind change
  // starts empty, and its first safety counts as a change so a client's old ?since= cannot hide it); the callback's
  // answer is reused for 1 s
  let safetyLast = null, safetyAt = 0, safetyMemo = { at: -Infinity, json: "" };
  const myId = () => { let i = null; try { i = typeof opts.identity === "function" ? opts.identity() : opts.identity; } catch { i = null; } return i && i.kid && i.pub && typeof i.sign === "function" ? i : null; };
  const requireKeys = () => { try { return typeof opts.requireKeys === "function" ? !!opts.requireKeys() : opts.requireKeys !== undefined ? !!opts.requireKeys : cfg.requireKeys === true; } catch { return false; } };
  // kid → { name, pubkey } of every pinned teammate
  const pinnedMap = () => {
    let m = null; try { m = opts.pinnedKeys ? opts.pinnedKeys() : null; } catch { m = null; }
    const entries = m instanceof Map ? [...m] : m && typeof m === "object" ? Object.entries(m) : opts.pinnedKeys ? [] : (cfg.peers || []).map(p => [p && p.name, pinnedKeyOf(p)]);
    const out = new Map();
    for (const [name, pub] of entries) { const k = kidOf(pub); if (k && name) out.set(k, { name: String(name), pubkey: pub }); }
    return out;
  };
  const server = createServer(async (req, res) => {
    // set as soon as the request carries well-formed signing headers and I have a token: from then on every answer
    // (401 / 304 / 4xx included) is signed over its status, my address and the request's ts / nonce — and, with an
    // identity, key-signed (§4.3) over the same plus my kid and the caller's
    // The key signature is added only once the request's HMAC has checked out (sig.keySign): a caller without the
    // team token never gets a key-signed answer (and costs no Ed25519 signing).
    let sig = null;
    const send = (code, body, headers = {}) => {
      const h = { "Cache-Control": "no-store", ...headers };
      if (sig) {
        h["X-AD-Sig"] = responseSignature(cfg.token, code, sig.host, sig.ts, sig.nonce, body);
        const id = sig.keySign ? myId() : null;
        if (id) Object.assign(h, { "X-AD-Ver": "2", "X-AD-Kid": id.kid, "X-AD-Pub": id.pub, "X-AD-KSig": id.sign(resKeyInput({ status: code, host: sig.host, ts: sig.ts, nonce: sig.nonce, body, serverKid: id.kid, callerKid: sig.callerKid, tag: teamTag(cfg.token) })) });
      }
      res.writeHead(code, h); res.end(body);
    };
    const json = (code, body, headers = {}) => send(code, JSON.stringify(body), { "Content-Type": "application/json", ...headers });
    const host = String(req.headers.host || "");
    if (!validHostHeader(req.headers.host)) { req.resume(); return json(400, { error: "bad host" }); }
    let url; try { url = new URL(req.url, "http://x"); } catch { req.resume(); return json(400, { error: "bad url" }); }
    const rm = REMOTE_PATH_RE.exec(url.pathname);
    let remoteSid = "";
    if (rm) { try { remoteSid = decodeURIComponent(rm[1]); } catch { remoteSid = ""; } }
    const known = ["/v1/ping", "/v1/sessions", "/v1/notes", "/v1/hello"].includes(url.pathname) || (rm && PUBLIC_ID_RE.test(remoteSid));
    if (!known) { req.resume(); return json(404, { error: "not found" }); }
    const ts = String(req.headers["x-ad-ts"] || ""), nonce = String(req.headers["x-ad-nonce"] || "");
    const signedReq = !!req.headers["x-ad-sig"];
    const hkid = String(req.headers["x-ad-kid"] || "");
    if (cfg.token && signedReq && /^\d{1,16}$/.test(ts) && /^[0-9a-f]{32}$/.test(nonce)) sig = { host, ts, nonce, callerKid: String(req.headers["x-ad-ver"] || "") === "2" && KID_RE.test(hkid) ? hkid : "-" };
    // open ping: only "I am up" (no name, no id — the beacon does discovery). A signed ping also gets my instance id
    // (and my public key).
    if (url.pathname === "/v1/ping" && !signedReq) { req.resume(); return req.method === "GET" ? json(200, { at: now() }) : json(405, { error: "GET only" }); }
    if (!cfg.token || !signedReq) { req.resume(); return json(401, { error: cfg.token ? "unsigned request" : "not in a team yet" }); }
    if (!isMyHost(host, req.socket.localPort, opts.ifaces)) { req.resume(); return json(401, { error: "wrong host" }); }
    // the body is part of the signature, so it is read (small limit) before the check
    let raw;
    try { raw = await readBody(req, url.pathname === "/v1/notes" ? 4096 : rm && rm[2] === "input" ? REMOTE_BODY_MAX : 2048); }
    catch (e) { return json(e.code === 413 ? 413 : 400, { error: e.code === 413 ? "too large" : "bad body" }, { Connection: "close" }); }
    // key mode only with an identity; without one everything below is the v1 behaviour
    const me = myId(), keyMode = !!me, pins = keyMode ? pinnedMap() : new Map();
    // an unpinned key is enough to look (ping, session list) and to introduce itself (hello) — nothing else (§4.4 step 6)
    const allowUnpinned = ["/v1/ping", "/v1/sessions", "/v1/hello"].includes(url.pathname);
    const v = verifyRequest(cfg.token, { method: req.method, host, path: req.url, headers: req.headers, body: raw, ip: remoteIp(req) }, guard, Date.now(), keyMode ? { myKid: me.kid, lookup: k => (pins.get(k) || {}).pubkey || "", allowUnpinned } : null);
    if (sig && (v.ok || v.hmacOk)) sig.keySign = true;
    if (!v.ok) return json(v.error === "busy-ip" ? 429 : v.error === "busy" ? 503 : 401, { error: v.error });
    if (keyMode && v.ver !== 2 && requireKeys()) return json(401, { error: "upgrade required" });
    // who is calling. Key mode: the kid that signed (v2), and the pinned teammate behind it (null: an unpinned key, or
    // v1). v1 mode: the teammate(s) I registered at the caller's address — delegations are matched against their
    // instance ids only, and two registered entries at one address cannot be told apart → no delegation is served to
    // that address at all (every entry at that normalised IP counts, with or without an instance id).
    const pin = keyMode && v.ver === 2 && v.pinned ? pins.get(v.kid) : null;
    const caller = keyMode
      ? { keyMode, ver: v.ver, kid: v.ver === 2 ? v.kid : "", peer: pin ? ((cfg.peers || []).find(p => p && p.name === pin.name) || { name: pin.name, pubkey: pin.pubkey }) : null }
      : (() => { const ip = hostIpv4(remoteIp(req)); const at = ip ? (cfg.peers || []).filter(p => hostIpv4(p.host) === ip) : []; return { keyMode, ids: at.filter(p => p.instanceId).map(p => String(p.instanceId)), ambiguous: at.length > 1 }; })();
    if (url.pathname === "/v1/ping") return req.method === "GET" ? json(200, { at: now(), instanceId: cfg.instanceId || "", ...(me ? { pubkey: me.pub } : {}) }) : json(405, { error: "GET only" });
    if (url.pathname === "/v1/hello") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let b; try { b = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      const port = Number(b && b.port), addr = remoteIp(req), name = b && typeof b.name === "string" ? cleanName(b.name) : "";
      if (!name || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9.]+$/.test(addr)) return json(400, { error: "name, port required" });
      const peer = { name, host: `${addr}:${port}`, instanceId: typeof b.instanceId === "string" && UUID_RE.test(b.instanceId) ? b.instanceId : "" };
      // hello v2 (§4.8): the key in the body must be the one that signed this request (proof of possession)
      if (keyMode && (v.ver === 2 || b.v === 2 || b.pubkey !== undefined)) {
        if (v.ver !== 2 || typeof b.pubkey !== "string" || kidOf(b.pubkey) !== v.kid) return json(401, { error: "key proof failed" });
        let ticketOk = false;
        if (typeof b.ticket === "string" && opts.checkTicket) { try { ticketOk = opts.checkTicket(b.ticket, b.pubkey) === true; } catch { ticketOk = false; } }
        Object.assign(peer, { v: 2, pubkey: b.pubkey, kid: v.kid, ticketOk });
      }
      let r = { ok: true }; try { r = (opts.onHello && opts.onHello(peer)) || r; } catch (e) { r = { ok: false, error: e.message }; }
      return json(r.ok === false ? 500 : 200, { ok: r.ok !== false, ...(r.pending ? { pending: true } : {}), name: cfg.name, instanceId: cfg.instanceId || "", ...(me ? { pubkey: me.pub } : {}) });
    }
    if (url.pathname === "/v1/notes") {
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let body; try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      // the sender is never the body's "from": a key-signed note is from the teammate whose pinned key signed it; an
      // HMAC-only (v1) note from whoever I registered at that IP WITHOUT a pinned key (the port hint picks between two
      // on one PC) — a teammate with a pinned key never sends unsigned, so a v1 note from its IP is refused (§4.5)
      const ip = remoteIp(req), hint = Number(body && body.port);
      let sender = null;
      if (!keyMode) {
        // v1 mode: whoever I registered at that IP (the port hint picks between two on one PC)
        const at = (cfg.peers || []).filter(p => hostIp(p.host) === ip);
        sender = at.find(p => Number(String(p.host).split(":")[1]) === hint) || at[0];
        if (!sender) return json(403, { error: "not a registered teammate" });
      } else if (v.ver === 2) { sender = caller.peer; if (!sender) return json(403, { error: "not a registered teammate" }); }
      else {
        const at = (cfg.peers || []).filter(p => hostIp(p.host) === ip), open = at.filter(p => !pinnedKeyOf(p));
        sender = open.find(p => Number(String(p.host).split(":")[1]) === hint) || open[0];
        if (!sender) return json(403, { error: at.length ? "key required" : "not a registered teammate" });
      }
      const v2 = validateNote({ ...(body && typeof body === "object" ? body : {}), from: sender.name }); if (v2.error) return json(400, { error: v2.error });
      const t = now();
      if (!noteRateCheck(noteTimes, keyMode && v.ver === 2 ? `k:${v.kid}` : ip, t)) return json(429, { error: "too many notes" });
      const note = { id: randomUUID(), at: t, ...v2.note };
      try { opts.onNote && opts.onNote(note); } catch {}
      return json(202, { ok: true, id: note.id });
    }
    if (rm) return remoteRoute(rm[2], req.method, remoteSid, raw, caller, json);
    if (req.method !== "GET") return json(405, { error: "GET only" });
    const snap = getSnapshot() || {};
    const dver = store ? store.changedAt : 0;
    if (cache.snap !== snap || cache.dver !== dver) {
      const body = JSON.stringify(sanitizeSessions(snap.sessions).map(o => { delete o.delegated; if (store && store.isDelegated(o.id)) o.delegated = true; return o; }));
      cache = { snap, dver, body };
    }
    // a delegation's grant goes only to the teammate it was made for (its pinned key signed this request), inside this
    // signed answer; the caller's address plays no part
    const dl = !store ? [] : caller.keyMode ? (caller.peer ? store.forKey(caller.kid) : []) : (!caller.ambiguous ? store.forInstances(caller.ids) : []);
    const dlJson = dl.length ? JSON.stringify(dl) : "";
    // safety status: left out for a caller without a pinned key (v1 mode: an ambiguous caller — same rule as grants),
    // when there is no callback, or on any error
    let sfJson = "";
    if (opts.safety) {
      const t = now();
      if (t - safetyMemo.at >= 1000 || t < safetyMemo.at) {
        let j = ""; try { const sf = sanitizeSafety(opts.safety()); j = sf ? JSON.stringify(sf) : ""; } catch { j = ""; }
        safetyMemo = { at: t, json: j };
      }
      sfJson = safetyMemo.json;
      if (sfJson && sfJson !== safetyLast) { safetyAt = t; safetyLast = sfJson; }
      if (caller.keyMode ? !caller.peer : caller.ambiguous) sfJson = "";
    }
    const etag = `"${createHash("sha1").update(cache.body + "\n" + dlJson + "\n" + sfJson).digest("hex").slice(0, 20)}"`;
    const at = Math.max(Number(snap.at) || 0, dver, safetyAt);
    const since = Number(url.searchParams.get("since")) || 0;
    if ((since && at && since >= at) || req.headers["if-none-match"] === etag) return send(304, "", { ETag: etag });
    return send(200, `{"name":${JSON.stringify(cfg.name)},"at":${at},"instanceId":${JSON.stringify(cfg.instanceId || "")},"sessions":${cache.body}${dlJson ? `,"delegations":${dlJson}` : ""}${sfJson ? `,"safety":${sfJson}` : ""}}`, { "Content-Type": "application/json", ETag: etag });
  });
  // ── phase 3: input / interrupt / last answer for a delegated session ──
  // every action is a POST with the grant in the (signed) body — never in a URL
  async function remoteRoute(action, method, sid, raw, caller, json) {
    const remote = opts.remote || {};
    if (!store) return json(404, { error: "not found" });
    if (method !== "POST") return json(405, { error: "POST only" });
    let body; try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
    if (!body || typeof body !== "object") return json(400, { error: "bad json" });
    let d;
    if (caller.keyMode) {
      // only a teammate whose pinned key signed this request: a grant alone (seen on the wire) opens nothing
      if (!caller.peer) return json(403, { error: caller.ver === 2 ? "not a registered teammate" : "key required" });
      d = store.match(sid, body.grant, caller.kid);
    } else {
      if (!caller.ids.length) return json(403, { error: "not a registered teammate" });
      if (caller.ambiguous) return json(403, { error: "ambiguous teammate" });
      d = store.match(sid, body.grant, caller.ids);
    }
    if (!d) return json(403, { error: "not delegated" });
    // the delegated session by its full local id — exactly one, else it cannot be placed (fail closed)
    const session = resolveDelegatedSession(((getSnapshot() || {}).sessions) || [], d.localId);
    const event = e => { try { remote.event && remote.event({ sessionId: sid, peer: d.peerName, instanceId: d.instanceId, ...(d.kid ? { kid: d.kid } : {}), sessionName: d.name, ...e }); } catch {} };
    if (action === "last") {
      if (!session) return json(409, { error: "busy" });
      let r = null; try { r = remote.last ? await remote.last({ sessionId: sid, delegation: d, session }) : null; } catch { r = null; }
      return json(200, { text: lastText(r && r.text), at: Number(r && r.at) || 0 });
    }
    // read-only screen for the remote terminal view: its own rate budget per session and caller; an unplaceable
    // session or an unreadable screen is "busy" (fail closed). At most one read of a session's screen runs at a time:
    // a request while one is in flight waits for that one, and its result is reused for REMOTE_SCREEN_CACHE_MS (so
    // parallel or repeated requests never start more than one terminal read). Reads are polled, so the log gets one
    // "viewed" entry per session and teammate per REMOTE_SCREEN_LOG_MS — and nothing for a refused read.
    if (action === "screen") {
      const t = now();
      const lk = `${sid}|${d.kid || d.instanceId}`;
      if (!noteRateCheck(screenTimes, lk, t, REMOTE_SCREEN_RATE)) return json(429, { error: "too many requests" });
      if (!session) return json(409, { error: "busy" });
      let c = screenReads.get(sid);
      if (!c || (c.done && !(now() - c.at < REMOTE_SCREEN_CACHE_MS))) {
        if (screenReads.size >= 1000) screenReads.clear();
        const read = { done: false, at: t, p: null };
        read.p = (async () => {
          let r = null; try { r = remote.screen ? await remote.screen({ sessionId: sid, delegation: d, session }) : null; } catch { r = null; }
          read.done = true; read.at = now();
          return r && Array.isArray(r.lines) ? screenLines(r.lines) : null;
        })();
        screenReads.set(sid, c = read);
      }
      const lines = await c.p;
      if (!lines) return json(409, { error: "busy" });
      if (!(t - (screenLogged.get(lk) || -Infinity) < REMOTE_SCREEN_LOG_MS)) {
        if (screenLogged.size >= 1000) screenLogged.clear();
        screenLogged.set(lk, t); event({ kind: "screen", result: "viewed" });
      }
      return json(200, { lines, status: STATUSES.has(session.status) ? session.status : "done", needsInput: session.needsInput === true, ended: session.ended === true, at: t });
    }
    let text = "";
    if (action === "input") { const v = validateRemoteText(body.text); if (v.error) return json(400, { error: v.error }); text = v.text; }
    if (!noteRateCheck(remoteTimes, sid, now(), REMOTE_RATE)) { event({ kind: action, result: "rate", text }); return json(429, { error: "too many requests" }); }
    if (action === "input") {
      let g; try { g = typeof remote.guard === "function" ? remote.guard(text) : isDangerous(text); } catch { g = isDangerous(text); }
      if (!g || typeof g !== "object") g = isDangerous(text);
      if (g.blocked) { event({ kind: "input", result: "blocked", rule: g.rule, ruleLabel: g.label, text }); return json(403, { error: "blocked", rule: g.rule }); }
      // only a session that sits at its prompt: not running, not on a permission / choice prompt, not gone
      // and only while Claude Code still asks before risky tools (a known, safe permission mode)
      const idle = session && session.status === "waiting" && session.needsInput !== true && session.ended !== true && permissionOk(session);
      if (!idle || inflight.has(sid)) { event({ kind: "input", result: "busy", text }); return json(409, { error: "busy" }); }
      inflight.add(sid);
      let r; try { r = remote.input ? await remote.input({ sessionId: sid, delegation: d, session, text }) : { ok: false, error: "no handler" }; } catch (e) { r = { ok: false, error: e.message }; } finally { inflight.delete(sid); }
      if (r && r.busy) { event({ kind: "input", result: "busy", text }); return json(409, { error: "busy" }); }
      event({ kind: "input", result: r && r.ok ? (r.accepted ? "accepted" : "sent") : "error", text, ...(r && !r.ok ? { error: r.error } : {}) });
      return r && r.ok ? json(200, { ok: true, accepted: !!r.accepted }) : json(503, { error: "session terminal unavailable" });
    }
    if (!session) { event({ kind: "interrupt", result: "busy" }); return json(409, { error: "busy" }); }
    let r; try { r = remote.interrupt ? await remote.interrupt({ sessionId: sid, delegation: d, session }) : { ok: false }; } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.unsupported) { event({ kind: "interrupt", result: "unsupported" }); return json(409, { error: "unsupported" }); }
    event({ kind: "interrupt", result: r && r.ok ? "accepted" : "error", ...(r && !r.ok ? { error: r.error } : {}) });
    return r && r.ok ? json(200, { ok: true }) : json(503, { error: "session terminal unavailable" });
  }
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
// auth: the team token (v1, HMAC only) or { token, identity } — with an identity every request is key-signed as well
const authOf = a => a && typeof a === "object" ? { token: String(a.token || ""), identity: a.identity && a.identity.kid && typeof a.identity.sign === "function" ? a.identity : null } : { token: String(a || ""), identity: null };
// one signed round trip, bound to the peer's "ip:port" (signed; fetch sends it as the Host header from the URL). Redirects are never
// followed; a reply is trusted only when its signature (status, host, my ts / nonce, body) checks out.
// Key layer: the reply's X-AD-KSig (over resKeyInput) is checked against the peer's pinned key (pinnedKeyOf(peer)) —
// missing or wrong → not signed ("bad signature"; a valid signature by ANOTHER key → keyError "key changed"), which is
// the no-downgrade rule (§4.5). Without a pinned key a key-signed reply is still checked against its own X-AD-Pub (a
// broken one → not signed) and reported (kid, pubkey) for the user to confirm; peer.expectKid (from a beacon) must
// match it (else keyError "key mismatch"). keyOk = the reply was signed by the pinned key.
// With a plain token (v1 mode) none of this runs: the reply is checked by its HMAC only, as before 0.2.2.
async function signedFetch(peer, auth, method, path, body, { timeoutMs = 2500, headers = {} } = {}) {
  const { token, identity } = authOf(auth);
  const host = String(peer.host).replace(/^https?:\/\//, "");
  const pinned = pinnedKeyOf(peer), pinnedKid = pinned ? kidOf(pinned) : "";
  const s = signRequest(token, method, host, path, body || "", Date.now(), identity ? { identity, targetKid: pinnedKid || "-" } : null);
  const r = await fetch(`http://${host}${path}`, { method, headers: { ...headers, ...s.headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body || undefined, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (r.status >= 300 && r.status < 400 && r.status !== 304) { try { await r.body?.cancel(); } catch {} return { r, text: "", signed: false, redirect: true }; }
  const text = r.status === 304 ? "" : await readCapped(r, RESPONSE_MAX);
  let signed = safeEqual(r.headers.get("x-ad-sig") || "", responseSignature(token, r.status, host, s.ts, s.nonce, text));
  if (!identity) return { r, text, signed, keyMode: false };
  // the key layer of the reply
  const kver = r.headers.get("x-ad-ver"), kkid = r.headers.get("x-ad-kid") || "", kpub = r.headers.get("x-ad-pub") || "", ksig = r.headers.get("x-ad-ksig") || "";
  const input = kid => resKeyInput({ status: r.status, host, ts: s.ts, nonce: s.nonce, body: text, serverKid: kid, callerKid: identity ? identity.kid : "-", tag: teamTag(token) });
  let kid = "", pubkey = "", keyOk = false, keyError = "";
  const present = kver !== null || !!ksig;
  const selfOk = present && kver === "2" && KID_RE.test(kkid) && kidOf(kpub) === kkid && verifyKey(kpub, input(kkid), ksig);
  if (selfOk) { kid = kkid; pubkey = kpub; }
  if (pinned) {
    keyOk = signed && present && kver === "2" && kkid === pinnedKid && verifyKey(pinned, input(pinnedKid), ksig);
    if (!keyOk) { if (signed && selfOk && kid !== pinnedKid) keyError = "key changed"; signed = false; }
  } else if (present && !selfOk) signed = false;
  if (signed && !pinned && peer.expectKid && kid !== peer.expectKid) { keyError = "key mismatch"; signed = false; }
  return { r, text, signed, kid, pubkey, keyOk, keyError, keyMode: true };
}
const parseJson = t => { try { return JSON.parse(t); } catch { return {}; } };
// a 401 is "token mismatch" unless the (verifiable) reply says why
const authError = (signed, text) => (signed && parseJson(text).error) || "token mismatch";
const uuidOr = v => typeof v === "string" && UUID_RE.test(v) ? v : "";
// what the key layer said about a reply: kid / pubkey (a valid key signature, pinned or not), keyOk (by the pinned key)
// (key mode only: a v1-mode answer has exactly the fields it had before 0.2.2)
const keyInfo = f => f.keyMode ? { kid: f.kid || "", pubkey: f.pubkey || "", keyOk: !!f.keyOk } : {};
// token: the team token or { token, identity } (see authOf); the peer's pinned key / expectKid come from the peer entry.
// opts: number (timeout, phase 1) or { timeoutMs, etag, since }. A 304 comes back as { ok: true, notModified: true }.
// Every answer carries kid / pubkey / keyOk; a key failure is error "bad signature" | "key changed" | "key mismatch".
export async function fetchPeer(peer, token, opts = {}) {
  const o = typeof opts === "number" ? { timeoutMs: opts } : (opts || {});
  const t0 = Date.now();
  try {
    const f = await signedFetch(peer, token, "GET", `/v1/sessions${o.since ? `?since=${Number(o.since)}` : ""}`, "", { timeoutMs: o.timeoutMs || 2500, headers: o.etag ? { "If-None-Match": o.etag } : {} });
    const { r, text, signed, redirect } = f;
    const rtt = Date.now() - t0;
    if (redirect) return { name: peer.name, ok: false, rtt, error: "redirect refused" };
    if (r.status === 401) return { name: peer.name, ok: false, rtt, error: f.keyError || authError(signed, text), ...keyInfo(f) };
    if (!signed) return { name: peer.name, ok: false, rtt, error: f.keyError || "bad signature", ...keyInfo(f) };
    if (r.status === 304) return { name: peer.name, ok: true, notModified: true, at: Date.now(), rtt, etag: r.headers.get("etag") || o.etag || "", ...keyInfo(f) };
    if (!r.ok) return { name: peer.name, ok: false, rtt, error: `HTTP ${r.status}`, ...keyInfo(f) };
    const d = parseJson(text);
    return { name: peer.name, ok: true, at: Date.now(), rtt, etag: r.headers.get("etag") || "", theirAt: Number(d.at) || 0, remoteName: cleanName(d.name || ""), instanceId: uuidOr(d.instanceId), sessions: sanitizeSessions(d.sessions), delegations: sanitizeDelegations(d.delegations), safety: sanitizeSafety(d.safety) || undefined, ...keyInfo(f) };
  } catch (e) {
    return { name: peer.name, ok: false, error: errText(e) };
  }
}

export async function postNote(peer, token, note, timeoutMs = 4000) {
  try {
    const { r, text, signed, redirect, keyError, keyMode } = await signedFetch(peer, token, "POST", "/v1/notes", JSON.stringify(note), { timeoutMs });
    if (redirect) return { ok: false, error: "redirect refused" };
    if (r.status === 401) return { ok: false, status: 401, error: keyError || authError(signed, text) };
    if (!signed) return { ok: false, status: r.status, error: keyError || "bad signature" };
    if (r.ok) return { ok: true };
    const e = parseJson(text).error;
    return { ok: false, status: r.status, error: r.status === 429 ? "too many notes" : r.status === 403 ? (keyMode && e === "key required" ? "key required" : "not registered on their side") : e || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

// sessions a teammate delegated to me (from their signed answer): only well-formed entries, at most 50
export function sanitizeDelegations(list) {
  return (Array.isArray(list) ? list : []).filter(x => x && typeof x === "object" && typeof x.sessionId === "string" && typeof x.grant === "string" && GRANT_RE.test(x.grant)).slice(0, 50)
    .map(x => ({ sessionId: publicSessionId(x.sessionId), grant: x.grant, name: text(x.name, 120), repo: text(x.repo, 120), branch: text(x.branch, 120) })).filter(x => x.sessionId);
}
// ── phase 3 client: act on a session a teammate delegated to me (grant from their /v1/sessions answer) ──
const remotePath = (sessionId, action) => `/v1/sessions/${encodeURIComponent(publicSessionId(sessionId))}/${action}`;
async function remoteCall(peer, token, method, path, body, timeoutMs) {
  try {
    const { r, text: t, signed, redirect, keyError } = await signedFetch(peer, token, method, path, body, { timeoutMs });
    if (redirect) return { ok: false, error: "redirect refused" };
    if (r.status === 401) return { ok: false, status: 401, error: keyError || authError(signed, t) };
    if (!signed) return { ok: false, status: r.status, error: keyError || "bad signature" };
    const d = parseJson(t);
    if (r.ok) return { ok: true, status: r.status, d };
    return { ok: false, status: r.status, error: typeof d.error === "string" ? clean(d.error, 80) : `HTTP ${r.status}`, ...(typeof d.rule === "string" ? { rule: clean(d.rule, 40) } : {}) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
// input waits for the owner's terminal to take the text (up to ~20 s on their side)
export async function remoteInput(peer, token, sessionId, grant, text, timeoutMs = 30000) {
  const r = await remoteCall(peer, token, "POST", remotePath(sessionId, "input"), JSON.stringify({ grant, text }), timeoutMs);
  return r.ok ? { ok: true, accepted: !!r.d.accepted } : r;
}
export async function remoteInterrupt(peer, token, sessionId, grant, timeoutMs = 15000) {
  const r = await remoteCall(peer, token, "POST", remotePath(sessionId, "interrupt"), JSON.stringify({ grant }), timeoutMs);
  return r.ok ? { ok: true } : r;
}
export async function remoteLast(peer, token, sessionId, grant, timeoutMs = 15000) {
  const r = await remoteCall(peer, token, "POST", remotePath(sessionId, "last"), JSON.stringify({ grant }), timeoutMs);
  return r.ok ? { ok: true, text: lastText(r.d.text), at: Number(r.d.at) || 0 } : r;
}
// the remote terminal view: the delegated session's screen (masked again on the way in) and its status
export async function remoteScreen(peer, token, sessionId, grant, timeoutMs = 5000) {
  const r = await remoteCall(peer, token, "POST", remotePath(sessionId, "screen"), JSON.stringify({ grant }), timeoutMs);
  return r.ok ? { ok: true, lines: screenLines(r.d.lines), status: STATUSES.has(r.d.status) ? r.d.status : "done", needsInput: r.d.needsInput === true, ended: r.d.ended === true, at: Number(r.d.at) || 0 } : r;
}

// me: { name, port, instanceId, ticket? }. With an identity (token = { token, identity }) this is hello v2: the body
// carries my pubkey (the request is signed by it: proof of possession) and, after joining with an invite code, the
// proof that I hold its join ticket. The answer carries the other side's pubkey / kid (key-checked like any reply).
export async function postHello(peer, token, me, timeoutMs = 4000) {
  try {
    const { identity } = authOf(token);
    const body = identity
      ? { v: 2, name: me.name, port: me.port, instanceId: me.instanceId || "", pubkey: identity.pub, ...(typeof me.ticket === "string" && me.ticket ? { ticket: ticketProof(me.ticket, identity.pub) } : {}) }
      : { name: me.name, port: me.port, instanceId: me.instanceId || "" };
    const f = await signedFetch(peer, token, "POST", "/v1/hello", JSON.stringify(body), { timeoutMs });
    const { r, text, signed, redirect, keyError } = f;
    if (redirect) return { ok: false, error: "redirect refused" };
    if (r.status === 401) return { ok: false, status: 401, error: keyError || authError(signed, text) };
    if (!signed) return { ok: false, status: r.status, error: keyError || "bad signature" };
    const d = parseJson(text);
    return r.ok ? { ok: true, pending: !!d.pending, name: cleanName(d.name || ""), instanceId: uuidOr(d.instanceId), ...keyInfo(f) } : { ok: false, status: r.status, error: d.error || `HTTP ${r.status}` };
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
// signed ping: an AgentDesk of my team is answering at this address → { ok, instanceId } (+ pubkey / kid / keyOk when
// it answered key-signed; the body's pubkey must be the key that signed the answer)
export async function pingPeerSigned(peer, token, timeoutMs = 2500) {
  try {
    const f = await signedFetch(peer, token, "GET", "/v1/ping", "", { timeoutMs });
    const { r, text, signed, redirect } = f;
    if (redirect || !signed || r.status !== 200) return { ok: false, error: redirect ? "redirect refused" : !signed ? f.keyError || "bad signature" : `HTTP ${r.status}` };
    const d = parseJson(text);
    if (f.keyMode && d.pubkey !== undefined && d.pubkey !== f.pubkey) return { ok: false, error: "bad signature" };
    return { ok: true, instanceId: uuidOr(d.instanceId), ...(f.kid ? keyInfo(f) : {}) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
// v1 only (an entry without a pinned key; to be removed in 0.2.3): a teammate with a pinned key that greets from a new
// address is the same person (upsertPeer → "moved"), no race needed.
// a hello says "instance X moved from oldHost to a new address". If X (or an AgentDesk of my team that does not say
// who it is) still answers a signed ping at oldHost, the old address is alive → "reject" (someone else claims X).
// Only when the old address is silent (or now answers as a different instance) is it a real move → "pending".
export async function classifyMove({ oldHost, instanceId }, token, ping = pingPeerSigned) {
  const r = await ping({ name: "old", host: oldHost }, token);
  if (r.ok && (!r.instanceId || !instanceId || r.instanceId === instanceId)) return "reject";
  return "pending";
}
