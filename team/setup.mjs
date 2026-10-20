// First-run setup helpers (pure, testable without Electron): the team.json a fresh install writes for itself,
// this PC's office-network address, and how to run a Node script on a PC that has no Node.js installed.
import { networkInterfaces, userInfo, hostname } from "node:os";
import { existsSync } from "node:fs";

// a fresh install joins no team and shows nothing to the network: empty token, no peers, listening on 127.0.0.1 only,
// no beacon. "Create our team" / "join with an invite code" switch to 0.0.0.0 + discovery after the user confirms.
export function defaultTeamConfig({ name, instanceId }) {
  return { name, token: "", port: 7331, bind: "127.0.0.1", discovery: false, instanceId, peers: [] };
}
// the fields that make this PC visible on the office network (team create / join) — and the ones that hide it again
export const SHARE_ON = { bind: "0.0.0.0", discovery: true };
export const SHARE_OFF = { bind: "127.0.0.1", discovery: false };
export function defaultName() {
  let n = ""; try { n = userInfo().username; } catch {}
  if (!n) n = String(hostname() || "").split(".")[0];
  return (n || "me").replace(/[^\w.-]/g, "").slice(0, 40) || "me";
}
// first non-internal IPv4 (en0 / eth0 first), "" when offline
export function lanAddress(ifaces = networkInterfaces()) {
  const names = Object.keys(ifaces || {}).sort((a, b) => (/^(en0|eth0)$/.test(b) ? 1 : 0) - (/^(en0|eth0)$/.test(a) ? 1 : 0));
  for (const n of names) for (const i of ifaces[n] || []) if ((i.family === "IPv4" || i.family === 4) && !i.internal && i.address) return i.address;
  return "";
}
// Node for helper scripts (recall, briefing, Slack bridge): a system node when there is one, else this app's own
// binary in Node mode (ELECTRON_RUN_AS_NODE=1), so a teammate's PC needs no Node.js install
export const NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
export function nodeRunner(execPath, exists = existsSync, candidates = NODE_CANDIDATES) {
  const sys = candidates.find(p => exists(p));
  return sys ? { cmd: sys, env: { ELECTRON_RUN_AS_NODE: "1" }, system: true } : { cmd: execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, system: false };
}
