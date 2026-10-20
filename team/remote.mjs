// Team sharing phase 3: per-session delegation ("remote input"). Pure helpers, testable without Electron or a network.
//   createDelegationStore()  → the owner's in-memory list of (session, teammate) pairs, each with its own random grant.
//                              Never written to disk: an app restart drops every delegation.
//   validateRemoteText(text) → { text } (one line, ≤ REMOTE_TEXT_MAX) | { error }
//   remoteMessage(from, t)   → "[원격 · will — 주인 확인 없이 파괴적 작업(…) 금지] t" — what is typed into the session
//   createRemoteLog(file)    → ~/.agentdesk/team-remote.jsonl (0600, append, last REMOTE_LOG_MAX lines kept)
//   createEventThrottle()    → rate / busy / blocked events folded to one per session and result a minute
//   resolveDelegatedSession(sessions, localId) → the one session with exactly that local id, else null (fail closed)
//   screenAllowsInput(tail)  → the Claude Code screen sits at an empty prompt (no choice / permission prompt, no turn)
//   canDelegate(...)         → why a session may not be delegated to a teammate ("" when it may)
//   autoRevokeReasons(...)   → which delegations end now and why (session gone, teammate removed / ambiguous /
//                              identity mismatch / unreachable)
//   remoteInterruptAllowed(h) → Esc is only sent where it cannot reach another app (tmux, Orca — not Terminal.app tabs)
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isIPv4 } from "node:net";
import "../core/mask.js";
import "../core/team.js";
import "../core/status.js";
const { mask } = globalThis.AgentDeskMask;
const { clean, publicSessionId } = globalThis.AgentDeskTeam;
const { screenHasChoice, statusFromScreen } = globalThis.AgentDeskStatus;

export const REMOTE_LOG = join(homedir(), ".agentdesk", "team-remote.jsonl");
export const REMOTE_TEXT_MAX = 4000;
export const REMOTE_RATE = 20;          // inputs + interrupts per minute per session
export const REMOTE_LAST_MAX = 8000;
export const REMOTE_LOG_MAX = 2000;
export const GRANT_RE = /^[0-9a-f]{48}$/;
export const REMOTE_TTL_MS = 2 * 3600 * 1000;   // a delegation lasts 2 hours unless the owner extends it
// Claude Code permission modes that still ask before risky tools. Anything else — bypassPermissions, or a mode we
// have not heard (no hooks, no event yet) — is treated as "checks off": no delegation, no remote input.
export const SAFE_MODES = new Set(["default", "plan", "acceptEdits"]);
export const permissionOk = s => SAFE_MODES.has(String((s && s.permissionMode) || ""));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  // equal-length buffers only reach timingSafeEqual; a length mismatch is a plain "no"
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

// invisible format characters (zero-width, bidi marks) are removed as well: what the owner sees in the log is what was typed
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
export function validateRemoteText(text) {
  if (typeof text !== "string") return { error: "text is required" };
  if (text.length > REMOTE_TEXT_MAX * 4) return { error: `text over ${REMOTE_TEXT_MAX} characters` };
  // a trailing "\" (line continuation, one or more) goes too
  const t = clean(text.replace(INVISIBLE, "")).replace(/[\s\\]+$/, "");
  if (!t) return { error: "text is required" };
  if ([...t].length > REMOTE_TEXT_MAX) return { error: `text over ${REMOTE_TEXT_MAX} characters` };
  return { text: t };
}
// the prefix also means the line never starts with "/" (slash command) or "!" (Claude Code's shell mode), and tells the
// agent who is typing and what it must not do without its owner
export const remoteMessage = (from, text) => `[원격 · ${clean(from, 40) || "?"} — 주인 확인 없이 파괴적 작업(삭제·force push·운영 DB 변경) 금지] ${text}`;

// exactly one snapshot session with this full local id — two (or none) means the delegation cannot be placed: refuse
export function resolveDelegatedSession(sessions, localId) {
  if (!localId) return null;
  const hits = (Array.isArray(sessions) ? sessions : []).filter(s => s && s.id === localId);
  return hits.length === 1 ? hits[0] : null;
}
// the last look before typing: a readable screen, no numbered choice (permission / question) on it, the turn over
// ("waiting", or "waiting-untimed": a finished ⏺ block without a "done" line), and nothing typed at the ❯ prompt yet —
// otherwise the remote text would be merged into the owner's draft. Anything unreadable → false.
// `opts.anyTurn` (the owner's own review comments): a running turn is fine (Claude Code queues the message) and the
// bypass-permissions footer does not matter — still no choice prompt, and an empty ❯ prompt (no draft) must be visible
export function screenAllowsInput(tail, opts) {
  if (!Array.isArray(tail) || !tail.length) return false;
  const lines = tail.map(l => String(l ?? ""));
  if (screenHasChoice(lines)) return false;
  if (!(opts && opts.anyTurn)) {
    if (lines.some(l => /bypass permissions on/i.test(l))) return false;   // Claude Code's footer while checks are off
    const st = statusFromScreen(lines);
    if (st !== "waiting" && st !== "waiting-untimed") return false;
  }
  for (let i = lines.length - 1; i >= 0; i--) { const t = lines[i].trim(); if (/^❯/.test(t)) return t.slice(1).trim() === ""; }
  return false;
}
export const remoteInterruptAllowed = h => typeof h === "string" && !!h && !h.startsWith("term:");
// "ip:port" → the IPv4 address normalised ("010.0.0.5" → "10.0.0.5"); null for a host name or anything else
export function hostIpv4(h) {
  const ip = String(h || "").replace(/^https?:\/\//, "").split(":")[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const norm = ip.split(".").map(o => String(parseInt(o, 10))).join(".");
  return isIPv4(norm) ? norm : null;
}
const sameIp = (a, b) => { const x = hostIpv4(a), y = hostIpv4(b); return !!x && x === y; };
const prefix24 = h => { const ip = hostIpv4(h); return ip ? ip.split(".").slice(0, 3).join(".") : null; };
// owner-side check before a delegation is made. peer: the team.json entry; peers: all of them; state: its poll state;
// session: the snapshot session (full local id)
export function canDelegate({ peer, peers, state, session }) {
  if (!peer || !peer.instanceId) return "unknown teammate";
  if (!hostIpv4(peer.host)) return "teammate address is not an IP";
  if (!state || !state.ok || state.mismatch || state.offnet) return "teammate not connected";
  const others = (peers || []).filter(p => p !== peer && p.name !== peer.name);
  if (others.some(p => sameIp(p.host, peer.host))) return "another teammate shares this address";
  // an entry that cannot be pinned to one address next to the target (a host name, or no instance id on its /24)
  if (others.some(p => !hostIpv4(p.host) || (!p.instanceId && prefix24(p.host) === prefix24(peer.host)))) return "an unidentified teammate is on the same network";
  if (!session || session.ended) return "unknown session";
  if (session.agent !== "claude") return "Claude Code sessions only";
  if (!permissionOk(session)) return "permission checks off/unknown";
  if (!session.handle) return "no terminal";
  return "";
}
// which delegations must end now. ctx: { sessions (snapshot), peers (team.json), stateOf(name) → poll state, now }
export function autoRevokeReasons(list, { sessions, peers, stateOf, now = Date.now() }) {
  const out = [];
  for (const d of list || []) {
    const peer = (peers || []).find(p => p.instanceId === d.instanceId);
    let reason = "";
    if (d.expiresAt && now >= d.expiresAt) reason = "expired";
    else if (!peer) reason = "teammate removed";
    else if ((peers || []).some(p => p !== peer && sameIp(p.host, peer.host))) reason = "ambiguous teammate";
    else {
      const st = stateOf ? stateOf(peer.name) : null;
      if (st && st.mismatch) reason = "identity mismatch";
      else if (st && st.offnet) reason = "teammate on another network";
      else if (st && !st.ok && (st.fails || 0) >= 3 && (!st.lastOk || now - st.lastOk > 120000)) reason = "teammate unreachable";
    }
    if (!reason && sessions) {
      const s = resolveDelegatedSession(sessions, d.localId);
      if (!s || s.ended) reason = "session ended";
      else if (!permissionOk(s)) reason = "permission checks off/unknown";   // e.g. switched to bypass with shift+tab
    }
    if (reason) out.push({ ...d, reason });
  }
  return out;
}
// rate / busy / blocked repeat quickly: the first of each (session, result) in a minute is passed on (with how many
// were folded into it since), the rest are dropped
export function createEventThrottle({ windowMs = 60000, now = Date.now } = {}) {
  const seen = new Map();
  return {
    pass(e) {
      if (!["rate", "busy", "blocked"].includes(e && e.result)) return e;
      const k = `${e.sessionId}|${e.result}`, t = now(), prev = seen.get(k);
      if (prev && t - prev.at < windowMs) { prev.folded++; return null; }
      if (seen.size >= 1000) seen.clear();
      seen.set(k, { at: t, folded: 0 });
      return prev && prev.folded ? { ...e, folded: prev.folded } : e;
    },
  };
}

// key: `${sessionId}|${instanceId}`. changedAt moves on every change, so the /v1/sessions answer (and its ETag) does too.
export function createDelegationStore({ now = Date.now, ttlMs = REMOTE_TTL_MS } = {}) {
  const items = new Map();
  let changedAt = 0;
  const touch = () => { changedAt = Math.max(now(), changedAt + 1); };
  // localId (the full local session id) stays on this PC: it is in the owner's own views, never in what a teammate gets
  const pub = d => ({ sessionId: d.sessionId, localId: d.localId, instanceId: d.instanceId, peerName: d.peerName, name: d.name, repo: d.repo, branch: d.branch, at: d.at, expiresAt: d.expiresAt });
  const live = d => !d.expiresAt || now() < d.expiresAt;
  return {
    // returns the new (or existing) delegation; the grant stays inside this store and the signed answer to that teammate
    add({ localId, instanceId, peerName, name = "", repo = "", branch = "" }) {
      const lid = String(localId || ""), iid = String(instanceId || "");
      if (!lid || !iid) throw new Error("session and teammate are required");
      const sid = publicSessionId(lid), key = `${sid}|${iid}`;
      if (items.has(key)) return pub(items.get(key));
      const d = { sessionId: sid, localId: lid, instanceId: iid, peerName: clean(peerName, 40), name: clean(name, 120), repo: clean(repo, 120), branch: clean(branch, 120), grant: randomBytes(24).toString("hex"), at: now(), expiresAt: now() + ttlMs };
      items.set(key, d); touch();
      return pub(d);
    },
    // removes every delegation fn(d) says yes to; returns the removed ones (public fields)
    removeWhere(fn) {
      const out = [];
      for (const [k, d] of items) if (fn(d)) { items.delete(k); out.push(pub(d)); }
      if (out.length) touch();
      return out;
    },
    // owner only (IPC from the owner's page): another ttl from now
    extend(localId, instanceId) {
      const d = [...items.values()].find(x => x.localId === localId && x.instanceId === instanceId);
      if (!d) return null;
      d.expiresAt = now() + ttlMs;
      return pub(d);
    },
    remove(localId, instanceId) { return this.removeWhere(d => d.localId === localId && (!instanceId || d.instanceId === instanceId)); },
    clear() { return this.removeWhere(() => true); },
    list() { return [...items.values()].map(pub); },
    isDelegated(sessionId) { for (const d of items.values()) if (d.sessionId === sessionId) return true; return false; },
    // what goes into the signed /v1/sessions answer for the teammate(s) registered at the caller's address
    forInstances(ids) {
      const set = new Set((ids || []).filter(Boolean));
      return [...items.values()].filter(d => set.has(d.instanceId) && live(d)).map(d => ({ sessionId: d.sessionId, grant: d.grant, name: d.name, repo: d.repo, branch: d.branch }));
    },
    // the delegation this grant opens, if it belongs to this session and to a teammate at the caller's address
    match(sessionId, grant, ids) {
      if (typeof grant !== "string" || !GRANT_RE.test(grant)) return null;
      const set = new Set((ids || []).filter(Boolean));
      let hit = null;
      for (const d of items.values()) if (d.sessionId === sessionId && set.has(d.instanceId) && live(d) && safeEq(d.grant, grant)) hit = d;
      return hit ? { ...pub(hit) } : null;
    },
    get changedAt() { return changedAt; },
    get size() { return items.size; },
  };
}

// one JSON object per line; text fields masked and cut to 200 characters; the file and its folder private to this user
// appends are cheap; the file is rewritten (to the last `max` lines) only when it has grown a tenth past `max`
export function createRemoteLog(file = REMOTE_LOG, { max = REMOTE_LOG_MAX } = {}) {
  const slack = Math.max(1, Math.ceil(max / 10));
  let lines = [];
  try { lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-max); } catch {}
  const prepare = () => { const d = dirname(file); mkdirSync(d, { recursive: true, mode: 0o700 }); try { chmodSync(d, 0o700); } catch {} };
  const rewrite = () => {
    prepare();
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, file); try { chmodSync(file, 0o600); } catch {}
  };
  const parse = l => { try { return JSON.parse(l); } catch { return null; } };
  return {
    append(entry) {
      const e = { at: Date.now(), ...entry };
      for (const k of ["text", "sessionName", "peer", "rule", "error"]) if (e[k] != null) e[k] = clean(mask(String(e[k]).slice(0, 800)), 200);
      const line = JSON.stringify(e);
      lines.push(line);
      try {
        prepare(); const fresh = !existsSync(file); appendFileSync(file, line + "\n", { mode: 0o600 }); if (fresh) chmodSync(file, 0o600);
        if (lines.length > max + slack) { lines = lines.slice(-max); rewrite(); }
      } catch {}
      return e;
    },
    recent(n = 200, filter) { const out = []; for (let i = lines.length - 1; i >= 0 && out.length < n; i--) { const e = parse(lines[i]); if (e && (!filter || filter(e))) out.push(e); } return out; },
    get file() { return file; },
    get size() { return lines.length; },
  };
}
