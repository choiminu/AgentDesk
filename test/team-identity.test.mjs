// Team sharing: per-PC Ed25519 identity (team/identity.mjs) and the key layer of team/peer.mjs —
// docs/design/ed25519-identity.md §8 "새 테스트 목록" (7, 8 and 12 live in test/team-remote.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { loadOrCreateIdentity, regenerateIdentity, identityFromSeed, signRawWithSeed, kidOf, displayFp, teamTag, reqKeyInput, resKeyInput, verifyKey, importPub, pubRaw } from '../team/identity.mjs';
import { startTeamServer, fetchPeer, postNote, postHello, pingPeerSigned, signRequest, verifyRequest, createNonceGuard, NONCE_PER_IP, requestSignature, responseSignature, readTeamConfig, upsertPeer, addPeerToConfig, encodeInvite, decodeInvite, INVITE_PREFIX, INVITE_PREFIX_V2, createTicketStore, ticketProof, pinnedKeyOf, newTeamToken } from '../team/peer.mjs';
import { encodeBeacon, parseBeacon } from '../team/discovery.mjs';
import { canDelegate } from '../team/remote.mjs';
import '../core/team.js';

const dir = mkdtempSync(join(tmpdir(), 'agentdesk-identity-'));
const ID = { me: '11111111-1111-4111-8111-111111111111', will: '22222222-2222-4222-8222-222222222222', amy: '33333333-3333-4333-8333-333333333333' };
const K = { me: identityFromSeed(Buffer.alloc(32, 1)), will: identityFromSeed(Buffer.alloc(32, 2)), amy: identityFromSeed(Buffer.alloc(32, 3)), eve: identityFromSeed(Buffer.alloc(32, 5)) };
const listen = async (server) => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `127.0.0.1:${server.address().port}`; };
const pinned = (name, host, who = name, trust = 'invite') => ({ name, host, instanceId: ID[who] || '', pubkey: K[who].pub, keyTrust: trust, keyAt: 1 });
// a stand-in for Electron's safeStorage (reversible, not plain text)
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: s => Buffer.concat([Buffer.from('ENC:'), Buffer.from(s).reverse()]),
  decryptString: b => { const x = Buffer.from(b); if (x.subarray(0, 4).toString() !== 'ENC:') throw new Error('bad'); return Buffer.from(x.subarray(4)).reverse().toString(); },
});

// ── 1. key file ──
test('identity: created once (0600 file, 0700 folder), loaded again; safeStorage or plain; JSON / inspect show no private key', () => {
  const plainFile = join(dir, 'k1', 'team-key');
  const a = loadOrCreateIdentity({ file: plainFile });
  assert.deepEqual([a.ok, a.created, a.encrypted], [true, true, false]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(plainFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'k1')).mode & 0o777, 0o700);
  }
  const f = JSON.parse(readFileSync(plainFile, 'utf-8'));
  assert.deepEqual(Object.keys(f).sort(), ['alg', 'enc', 'priv', 'pub', 'v']);
  assert.deepEqual([f.v, f.alg, f.enc, f.pub], [1, 'ed25519', 'plain', a.identity.pub]);
  const b = loadOrCreateIdentity({ file: plainFile });
  assert.deepEqual([b.ok, b.created, b.identity.kid], [true, false, a.identity.kid], 'the same key on the next start');
  assert.equal(b.identity.kid, kidOf(b.identity.pub));
  assert.ok(verifyKey(b.identity.pub, 'agentdesk-req-v2\nhello', a.identity.sign('agentdesk-req-v2\nhello')), 'what one load signs the other verifies');
  // the identity object: { kid, pub, sign } only
  const id = a.identity;
  assert.deepEqual(JSON.parse(JSON.stringify(id)), { kid: id.kid, pub: id.pub });
  assert.deepEqual(Object.keys(id).sort(), ['kid', 'pub', 'sign', 'toJSON']);
  assert.ok(Object.isFrozen(id));
  const der = Buffer.from(f.priv, 'base64');
  for (const shown of [JSON.stringify(id), inspect(id, { showHidden: true, depth: 5 }), JSON.stringify({ wrapper: id })]) {
    assert.ok(!shown.includes(f.priv) && !shown.includes(der.subarray(-32).toString('base64url')) && !shown.includes(der.subarray(-32).toString('hex')), shown);
  }
  // safeStorage available → encrypted on disk, read back through it
  const encFile = join(dir, 'k2', 'team-key');
  const c = loadOrCreateIdentity({ file: encFile, safeStorage: fakeSafe() });
  assert.deepEqual([c.ok, c.created, c.encrypted], [true, true, true]);
  const fe = JSON.parse(readFileSync(encFile, 'utf-8'));
  assert.equal(fe.enc, 'safeStorage');
  assert.ok(Buffer.from(fe.priv, 'base64').subarray(0, 4).toString() === 'ENC:', 'the stored key went through safeStorage');
  assert.equal(loadOrCreateIdentity({ file: encFile, safeStorage: fakeSafe() }).identity.kid, c.identity.kid);
  // safeStorage present but not usable (Linux without a keyring) → plain, reported as not encrypted
  const d = loadOrCreateIdentity({ file: join(dir, 'k3', 'team-key'), safeStorage: fakeSafe(false) });
  assert.deepEqual([d.ok, d.encrypted], [true, false]);
});

test('identity: a key file that cannot be read or decrypted is never replaced; only a confirmed regenerate makes a new key', () => {
  const file = join(dir, 'k4', 'team-key');
  const first = loadOrCreateIdentity({ file, safeStorage: fakeSafe() });
  const before = readFileSync(file, 'utf-8');
  const cases = [
    [{ file, safeStorage: null }, /safeStorage is unavailable/, 'encrypted, no safeStorage'],
    [{ file, safeStorage: fakeSafe(false) }, /safeStorage is unavailable/, 'encrypted, safeStorage not usable'],
    [{ file, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('keychain says no'); } } }, /could not be decrypted/, 'decryption fails (app re-signed)'],
    [{ file, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'bm90IGEga2V5' } }, /could not be decrypted/, 'decrypts to garbage'],
  ];
  for (const [opts, re, why] of cases) {
    const r = loadOrCreateIdentity(opts);
    assert.equal(r.ok, false, why); assert.match(r.reason, re, why); assert.equal(r.identity, undefined);
    assert.equal(readFileSync(file, 'utf-8'), before, `${why}: the file is untouched`);
  }
  // a damaged file / a file whose public key does not match its private key: unusable, untouched
  const bad = join(dir, 'k5-team-key');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(loadOrCreateIdentity({ file: bad }), { ok: false, reason: 'key file unreadable' });
  assert.equal(readFileSync(bad, 'utf-8'), '{ not json');
  const plain = join(dir, 'k6', 'team-key'); loadOrCreateIdentity({ file: plain });
  const j = JSON.parse(readFileSync(plain, 'utf-8')); j.pub = K.eve.pub; writeFileSync(plain, JSON.stringify(j));
  assert.match(loadOrCreateIdentity({ file: plain }).reason, /does not match/);
  // regenerate: refused without confirmation; with it, a new key and the old file kept next to it
  assert.deepEqual(regenerateIdentity({ file, safeStorage: fakeSafe() }), { ok: false, reason: 'confirmation required' });
  assert.equal(readFileSync(file, 'utf-8'), before);
  const re = regenerateIdentity({ file, safeStorage: fakeSafe(), confirmed: true });
  assert.equal(re.ok, true); assert.notEqual(re.identity.kid, first.identity.kid);
  assert.ok(readdirSync(join(dir, 'k4')).some(n => n.startsWith('team-key.old-')), 'old key file kept');
});

// ── 2. known-answer vectors ──
test('known answers: RFC 8032 test 1, kid / fingerprint / team tag, the exact signed strings and their signatures', () => {
  // RFC 8032 §7.1 TEST 1 (raw Ed25519: the identity's sign() refuses anything without the AgentDesk prefix)
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const rfc = identityFromSeed(seed);
  assert.equal(Buffer.from(rfc.pub, 'base64url').toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(Buffer.from(signRawWithSeed(seed, Buffer.alloc(0)), 'base64url').toString('hex'), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  // fixed key (seed 07×32), checked independently with Python's hashlib / hmac
  const id = identityFromSeed(Buffer.alloc(32, 7));
  assert.equal(id.pub, '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw');
  assert.equal(id.kid, '_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk');
  assert.equal(kidOf(id.pub), id.kid);
  assert.equal(displayFp(id.pub), '72AS-YEXT-VNGO-NLC5-W2NM');
  assert.equal(globalThis.AgentDeskTeam.displayFp(id.pub), '72AS-YEXT-VNGO-NLC5-W2NM', 'the renderer computes the same fingerprint');
  assert.equal(teamTag('tok'), '4ec296e0c5c549ea');
  const common = { host: '10.0.0.5:7331', ts: '1760000000000', nonce: '00112233445566778899aabbccddeeff', tag: teamTag('tok') };
  const req = reqKeyInput({ ...common, method: 'post', path: '/v1/notes?x=1', body: '{"to":"a","text":"hi"}', callerKid: id.kid, targetKid: '-' });
  assert.equal(req, 'agentdesk-req-v2\nPOST\n10.0.0.5:7331\n/v1/notes?x=1\n1760000000000\n00112233445566778899aabbccddeeff\nfff5729d6b9ad0f195f505d13fe9facc1e3dfd4354deab89a4a24d686e19c550\n_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk\n-\n4ec296e0c5c549ea');
  assert.equal(id.sign(req), '81cny-uiZzYV0vUTWuHlRIPwEtw3Ze7byJgdKXQnd0p01ZCp-4xU-7VKASLH6zks5FaoKxwDLO1XJafO1j_XAQ');
  const res = resKeyInput({ ...common, status: 304, body: '', serverKid: id.kid, callerKid: '-' });
  assert.equal(res, 'agentdesk-res-v2\n304\n10.0.0.5:7331\n1760000000000\n00112233445566778899aabbccddeeff\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk\n-\n4ec296e0c5c549ea');
  assert.equal(id.sign(res), 'em5hJWe8hLXFrV0uldPDH22pE8DVK-6-E8SMlTC92KexiSMDiqQ1whLenOnRppzjnWA2P0Ft0TGIx4QTgHXnDg');
  assert.ok(!req.endsWith('\n') && !res.endsWith('\n'), 'no LF after the last line');
  // sign() is bound to the two AgentDesk messages
  for (const other of ['', 'hello', 'agentdesk-req-v2', 'agentdesk-req-v2\n', 'agentdesk-req-v1\nPOST', ' agentdesk-req-v2\nx', Buffer.alloc(0), Buffer.from('{"token":"x"}')]) {
    assert.throws(() => id.sign(other), /refusing to sign/, JSON.stringify(String(other)));
  }
  assert.equal(id.sign(Buffer.from(req)), id.sign(req), 'a Buffer with the prefix is fine');
  // malformed keys
  for (const bad of ['', 'x', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '+', 'A'.repeat(42) + 'B', null, 42]) {
    assert.equal(kidOf(bad), '', String(bad)); assert.equal(displayFp(bad), '', String(bad)); assert.equal(globalThis.AgentDeskTeam.displayFp(bad), '', String(bad));
  }
  assert.equal(pubRaw('A'.repeat(42) + 'B'), null, 'non-canonical: the spare bits must be zero');
  assert.equal(importPub(id.pub), importPub(id.pub), 'imported once (cached)');
  assert.equal(verifyKey(id.pub, req, id.sign(req + 'x')), false);
  assert.equal(verifyKey(id.pub, req, 'short'), false);
  assert.equal(verifyKey('x', req, id.sign(req)), false);
});

// ── 3. request verification ──
test('verifyRequest v2: header format, skew, HMAC, unknown key, wrong peer, tampering, replay, kid buckets', () => {
  const host = '10.0.0.5:7331', path = '/v1/notes', body = '{"to":"a","text":"hi"}', t = 1_000_000;
  const pins = new Map([[K.will.kid, K.will.pub]]);
  const keys = { myKid: K.me.kid, lookup: k => pins.get(k) || '', allowUnpinned: true };
  const sign = (o = {}) => signRequest('tok', 'POST', o.host || host, o.path || path, o.body ?? body, t, { identity: o.id || K.will, targetKid: o.to });
  const hdrs = s => Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = (s, o = {}) => ({ method: 'POST', host, path, body, headers: hdrs(s), ip: '10.0.0.9', ...o });
  const g = () => createNonceGuard();
  const ok = verifyRequest('tok', req(sign()), g(), t, keys);
  assert.deepEqual([ok.ok, ok.ver, ok.kid, ok.pubkey, ok.pinned], [true, 2, K.will.kid, K.will.pub, true]);
  const unpinned = verifyRequest('tok', req(sign({ id: K.eve })), g(), t, keys);
  assert.deepEqual([unpinned.ok, unpinned.kid, unpinned.pinned], [true, K.eve.kid, false], 'an unpinned key is verified by its X-AD-Pub');
  assert.equal(verifyRequest('tok', req(sign({ to: K.me.kid })), g(), t, keys).ok, true, 'X-AD-To = my kid');
  const strict = verifyRequest('tok', req(sign({ id: K.eve })), g(), t, { ...keys, allowUnpinned: false });
  assert.deepEqual(strict, { ok: false, error: 'unknown key', hmacOk: true }, 'an unpinned key where only pinned keys may call');
  const err = (s, o, k = keys, tt = t) => verifyRequest('tok', req(s, o), g(), tt, k).error;
  const s = sign();
  const with_ = (s0, h) => ({ ...s0, headers: { ...s0.headers, ...h } });
  assert.equal(err(with_(s, { 'X-AD-Ver': '3' })), 'bad key headers');
  assert.equal(err(with_(s, { 'X-AD-Kid': 'short' })), 'bad key headers');
  assert.equal(err(with_(s, { 'X-AD-To': 'nope' })), 'bad key headers');
  assert.equal(err(with_(s, { 'X-AD-KSig': 'x'.repeat(10) })), 'bad key headers');
  assert.equal(err(with_(s, { 'X-AD-Pub': 'not a key' })), 'bad key headers');
  assert.equal(err(s, {}, keys, t + 121_000), 'clock skew');
  assert.equal(verifyRequest('other', req(s), g(), t, keys).error, 'bad signature', 'HMAC first: no team token, no key check');
  assert.equal(err(sign({ to: K.amy.kid })), 'wrong peer', 'meant for another teammate (my IP changed hands)');
  assert.equal(err(sign({ to: K.me.kid }), {}, { lookup: keys.lookup }), 'wrong peer', 'I have no usable identity');
  const noPub = sign({ id: K.eve }); delete noPub.headers['X-AD-Pub'];
  assert.equal(err(noPub), 'unknown key', 'not pinned and no public key sent');
  const noPubPinned = sign(); delete noPubPinned.headers['X-AD-Pub'];
  assert.equal(verifyRequest('tok', req(noPubPinned), g(), t, keys).ok, true, 'a pinned key needs no X-AD-Pub');
  assert.equal(verifyRequest('tok', req(with_(s, { 'X-AD-Pub': K.eve.pub })), g(), t, keys).pinned, true, 'X-AD-Pub of another key is ignored when the kid is pinned');
  const evePubAsAmy = sign({ id: K.eve }); evePubAsAmy.headers['X-AD-Pub'] = K.amy.pub;
  assert.equal(err(evePubAsAmy), 'unknown key', 'unpinned: X-AD-Pub must hash to X-AD-Kid');
  // someone with the token re-computes the HMAC for a tampered request — the key signature does not follow
  const rehmac = (o) => { const h = { ...s.headers, 'X-AD-Sig': requestSignature('tok', 'POST', o.host || host, o.path || path, s.ts, s.nonce, o.body ?? body) }; return verifyRequest('tok', req({ ...s, headers: h }, o), g(), t, keys).error; };
  assert.equal(rehmac({ body: body.replace('hi', 'rm') }), 'bad key signature', 'body');
  assert.equal(rehmac({ path: '/v1/hello' }), 'bad key signature', 'path');
  assert.equal(rehmac({ host: '10.0.0.6:7331' }), 'bad key signature', 'host');
  assert.equal(verifyRequest('tok', req(s), g(), t, { ...keys, lookup: () => K.eve.pub }).pinned, false, 'a pinned key whose kid does not match is not used (the request counts as unpinned)');
  // replay and per-kid buckets
  const guard = createNonceGuard({ perIp: 1 });
  assert.equal(verifyRequest('tok', req(s), guard, t, keys).ok, true);
  assert.equal(verifyRequest('tok', req(s), guard, t, keys).error, 'replayed');
  assert.equal(verifyRequest('tok', req(sign()), guard, t, keys).error, 'busy-ip', 'will\'s (pinned) bucket is full');
  assert.equal(verifyRequest('tok', req(sign({ id: K.eve })), guard, t, keys).ok, true, 'an unpinned key at that IP: the IP bucket');
  assert.equal(verifyRequest('tok', req(sign({ id: K.amy })), guard, t, keys).error, 'busy-ip', 'another unpinned key, same IP: the same bucket');
  assert.equal(verifyRequest('tok', req(signRequest('tok', 'POST', host, path, body, t)), guard, t, keys).error, 'busy-ip', 'and a v1 request from it');
  assert.equal(verifyRequest('tok', req(sign({ id: K.eve }), { ip: '10.0.0.10' }), guard, t, keys).ok, true, 'another IP has its own');
  const v1 = signRequest('tok', 'POST', host, path, body, t);
  assert.equal(verifyRequest('tok', req(v1), createNonceGuard(), t, keys).ver, 1);
});

// ── 4. response verification ──
test('responses: pinned key must sign (missing → bad signature, other key → key changed), status / body bound, expectKid', async () => {
  let mode = 'ok';
  const fake = createServer((req, res) => {
    const body = JSON.stringify({ name: 'neo', at: 1, sessions: [] });
    const status = mode === 'status' ? 304 : 200, text = status === 304 ? '' : body;
    const signer = mode === 'other' ? K.eve : K.me;
    const callerKid = req.headers['x-ad-kid'] || '-';
    const h = { 'Content-Type': 'application/json', 'X-AD-Sig': responseSignature('t0k', status, req.headers.host, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], text) };
    if (mode !== 'nokey') Object.assign(h, { 'X-AD-Ver': '2', 'X-AD-Kid': signer.kid, 'X-AD-Pub': signer.pub,
      'X-AD-KSig': signer.sign(resKeyInput({ status: mode === 'status' ? 200 : status, host: req.headers.host, ts: req.headers['x-ad-ts'], nonce: req.headers['x-ad-nonce'], body: text, serverKid: signer.kid, callerKid, tag: teamTag('t0k') })) });
    if (mode === 'broken') h['X-AD-KSig'] = K.me.sign('agentdesk-res-v2\nsomething else');
    res.writeHead(status, h); res.end(text);
  });
  const host = await listen(fake);
  const me = { name: 'neo', host, pubkey: K.me.pub, keyTrust: 'invite' };
  const auth = { token: 't0k', identity: K.will };
  try {
    let r = await fetchPeer(me, auth);
    assert.deepEqual([r.ok, r.keyOk, r.kid, r.pubkey], [true, true, K.me.kid, K.me.pub]);
    mode = 'nokey'; r = await fetchPeer(me, auth);
    assert.deepEqual([r.ok, r.error], [false, 'bad signature'], 'a pinned peer answering HMAC-only is a downgrade');
    mode = 'other'; r = await fetchPeer(me, auth);
    assert.deepEqual([r.ok, r.error, r.kid], [false, 'key changed', K.eve.kid], 'signed, but by another key');
    mode = 'status'; r = await fetchPeer(me, auth, { etag: '"x"' });
    assert.deepEqual([r.ok, r.error], [false, 'bad signature'], 'a key signature for another status code');
    mode = 'broken'; r = await fetchPeer({ name: 'neo', host }, auth);
    assert.deepEqual([r.ok, r.error], [false, 'bad signature'], 'unpinned: a key signature that does not verify is not ignored');
    mode = 'ok'; r = await fetchPeer({ name: 'neo', host }, auth);
    assert.deepEqual([r.ok, r.keyOk, r.kid], [true, false, K.me.kid], 'unpinned: verified with its own key, reported for confirmation');
    r = await fetchPeer({ name: 'neo', host }, 't0k');
    assert.deepEqual([r.ok, 'kid' in r, 'keyOk' in r], [true, false, false], 'v1 mode (plain token): the key layer is not looked at, the answer has the old fields');
    r = await fetchPeer({ name: 'neo', host, expectKid: K.eve.kid }, auth);
    assert.deepEqual([r.ok, r.error], [false, 'key mismatch'], 'the beacon promised another key');
    mode = 'nokey'; r = await fetchPeer({ name: 'neo', host, expectKid: K.me.kid }, auth);
    assert.deepEqual([r.ok, r.error], [false, 'key mismatch'], 'the beacon promised a key, the answer has none');
    assert.equal((await fetchPeer({ name: 'neo', host, pubkey: K.me.pub }, auth)).ok, true, 'a pubkey without a trust reason is not pinned');
    assert.equal((await fetchPeer(me, 't0k')).ok, true, 'v1 mode (plain token): no downgrade check — exactly the 0.2.1 client');
  } finally { fake.close(); }
});

// ── 5. v2 client ↔ v1 server ──
test('v2 client and a v1 (0.2.1) server: sessions are shown, no key → identity unconfirmed, no delegation', async () => {
  // what 0.2.1 does: HMAC only, the X-AD-* key headers ignored
  const v1 = createServer((req, res) => {
    const ok = req.headers['x-ad-sig'] === requestSignature('t0k', req.method, req.headers.host, req.url, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], '');
    const body = ok ? JSON.stringify({ name: 'old', at: 1, instanceId: ID.amy, sessions: [{ id: 'a', status: 'running' }] }) : '{"error":"bad signature"}';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json', 'X-AD-Sig': responseSignature('t0k', ok ? 200 : 401, req.headers.host, req.headers['x-ad-ts'], req.headers['x-ad-nonce'], body) });
    res.end(body);
  });
  const host = await listen(v1);
  try {
    const peer = { name: 'old', host, instanceId: ID.amy };
    const r = await fetchPeer(peer, { token: 't0k', identity: K.will });
    assert.deepEqual([r.ok, r.sessions.length, r.keyOk, r.kid, r.pubkey], [true, 1, false, '', '']);
    assert.equal(canDelegate({ peer, state: { ok: true, keyOk: r.keyOk }, session: { agent: 'claude', handle: 'tmux:%1', permissionMode: 'default' }, keyMode: true }), 'teammate key not confirmed');
  } finally { v1.close(); }
});

// ── 6. v1 client ↔ v2 server ──
test('v1 client and a v2 server: session list yes, grants / safety no; notes only for a keyless entry at that IP, else 403', async () => {
  const got = [];
  const cfg = { name: 'neo', token: 't0k', instanceId: ID.me, peers: [{ name: 'old', host: '127.0.0.1:7441' }] };
  const server = startTeamServer(cfg, () => ({ at: 1, sessions: [{ id: 'a', status: 'waiting' }] }), { identity: K.me, onNote: n => got.push(n), safety: () => ({ guard: 'block', perm: true, rulesHash: '', blocksToday: 1 }) });
  const host = await listen(server);
  try {
    const f = await fetchPeer({ name: 'neo', host }, 't0k');
    assert.deepEqual([f.ok, f.sessions.length, f.delegations.length, f.safety], [true, 1, 0, undefined]);
    assert.deepEqual(await postNote({ name: 'neo', host }, 't0k', { to: 'a', text: 'hi from old' }), { ok: true });
    assert.equal(got.at(-1).from, 'old', 'attributed to the keyless entry at that IP');
    // the entry at that IP now has a pinned key: an HMAC-only note from there is a downgrade
    cfg.peers = [pinned('will', '127.0.0.1:7441')];
    const r = await postNote({ name: 'neo', host }, 't0k', { to: 'a', text: 'spoof' });
    assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'not registered on their side'], 'refused; a v1 client words it as before');
    const sk = signRequest('t0k', 'POST', host, '/v1/notes', '{"to":"a","text":"x"}');
    assert.equal((await (await fetch(`http://${host}/v1/notes`, { method: 'POST', headers: sk.headers, body: '{"to":"a","text":"x"}' })).json()).error, 'key required');
    // a pinned and a keyless entry at the same IP: the keyless one gets the v1 note, the pinned one the key-signed note
    cfg.peers = [pinned('will', '127.0.0.1:7441'), { name: 'old', host: '127.0.0.1:7551' }];
    assert.equal((await postNote({ name: 'neo', host }, 't0k', { to: 'a', text: 'v1', port: 7441 })).ok, true);
    assert.equal(got.at(-1).from, 'old', 'the port hint cannot pick the pinned entry');
    assert.equal((await postNote({ name: 'neo', host }, { token: 't0k', identity: K.will }, { to: 'a', text: 'v2' })).ok, true);
    assert.equal(got.at(-1).from, 'will');
    const eve = await postNote({ name: 'neo', host }, { token: 't0k', identity: K.eve }, { to: 'a', text: 'eve' });
    assert.deepEqual([eve.ok, eve.status, eve.error], [false, 401, 'unknown key'], 'an unpinned key may not send notes at all');
    assert.equal(got.length, 3);
  } finally { server.close(); }
});

test('server signs every answer with its key (401 / 304 too); a signed ping carries its pubkey', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.me }, () => ({ at: 5, sessions: [] }), { identity: K.me });
  const host = await listen(server);
  try {
    assert.deepEqual(await pingPeerSigned({ host }, { token: 't0k', identity: K.will }), { ok: true, instanceId: ID.me, kid: K.me.kid, pubkey: K.me.pub, keyOk: false });
    assert.deepEqual(await pingPeerSigned({ host, pubkey: K.me.pub, keyTrust: 'confirmed' }, { token: 't0k', identity: K.will }), { ok: true, instanceId: ID.me, kid: K.me.kid, pubkey: K.me.pub, keyOk: true });
    assert.equal((await pingPeerSigned({ host, pubkey: K.eve.pub, keyTrust: 'invite' }, { token: 't0k', identity: K.will })).error, 'key changed');
    assert.deepEqual(await pingPeerSigned({ host, pubkey: K.eve.pub, keyTrust: 'invite' }, 't0k'), { ok: true, instanceId: ID.me }, 'v1 mode: the 0.2.1 answer shape, keys ignored');
    const open = await (await fetch(`http://${host}/v1/ping`)).json();
    assert.deepEqual(Object.keys(open), ['at'], 'the open ping says nothing more');
    const first = await fetchPeer({ name: 'neo', host, pubkey: K.me.pub, keyTrust: 'invite' }, { token: 't0k', identity: K.will });
    const again = await fetchPeer({ name: 'neo', host, pubkey: K.me.pub, keyTrust: 'invite' }, { token: 't0k', identity: K.will }, { etag: first.etag });
    assert.deepEqual([again.ok, again.notModified, again.keyOk], [true, true, true], 'a 304 is key-signed too');
    const bad = await fetchPeer({ name: 'neo', host, pubkey: K.me.pub, keyTrust: 'invite' }, { token: 'wrong', identity: K.will });
    assert.deepEqual([bad.ok, bad.error], [false, 'token mismatch'], 'a 401 for another team: no trusted reason');
    const wrongPeer = await fetchPeer({ name: 'neo', host, pubkey: K.amy.pub, keyTrust: 'invite' }, { token: 't0k', identity: K.will });
    assert.equal(wrongPeer.ok, false, 'X-AD-To = amy reaches neo → refused');
  } finally { server.close(); }
});

// ── 9. hello v2 ──
test('hello v2: proof of possession, onHello gets { v: 2, pubkey, kid, ticketOk }, new / move / rekey / bind; tickets one-time', async () => {
  const tickets = createTicketStore();
  const seen = [];
  const cfg = { name: 'neo', token: 'tok-123456', instanceId: ID.me, peers: [] };
  // what the app does (stage 2): classify with upsertPeer, apply nothing here
  const server = startTeamServer(cfg, () => ({}), { identity: K.me, checkTicket: (p, pub) => tickets.check(p, pub), onHello: peer => { const u = upsertPeer(cfg.peers, peer); seen.push([u.change, peer]); return { ok: true, pending: u.change !== 'none' }; } });
  const host = await listen(server);
  const hello = (who, extra = {}) => postHello({ name: 'neo', host }, { token: 'tok-123456', identity: K[who] }, { name: who, port: 7441, instanceId: ID[who] || '', ...extra });
  try {
    const t = tickets.issue();
    const r = await hello('will', { ticket: t });
    assert.deepEqual([r.ok, r.pending, r.kid, r.pubkey], [true, true, K.me.kid, K.me.pub], 'the answer carries my key');
    assert.deepEqual(seen[0], ['added', { name: 'will', host: '127.0.0.1:7441', instanceId: ID.will, v: 2, pubkey: K.will.pub, kid: K.will.kid, ticketOk: true }]);
    await hello('will', { ticket: t });
    assert.equal(seen[1][1].ticketOk, false, 'a ticket works once');
    await hello('amy', { ticket: tickets.issue().replace(/^./, c => c === 'A' ? 'B' : 'A') });
    assert.equal(seen[2][1].ticketOk, false, 'a wrong ticket');
    // proof of possession: the body names will's key, eve signed the request
    const body = JSON.stringify({ v: 2, name: 'will', port: 7441, pubkey: K.will.pub });
    const s = signRequest('tok-123456', 'POST', host, '/v1/hello', body, Date.now(), { identity: K.eve });
    const pop = await fetch(`http://${host}/v1/hello`, { method: 'POST', headers: s.headers, body });
    assert.equal(pop.status, 401); assert.equal((await pop.json()).error, 'key proof failed');
    const v1body = JSON.stringify({ v: 2, name: 'will', port: 7441, pubkey: K.will.pub });
    const v1 = await fetch(`http://${host}/v1/hello`, { method: 'POST', headers: signRequest('tok-123456', 'POST', host, '/v1/hello', v1body).headers, body: v1body });
    assert.equal(v1.status, 401, 'a pubkey in an HMAC-only hello proves nothing');
    assert.equal(seen.length, 3, 'refused hellos never reach onHello');
    // classification once will is pinned at 10.0.0.5
    cfg.peers = [pinned('will', '10.0.0.5:7331'), { name: 'old', host: '127.0.0.1:7551', instanceId: ID.amy }];
    await hello('will');
    assert.deepEqual([seen.at(-1)[0], upsertPeer(cfg.peers, seen.at(-1)[1]).from], ['moved', '10.0.0.5:7331'], 'same key, new address: a real move');
    await hello('eve', { instanceId: ID.will });
    assert.equal(seen.at(-1)[0], 'rekey', 'will\'s instance id with another key');
    await postHello({ name: 'neo', host }, { token: 'tok-123456', identity: K.amy }, { name: 'old', port: 7551, instanceId: ID.amy });
    assert.equal(seen.at(-1)[0], 'bind', 'a keyless entry (0.2.1) now has a key');
    await postHello({ name: 'neo', host }, 'tok-123456', { name: 'will', port: 7331, instanceId: ID.will });
    assert.deepEqual([seen.at(-1)[0], 'v' in seen.at(-1)[1]], ['keyless', false], 'a v1 hello for a pinned teammate is never applied');
  } finally { server.close(); }
  // tickets: 24 h, one use, bound to the key
  let clock = 0; const ts = createTicketStore({ now: () => clock });
  const tk = ts.issue();
  assert.match(tk, /^[A-Za-z0-9_-]{22}$/); assert.equal(Buffer.from(tk, 'base64url').length, 16);
  assert.equal(ts.check(ticketProof(tk, K.amy.pub), K.will.pub), false, 'a proof for another key');
  clock = 24 * 3600 * 1000;
  assert.equal(ts.check(ticketProof(tk, K.will.pub), K.will.pub), false, 'expired after 24 h');
  const tk2 = ts.issue(); assert.equal(ts.list().length, 1);
  assert.equal(createTicketStore({ now: () => clock, initial: ts.list() }).check(ticketProof(tk2, K.will.pub), K.will.pub), true, 'restored from a saved list');
});

test('upsertPeer / addPeerToConfig with keys: pin on add, bind, rekey only when confirmed, move by key', () => {
  const f = join(dir, 'team-keys.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok-keep', peers: [{ name: 'old', host: '10.0.0.7:7331', instanceId: ID.amy }] }));
  // invite join: the inviter's key pinned at once
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will, pubkey: K.will.pub, keyTrust: 'invite', keyAt: 5 }), { ok: true, added: true, name: 'will' });
  let peers = readTeamConfig(f).peers;
  assert.deepEqual(peers[1], { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will, pubkey: K.will.pub, keyTrust: 'invite', keyAt: 5 });
  // hello from will at a new address: same key → moved (no race check needed)
  assert.deepEqual(addPeerToConfig(f, { name: 'w', host: '10.0.0.6:7331', instanceId: ID.will, pubkey: K.will.pub }), { ok: true, added: false, updated: true, name: 'will' });
  assert.equal(readTeamConfig(f).peers[1].host, '10.0.0.6:7331');
  // another key for will's seat: rekey, nothing written until confirmed
  const before = readFileSync(f, 'utf-8');
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.6:7331', instanceId: ID.will, pubkey: K.eve.pub, keyTrust: 'confirmed' }), { ok: true, added: false, change: 'rekey', name: 'will' });
  assert.equal(readFileSync(f, 'utf-8'), before);
  assert.deepEqual(addPeerToConfig(f, { name: 'will', host: '10.0.0.6:7331', instanceId: ID.will, pubkey: K.eve.pub, keyTrust: 'confirmed', rekey: true }), { ok: true, added: false, updated: true, change: 'rekey', name: 'will' });
  assert.equal(readTeamConfig(f).peers[1].pubkey, K.eve.pub);
  // bind: the 0.2.1 entry gets a key — only with a trust reason
  assert.deepEqual(addPeerToConfig(f, { name: 'old', host: '10.0.0.7:7331', instanceId: ID.amy, pubkey: K.amy.pub }), { ok: true, added: false, change: 'bind', name: 'old' });
  assert.equal(readTeamConfig(f).peers[0].pubkey, undefined, 'no trust reason → not pinned');
  assert.deepEqual(addPeerToConfig(f, { name: 'old', host: '10.0.0.7:7331', instanceId: ID.amy, pubkey: K.amy.pub, keyTrust: 'confirmed' }), { ok: true, added: false, updated: true, change: 'bind', name: 'old' });
  peers = readTeamConfig(f).peers;
  assert.deepEqual([peers[0].pubkey, peers[0].keyTrust, pinnedKeyOf(peers[0])], [K.amy.pub, 'confirmed', K.amy.pub]);
  assert.equal(JSON.parse(readFileSync(f, 'utf-8')).token, 'tok-keep');
  // a beacon's kid is only an expectation on a new entry
  const u = upsertPeer([], { name: 'x', host: '10.0.0.9:7331', expectKid: K.amy.kid });
  assert.deepEqual(u.peers[0], { name: 'x', host: '10.0.0.9:7331', expectKid: K.amy.kid });
});

// ── 10. invite codes ──
// decodeInvite exactly as 0.2.1 shipped it (team/peer.mjs before this change)
const HOST_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/, UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanName = s => String(s).replace(/[^\w.\-가-힣 ]/g, '').trim();
function decodeInvite021(code) {
  const s = String(code || '').trim();
  if (!s.startsWith('agentdesk-team:v1:')) return { error: 'not an AgentDesk invite code' };
  let d; try { d = JSON.parse(Buffer.from(s.slice('agentdesk-team:v1:'.length), 'base64url').toString('utf-8')); } catch { return { error: 'damaged invite code' }; }
  const inv = d && d.inviter;
  if (!d || typeof d.token !== 'string' || d.token.length < 8 || d.token === 'change-me-shared-secret') return { error: 'invite code has no valid token' };
  if (!inv || typeof inv.name !== 'string' || !cleanName(inv.name) || typeof inv.host !== 'string' || !HOST_RE.test(inv.host)) return { error: 'invite code has no valid inviter' };
  return { token: d.token, inviter: { name: cleanName(inv.name), host: inv.host, instanceId: typeof inv.instanceId === 'string' && UUID_RE.test(inv.instanceId) ? inv.instanceId : '' } };
}
test('invite v2 body under the v1 prefix: 0.2.1 can still join; the key and the join ticket round-trip; v2 prefix needs a key', () => {
  const token = newTeamToken(), ticket = createTicketStore().issue();
  const code = encodeInvite({ token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: ID.me, pubkey: K.me.pub }, ticket });
  assert.ok(code.startsWith(INVITE_PREFIX));
  assert.deepEqual(JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), 'base64url').toString()).v, 2);
  assert.deepEqual(decodeInvite021(code), { token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: ID.me } }, 'the 0.2.1 decoder ignores the new fields');
  assert.deepEqual(decodeInvite(code), { token, inviter: { name: 'neo', host: '192.168.10.120:7331', instanceId: ID.me, pubkey: K.me.pub }, ticket });
  // 0.2.3: the v2 prefix — older versions fail clearly, a code without a key is refused
  const v2 = encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331', pubkey: K.me.pub } }, { prefix: INVITE_PREFIX_V2 });
  assert.match(decodeInvite021(v2).error, /not an AgentDesk/);
  assert.equal(decodeInvite(v2).inviter.pubkey, K.me.pub);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331' } }, { prefix: INVITE_PREFIX_V2 })).error, /no key/);
  assert.match(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331' } }), { requirePubkey: true }).error, /no key/, 'strict mode');
  assert.equal(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331', pubkey: 'not-a-key' } })).inviter.pubkey, undefined, 'a malformed key is dropped');
  assert.equal(decodeInvite(encodeInvite({ token, inviter: { name: 'neo', host: '1.2.3.4:7331', pubkey: K.me.pub }, ticket: 'short' })).ticket, undefined);
});

// ── 11. config fields ──
test('readTeamConfig keeps pubkey / keyTrust / keyAt / expectKid, requireKeys and identity; drops malformed ones', () => {
  const f = join(dir, 'team-read.json');
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok', requireKeys: true, identity: { kid: 'ignored', pub: K.me.pub }, peers: [
    { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will, pubkey: K.will.pub, keyTrust: 'invite', keyAt: 1760000000000, expectKid: K.will.kid },
    { name: 'odd', host: '10.0.0.6:7331', pubkey: 'x', keyTrust: 'invite', keyAt: 'soon', expectKid: 'nope' },
    { name: 'notrust', host: '10.0.0.7:7331', pubkey: K.amy.pub, keyTrust: 'beacon' },
  ] }));
  const c = readTeamConfig(f);
  assert.equal(c.requireKeys, true);
  assert.deepEqual(c.identity, { kid: K.me.kid, pub: K.me.pub }, 'kid recomputed from pub');
  assert.deepEqual(c.peers, [
    { name: 'will', host: '10.0.0.5:7331', instanceId: ID.will, pubkey: K.will.pub, keyTrust: 'invite', keyAt: 1760000000000, expectKid: K.will.kid },
    { name: 'odd', host: '10.0.0.6:7331' },
    { name: 'notrust', host: '10.0.0.7:7331' },
  ]);
  writeFileSync(f, JSON.stringify({ name: 'neo', token: 'tok', requireKeys: 'yes' }));
  assert.equal(readTeamConfig(f).requireKeys, undefined, 'only true turns it on');
});

// ── 13. requireKeys ──
test('requireKeys: an HMAC-only request gets a signed 401 "upgrade required"; key-signed requests go through', async () => {
  const cfg = { name: 'neo', token: 't0k', instanceId: ID.me, requireKeys: true, peers: [] };
  const hellos = [];
  const server = startTeamServer(cfg, () => ({ at: 1, sessions: [] }), { identity: K.me, onHello: p => { hellos.push(p); return { ok: true }; } });
  const host = await listen(server);
  try {
    const s = signRequest('t0k', 'GET', host, '/v1/sessions');
    const r = await fetch(`http://${host}/v1/sessions`, { headers: s.headers }); const text = await r.text();
    assert.equal(r.status, 401); assert.equal(JSON.parse(text).error, 'upgrade required');
    assert.equal(r.headers.get('x-ad-sig'), responseSignature('t0k', 401, host, s.ts, s.nonce, text), 'HMAC-signed, so an older client shows the reason');
    assert.equal((await fetchPeer({ name: 'neo', host }, 't0k')).error, 'upgrade required');
    assert.equal((await postHello({ name: 'neo', host }, 't0k', { name: 'old', port: 7441 })).error, 'upgrade required');
    assert.equal((await pingPeerSigned({ host }, 't0k')).ok, false);
    assert.equal(hellos.length, 0);
    assert.equal((await fetchPeer({ name: 'neo', host }, { token: 't0k', identity: K.will })).ok, true);
    cfg.requireKeys = false;
    assert.equal((await fetchPeer({ name: 'neo', host }, 't0k')).ok, true, 'off again');
  } finally { server.close(); }
  const viaOpt = startTeamServer({ name: 'neo', token: 't0k' }, () => ({}), { identity: K.me, requireKeys: () => true });
  const h2 = await listen(viaOpt);
  try { assert.equal((await fetchPeer({ name: 'neo', host: h2 }, 't0k')).error, 'upgrade required'); } finally { viaOpt.close(); }
  // no identity (v1 mode): requireKeys has no effect, whatever cfg / opts say
  const v1 = startTeamServer({ name: 'neo', token: 't0k', requireKeys: true }, () => ({}), { requireKeys: true });
  const h3 = await listen(v1);
  try { assert.equal((await fetchPeer({ name: 'neo', host: h3 }, 't0k')).ok, true); } finally { v1.close(); }
});

// ── 14. beacon kid ──
// parseBeacon as 0.2.1 shipped it
function parseBeacon021(buf, rinfo) {
  let m; try { m = JSON.parse(buf.toString('utf-8')); } catch { return null; }
  if (!m || m.app !== 'agentdesk' || m.v !== 1) return null;
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof m.name !== 'string' || !/^[\w.\-가-힣 ]{1,40}$/.test(m.name) || !m.name.trim() || typeof m.id !== 'string' || !UUID_RE.test(m.id)) return null;
  return { name: m.name.trim(), host: `${rinfo.address}:${port}`, id: m.id.toLowerCase() };
}
test('beacon: optional kid (kept as an expectation only), a malformed one left out, ignored by the 0.2.1 parser', () => {
  const buf = encodeBeacon({ name: 'will', port: 7331, id: ID.will, kid: K.will.kid });
  const p = parseBeacon(buf, { address: '10.0.0.5' });
  assert.deepEqual([p.name, p.host, p.id, p.kid], ['will', '10.0.0.5:7331', ID.will, K.will.kid]);
  assert.deepEqual(parseBeacon021(buf, { address: '10.0.0.5' }), { name: 'will', host: '10.0.0.5:7331', id: ID.will });
  assert.equal(parseBeacon(encodeBeacon({ name: 'will', port: 7331, id: ID.will }), { address: '10.0.0.5' }).kid, undefined, 'no kid: an older AgentDesk');
  assert.ok(!encodeBeacon({ name: 'will', port: 7331, id: ID.will, kid: 'bad' }).toString().includes('bad'), 'a malformed kid is not sent');
  for (const kid of ['short', 42, '<script>'.padEnd(43, 'x'), K.will.kid + 'x']) {
    const forged = Buffer.from(JSON.stringify({ app: 'agentdesk', v: 1, name: 'will', port: 7331, id: ID.will, kid }));
    const p2 = parseBeacon(forged, { address: '10.0.0.5' });
    assert.deepEqual([p2.name, p2.id, 'kid' in p2], ['will', ID.will, false], String(kid));
  }
  assert.ok(buf.length < 512);
  assert.ok(!existsSync(join(dir, 'never')));
});

// ── security review M1 / L2 ──
test('M1: one IP signing with a new key per request still hits the per-IP cap (429), not the global one', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.me, peers: [pinned('will', '127.0.0.1:7441')] }, () => ({ at: 1, sessions: [] }), { identity: K.me });
  const host = await listen(server);
  const get = id => { const s = signRequest('t0k', 'GET', host, '/v1/sessions', '', Date.now(), { identity: id }); return fetch(`http://${host}/v1/sessions`, { headers: s.headers }); };
  try {
    const codes = [];
    for (let i = 0; i < NONCE_PER_IP; i++) { const r = await get(identityFromSeed(Buffer.from(String(i).padStart(32, 'x')))); codes.push(r.status); await r.arrayBuffer(); }
    assert.ok(codes.every(c => c === 200), 'the first 600 are served');
    const over = await get(identityFromSeed(Buffer.alloc(32, 9)));
    assert.equal(over.status, 429); assert.equal((await over.json()).error, 'busy-ip');
    // a pinned key has a bucket of its own: will is not locked out by the flood from his address
    assert.equal((await get(K.will)).status, 200);
  } finally { server.close(); }
});

test('M1: an unpinned key is refused (401 unknown key) everywhere but ping, sessions and hello', async () => {
  const { createDelegationStore } = await import('../team/remote.mjs');
  const store = createDelegationStore();
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.me, peers: [pinned('will', '127.0.0.1:7441')] }, () => ({ at: 1, sessions: [{ id: 'a', status: 'waiting' }] }), { identity: K.me, delegations: store, onNote: () => {}, onHello: () => ({ ok: true }) });
  const host = await listen(server);
  const call = (method, path, body = '', id = K.eve) => { const s = signRequest('t0k', method, host, path, body, Date.now(), { identity: id }); return fetch(`http://${host}${path}`, { method, headers: s.headers, body: body || undefined }); };
  const sid = globalThis.AgentDeskTeam.publicSessionId('a');
  try {
    assert.equal((await call('GET', '/v1/ping')).status, 200);
    assert.equal((await call('GET', '/v1/sessions')).status, 200);
    assert.equal((await call('POST', '/v1/hello', JSON.stringify({ v: 2, name: 'eve', port: 7441, pubkey: K.eve.pub }))).status, 200);
    for (const path of ['/v1/notes', `/v1/sessions/${sid}/input`, `/v1/sessions/${sid}/interrupt`, `/v1/sessions/${sid}/last`, `/v1/sessions/${sid}/screen`]) {
      const r = await call('POST', path, JSON.stringify({ to: 'a', text: 'x', grant: 'ab'.repeat(24) }));
      assert.equal(r.status, 401, path); assert.equal((await r.json()).error, 'unknown key', path);
    }
    assert.equal((await call('POST', '/v1/notes', JSON.stringify({ to: 'a', text: 'x' }), K.will)).status, 202, 'the pinned key is fine');
  } finally { server.close(); }
});

test('L2: only answers to a request whose HMAC checked out are key-signed', async () => {
  const server = startTeamServer({ name: 'neo', token: 't0k', instanceId: ID.me, peers: [] }, () => ({ at: 1, sessions: [] }), { identity: K.me });
  const host = await listen(server); const port = server.address().port;
  const get = (token, extra = {}) => { const s = signRequest(token, 'GET', host, '/v1/sessions', '', Date.now(), { identity: K.will }); return fetch(`http://${host}/v1/sessions`, { headers: { ...s.headers, ...extra } }).then(async r => ({ r, s, text: await r.text() })); };
  try {
    const bad = await get('not-the-token');
    assert.equal(bad.r.status, 401); assert.equal(JSON.parse(bad.text).error, 'bad signature');
    assert.ok(bad.r.headers.get('x-ad-sig'), 'HMAC-signed as before');
    for (const h of ['x-ad-ksig', 'x-ad-kid', 'x-ad-pub', 'x-ad-ver']) assert.equal(bad.r.headers.get(h), null, h);
    const skew = await (async () => { const s = signRequest('t0k', 'GET', host, '/v1/sessions', '', Date.now() - 200000, { identity: K.will }); const r = await fetch(`http://${host}/v1/sessions`, { headers: s.headers }); await r.text(); return r; })();
    assert.equal(skew.status, 401); assert.equal(skew.headers.get('x-ad-ksig'), null, 'clock skew: before the HMAC');
    // wrong host (before verification): HMAC only
    const other = `127.0.0.1:${port + 1}`, s = signRequest('t0k', 'GET', other, '/v1/sessions', '', Date.now(), { identity: K.will });
    const wh = await new Promise((resolve, reject) => import('node:http').then(http => http.get({ host: '127.0.0.1', port, path: '/v1/sessions', headers: { ...s.headers, Host: other } }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject)));
    assert.equal(wh.statusCode, 401); assert.equal(wh.headers['x-ad-ksig'], undefined);
    // past the HMAC: key-signed, failures included
    const ok = await get('t0k');
    assert.equal(ok.r.status, 200); assert.ok(ok.r.headers.get('x-ad-ksig'));
    const replay = await fetch(`http://${host}/v1/sessions`, { headers: ok.s.headers }); await replay.text();
    assert.equal(replay.status, 401); assert.ok(replay.headers.get('x-ad-ksig'), 'replayed (HMAC was fine): key-signed');
    const wp = await get('t0k', { 'X-AD-To': K.amy.kid });
    assert.equal(wp.r.status, 401); assert.equal(JSON.parse(wp.text).error, 'wrong peer');
    assert.ok(wp.r.headers.get('x-ad-ksig'), 'a key-layer refusal after a good HMAC is key-signed');
  } finally { server.close(); }
});
