// Team sharing: this PC's Ed25519 identity (one key pair per PC) and the key layer of the request / response signatures.
//   loadOrCreateIdentity({ file, safeStorage }) → { ok: true, identity, created, encrypted } | { ok: false, reason }
//       ~/.agentdesk/team-key (0600, folder 0700): { v: 1, alg: "ed25519", pub, enc: "safeStorage" | "plain", priv }
//       priv = base64(PKCS8 DER), encrypted with Electron's safeStorage when it is available. A key file that exists
//       but cannot be read / decrypted is NEVER replaced here (that would silently change who this PC is): the caller
//       shows the identity as unusable and works like an older version until the user asks for a new key
//       (regenerateIdentity({ confirmed: true })).
//   identity = { kid, pub, sign(input) → base64url signature } — the private key lives only in this module's closure;
//       JSON.stringify(identity) gives { kid, pub }.
//   kidOf(pub)       → base64url(sha256(raw 32 bytes)) (43 characters) — the key id used on the wire
//   displayFp(pub)   → "K7QM-3XPA-…" (base32 of the same hash, first 20 characters, 4-4-4-4-4) — for people to compare
//   teamTag(token)   → first 16 hex of HMAC-SHA256(token, "agentdesk-team-tag"): binds a key signature to one team
//   reqKeyInput / resKeyInput → the exact strings that are signed (docs/design/ed25519-identity.md §4.2 / §4.3)
//   verifyKey(pub, input, sig) → boolean; importPub(pub) → KeyObject (cached)
import { createHash, createHmac, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const KEY_FILE = join(homedir(), ".agentdesk", "team-key");
export const PUB_RE = /^[A-Za-z0-9_-]{43}$/;   // raw 32-byte Ed25519 public key, base64url
export const KID_RE = /^[A-Za-z0-9_-]{43}$/;   // base64url sha256
export const KSIG_RE = /^[A-Za-z0-9_-]{86}$/;  // 64-byte Ed25519 signature, base64url
export const KEY_TRUST = new Set(["invite", "confirmed"]);

const sha256hex = s => createHash("sha256").update(s == null ? "" : String(s)).digest("hex");
// the raw 32 bytes of a public key, or null when it is not one
export function pubRaw(pub) {
  if (typeof pub !== "string" || !PUB_RE.test(pub)) return null;
  const b = Buffer.from(pub, "base64url");
  return b.length === 32 && b.toString("base64url") === pub ? b : null;
}
const kidCache = new Map();
export function kidOf(pub) {
  const raw = pubRaw(pub); if (!raw) return "";
  let k = kidCache.get(pub);
  if (!k) { if (kidCache.size >= 512) kidCache.clear(); k = createHash("sha256").update(raw).digest("base64url"); kidCache.set(pub, k); }
  return k;
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function displayFp(pub) {
  const raw = pubRaw(pub); if (!raw) return "";
  const h = createHash("sha256").update(raw).digest();
  let bits = 0, acc = 0, out = "";
  for (const byte of h) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5 && out.length < 20) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } acc &= (1 << bits) - 1; if (out.length >= 20) break; }
  return out.match(/.{4}/g).join("-");
}
export function teamTag(token) { return createHmac("sha256", String(token || "")).update("agentdesk-team-tag").digest("hex").slice(0, 16); }

// §4.2: UTF-8, lines joined with LF, no LF after the last line
export function reqKeyInput({ method, host, path, ts, nonce, body, callerKid, targetKid, tag }) {
  return ["agentdesk-req-v2", String(method).toUpperCase(), host, path, ts, nonce, sha256hex(body), callerKid, targetKid || "-", tag].join("\n");
}
// §4.3
export function resKeyInput({ status, host, ts, nonce, body, serverKid, callerKid, tag }) {
  return ["agentdesk-res-v2", Number(status), host, ts, nonce, sha256hex(body), serverKid, callerKid || "-", tag].join("\n");
}

const pubCache = new Map();
export function importPub(pub) {
  let k = pubCache.get(pub);
  if (k) return k;
  if (!pubRaw(pub)) return null;
  k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
  if (pubCache.size >= 256) pubCache.clear();
  pubCache.set(pub, k);
  return k;
}
export function verifyKey(pub, input, sig) {
  if (typeof sig !== "string" || !KSIG_RE.test(sig)) return false;
  const k = importPub(pub); if (!k) return false;
  try { return edVerify(null, Buffer.from(String(input), "utf-8"), k, Buffer.from(sig, "base64url")); } catch { return false; }
}
export { verifyKey as verify };

// sign() only signs the two AgentDesk messages (reqKeyInput / resKeyInput): the key can never be made to sign anything
// else (another protocol's message, a chosen blob), whatever a caller passes
export const SIGN_PREFIXES = Object.freeze(["agentdesk-req-v2\n", "agentdesk-res-v2\n"]);
// the only place a private key is held: { kid, pub, sign } out, the KeyObject stays in this closure
export function identityFromPrivateKey(privateKey) {
  const pub = createPublicKey(privateKey).export({ format: "jwk" }).x;
  const kid = kidOf(pub);
  const sign = input => {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf-8");
    if (!SIGN_PREFIXES.some(p => b.length > p.length && b.subarray(0, p.length).equals(Buffer.from(p)))) throw new Error("refusing to sign: not an AgentDesk request / response");
    return edSign(null, b, privateKey).toString("base64url");
  };
  return Object.freeze({ kid, pub, sign, toJSON: () => ({ kid, pub }), [Symbol.for("nodejs.util.inspect.custom")]: () => `Identity { kid: '${kid}' }` });
}
export function identityFromPkcs8(der) { return identityFromPrivateKey(createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" })); }
// a fixed 32-byte seed (RFC 8032 secret key) → identity: test vectors and fixtures only; real keys come from loadOrCreateIdentity
const seedKey = seed => {
  const b = Buffer.from(seed); if (b.length !== 32) throw new Error("seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), b]), format: "der", type: "pkcs8" });
};
export function identityFromSeed(seed) { return identityFromPrivateKey(seedKey(seed)); }
// plain Ed25519 over any message with a seed key — for the RFC 8032 test vectors only (no domain prefix); never used
// with this PC's key
export function signRawWithSeed(seed, msg) { return edSign(null, Buffer.from(msg), seedKey(seed)).toString("base64url"); }

const canEncrypt = ss => { try { return !!(ss && typeof ss.isEncryptionAvailable === "function" && ss.isEncryptionAvailable()); } catch { return false; } };
function writeKeyFile(file, obj) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}
function createKey(file, safeStorage) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const identity = identityFromPrivateKey(privateKey);
  let enc = "plain", priv = der.toString("base64");
  if (canEncrypt(safeStorage)) {
    try { priv = Buffer.from(safeStorage.encryptString(der.toString("base64"))).toString("base64"); enc = "safeStorage"; } catch { enc = "plain"; priv = der.toString("base64"); }
  }
  writeKeyFile(file, { v: 1, alg: "ed25519", pub: identity.pub, enc, priv });
  return { ok: true, identity, created: true, encrypted: enc === "safeStorage" };
}
// safeStorage: Electron's (or a stand-in with isEncryptionAvailable / encryptString / decryptString); null → plain file
export function loadOrCreateIdentity({ file = KEY_FILE, safeStorage = null } = {}) {
  if (!existsSync(file)) {
    try { return createKey(file, safeStorage); } catch (e) { return { ok: false, reason: `key not created: ${e.message}` }; }
  }
  let d; try { d = JSON.parse(readFileSync(file, "utf-8")); } catch { return { ok: false, reason: "key file unreadable" }; }
  if (!d || d.v !== 1 || d.alg !== "ed25519" || typeof d.priv !== "string" || !pubRaw(d.pub)) return { ok: false, reason: "key file unreadable" };
  let b64;
  if (d.enc === "safeStorage") {
    if (!canEncrypt(safeStorage)) return { ok: false, reason: "key is encrypted and safeStorage is unavailable" };
    try { b64 = String(safeStorage.decryptString(Buffer.from(d.priv, "base64"))); } catch { return { ok: false, reason: "key could not be decrypted" }; }
  } else if (d.enc === "plain") b64 = d.priv;
  else return { ok: false, reason: "key file unreadable" };
  let identity; try { identity = identityFromPkcs8(Buffer.from(b64, "base64")); } catch { return { ok: false, reason: "key could not be decrypted" }; }
  if (identity.pub !== d.pub) return { ok: false, reason: "key file does not match its public key" };
  return { ok: true, identity, created: false, encrypted: d.enc === "safeStorage" };
}
// the user confirmed "make a new key" (every teammate then sees a key change): the old file is kept next to it
export function regenerateIdentity({ file = KEY_FILE, safeStorage = null, confirmed = false } = {}) {
  if (confirmed !== true) return { ok: false, reason: "confirmation required" };
  try {
    if (existsSync(file)) renameSync(file, `${file}.old-${Date.now()}`);
    return createKey(file, safeStorage);
  } catch (e) { return { ok: false, reason: `key not created: ${e.message}` }; }
}
