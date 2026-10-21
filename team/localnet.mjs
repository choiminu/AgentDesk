// macOS Local Network privacy: an app without the "Local Network" permission gets EHOSTUNREACH ("No route to host")
// on every outbound connection to the LAN, while Apple tools (nc, curl) reach the same host. Inbound connections to
// our own server still work, so teammates see me and I see nobody. The permission cannot be granted from code: we can
// only make macOS ask at the right moment (one connection right after create / join), recognise a denial, point to
// the right Settings pane and recover as soon as a connection gets through.
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { sameSubnet, myPrefixes } from "./peer.mjs";

export const LOCAL_NETWORK_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";
export const PRIVACY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy";
const NO_ROUTE = new Set(["EHOSTUNREACH", "ENETUNREACH"]);
const ipOf = host => String(host || "").replace(/^https?:\/\//, "").split(":")[0];

// one failed connection: a no-route error to an address on one of my own /24s (which the OS can always reach
// directly) is what a Local Network denial looks like. Darwin only; loopback is never affected.
export function isLocalNetworkDenied(error, host, { platform = process.platform, ifaces = networkInterfaces() } = {}) {
  if (platform !== "darwin") return false;
  const code = typeof error === "string" ? error : error && (error.code || (error.cause && error.cause.code)) || "";
  if (!NO_ROUTE.has(code)) return false;
  if (ipOf(host).startsWith("127.")) return false;
  return sameSubnet(host, ifaces);
}

const isLoopback = host => { const ip = ipOf(host); return ip.startsWith("127.") || ip === "localhost"; };
// a set of LAN attempts ({ host, ok, error }) → "ok" (something got through: permission is there), "denied" (every
// attempt failed the denial way), "unknown" (no attempt, or timeouts / other errors that prove nothing). Loopback
// attempts (a teammate on this PC) prove nothing either way — the permission never applies to them — so they are left out.
export function localNetworkVerdict(results, opts = {}) {
  const list = (results || []).filter(r => r && !isLoopback(r.host));
  if (list.some(r => r.ok)) return "ok";
  if (!list.length || (opts.platform || process.platform) !== "darwin") return "unknown";
  return list.every(r => isLocalNetworkDenied(r.error, r.host, opts)) ? "denied" : "unknown";
}

// one teamPoll round ([{ p: peer, r: fetchPeer result }]) → the verdict over its attempts
export const pollVerdict = (results, opts = {}) => localNetworkVerdict((results || []).map(({ r, p }) => ({ host: p && p.host, ok: !!(r && r.ok), error: r && r.error })), opts);

// the remembered state only changes on evidence ("unknown" keeps it)
export const nextLocalNetwork = (prev, verdict) => verdict === "ok" || verdict === "denied" ? verdict : (prev || "unknown");

// "gateway: 192.168.0.1" out of `route -n get default`
export function parseGateway(text) {
  const m = /^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(String(text || ""));
  return m ? m[1] : "";
}

// where to knock: a known teammate on my /24, then the default gateway (if on my /24), else <my /24>.1 — at most 2
export function localProbeTargets(peers, gateway, ifaces = networkInterfaces()) {
  const out = [];
  const peer = (peers || []).find(p => p && p.host && !ipOf(p.host).startsWith("127.") && sameSubnet(p.host, ifaces));
  if (peer) out.push(peer.host.includes(":") ? peer.host : `${peer.host}:80`);
  const gw = gateway && sameSubnet(gateway, ifaces) ? gateway : (myPrefixes(ifaces)[0] ? `${myPrefixes(ifaces)[0]}.1` : "");
  if (gw && !out.some(h => ipOf(h) === gw)) out.push(`${gw}:80`);
  return out.slice(0, 2);
}

// one TCP connect, closed right away (nothing is sent). Connected or refused = the packet got through; a timeout
// too (a router that drops the port): the SYN left this Mac, while a denial fails at once with EHOSTUNREACH.
export function probeLan(host, timeoutMs = 1500, { connectFn = connect } = {}) {
  return new Promise(resolve => {
    const [h, p] = String(host).split(":");
    let done = false;
    const s = connectFn({ host: h, port: Number(p) || 80 });
    const finish = (ok, error) => { if (done) return; done = true; s.destroy(); resolve({ host, ok, error }); };
    s.setTimeout(timeoutMs, () => finish(true, "timeout"));
    s.once("connect", () => finish(true, ""));
    s.once("error", e => finish(e.code === "ECONNREFUSED" || e.code === "ECONNRESET", e.code || e.message));
  });
}

// the default gateway, from `route -n get default`; the answer is kept for GATEWAY_TTL_MS or until my IPv4 addresses
// change, so the 5 s probe while denied does not spawn a process each time
export const GATEWAY_TTL_MS = 60000;
const routeGetDefault = () => new Promise(resolve => execFile("/sbin/route", ["-n", "get", "default"], { timeout: 2000 }, (err, out) => resolve(err ? "" : parseGateway(out))));
const ifaceKey = ifaces => Object.values(ifaces || {}).flat().filter(i => i && (i.family === "IPv4" || i.family === 4) && !i.internal).map(i => i.address).sort().join(",");
let gatewayCache = null;   // { key, at, p }
export function defaultGateway({ platform = process.platform, ifaces = networkInterfaces(), now = Date.now(), run = routeGetDefault } = {}) {
  if (platform !== "darwin") return Promise.resolve("");
  const key = ifaceKey(ifaces);
  if (gatewayCache && gatewayCache.key === key && now - gatewayCache.at < GATEWAY_TTL_MS) return gatewayCache.p;
  const c = gatewayCache = { key, at: now, p: Promise.resolve(run()).catch(() => "") };
  return c.p;
}
export const resetGatewayCache = () => { gatewayCache = null; };
