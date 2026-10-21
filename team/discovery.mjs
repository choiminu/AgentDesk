// Team sharing (phase 2): find teammates on the office network with a UDP broadcast beacon.
// Every 5 s each AgentDesk sends {app, v, name, port, id} to 255.255.255.255 and each interface's subnet broadcast
// on UDP 7332 and listens on the same port. A heard beacon is only *offered* to the user ("found: will @ 10.0.0.5");
// nothing connects automatically. The beacon never carries the token — only a display name, the HTTP port and the
// instance id (a random uuid from team.json), and (0.2.2) optionally the key id of this PC's Ed25519 key. The beacon is
// not authenticated: a heard kid is only an expectation (expectKid) that the first signed reply must meet. Older
// parsers ignore the extra field.
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const BEACON_PORT = 7332;
export const NAME_RE = /^[\w.\-가-힣 ]{1,40}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BEACON_APP = "agentdesk";
export const KID_RE = /^[A-Za-z0-9_-]{43}$/;

export function encodeBeacon({ name, port, id, kid }) {
  return Buffer.from(JSON.stringify({ app: BEACON_APP, v: 1, name: String(name || "").slice(0, 40), port: Number(port) || 0, id: String(id || "").slice(0, 64), ...(typeof kid === "string" && KID_RE.test(kid) ? { kid } : {}) }));
}
// rinfo.address is where the packet came from — the host part of the teammate's address
export function parseBeacon(buf, rinfo) {
  if (!buf || buf.length > 512) return null;
  let m; try { m = JSON.parse(buf.toString("utf-8")); } catch { return null; }
  if (!m || m.app !== BEACON_APP || m.v !== 1) return null;
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // anyone on the LAN can send a beacon: only a plain display name and a uuid get through to the UI
  if (typeof m.name !== "string" || !NAME_RE.test(m.name) || !m.name.trim() || typeof m.id !== "string" || !UUID_RE.test(m.id)) return null;
  const addr = rinfo && rinfo.address ? String(rinfo.address).replace(/^::ffff:/, "") : "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return null;
  return { name: m.name.trim(), host: `${addr}:${port}`, id: m.id.toLowerCase(), ...(typeof m.kid === "string" && KID_RE.test(m.kid) ? { kid: m.kid } : {}), at: Date.now() };   // kid: optional, a malformed one is left out (the rest is parsed as before 0.2.2)
}
// 255.255.255.255 plus each IPv4 interface's directed broadcast (some routers drop the limited one)
export function broadcastAddresses(ifaces = networkInterfaces()) {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(ifaces || {})) for (const i of list || []) {
    if (i.family !== "IPv4" && i.family !== 4) continue;
    if (i.internal || !i.netmask) continue;
    const a = i.address.split(".").map(Number), m = i.netmask.split(".").map(Number);
    out.add(a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join("."));
  }
  return [...out];
}

// opts: { name, port, id, kid?, bindPort = 7332, bindAddress, targets: [{address, port}] (default: broadcasts on 7332),
//         intervalMs = 5000, onPeer(peer), onError(err) }  → { stop(), announce() }
export function startDiscovery(opts) {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  let timer = null, closed = false;
  const targets = () => opts.targets || broadcastAddresses().map(address => ({ address, port: BEACON_PORT }));
  const announce = () => {
    if (closed) return;
    const msg = encodeBeacon(opts);
    for (const t of targets()) sock.send(msg, t.port, t.address, () => {});
  };
  sock.on("message", (buf, rinfo) => {
    const p = parseBeacon(buf, rinfo);
    if (p && p.id !== opts.id && opts.onPeer) opts.onPeer(p);
  });
  sock.on("error", e => { if (opts.onError) opts.onError(e); });
  sock.bind(opts.bindPort ?? BEACON_PORT, opts.bindAddress, () => {
    try { sock.setBroadcast(true); } catch {}
    announce();
    timer = setInterval(announce, opts.intervalMs || 5000);
  });
  return {
    announce,
    address: () => sock.address(),
    stop() { closed = true; if (timer) clearInterval(timer); try { sock.close(); } catch {} },
    ready: new Promise(r => sock.once("listening", r)),
  };
}
