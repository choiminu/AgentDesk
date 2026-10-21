// Jira through Atlassian OAuth 2.0 (3LO), for users who cannot use Orca's API-token Jira connection.
// Everything (client id/secret, tokens, chosen site) lives in ~/.agentdesk/jira-oauth.enc, encrypted with Electron
// safeStorage (OS keychain). Tokens, codes and the client secret never reach the renderer, logs or error messages.
// Refresh tokens ROTATE on every refresh, so refreshes are serialized and the new token is persisted before use.
import { safeStorage, shell } from "electron";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import "./core/jira.js";
const J = globalThis.AgentDeskJira;

export const OAUTH_PORT = 47391;
export const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/callback`;
const SCOPES = "read:jira-work read:jira-user write:jira-work offline_access";
const AUTH_URL = "https://auth.atlassian.com/authorize", TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const PREFERRED_SITE = process.env.AGENTDESK_JIRA_SITE || "";   // optional: a site URL to prefer when the account can see several; otherwise the first Jira site
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DIR = join(homedir(), ".agentdesk"), FILE = join(DIR, "jira-oauth.enc");

// ── encrypted store ──
function load() {
  if (!existsSync(FILE) || !safeStorage.isEncryptionAvailable()) return {};
  try { return JSON.parse(safeStorage.decryptString(readFileSync(FILE))); } catch { return {}; }
}
function save(data) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 시스템에서는 암호화 저장소(safeStorage)를 쓸 수 없어 OAuth 정보를 저장하지 않습니다.");
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
  renameSync(tmp, FILE);
}
const dropTokens = d => { const { accessToken, refreshToken, expiresAt, ...rest } = d; return rest; };

export function status() {
  const d = load();
  return {
    encryption: safeStorage.isEncryptionAvailable(), redirectUri: REDIRECT_URI,
    clientId: d.clientId || "", hasSecret: !!d.clientSecret,
    connected: !!(d.refreshToken && d.cloudId), siteUrl: d.siteUrl || "", siteName: d.siteName || "",
    sites: (d.sites || []).map(s => ({ id: s.id, url: s.url, name: s.name })),
    loggingIn: !!loginInFlight,
  };
}
export function connected() { const d = load(); return !!(d.refreshToken && d.cloudId); }

export function saveCredentials(clientId, clientSecret) {
  clientId = String(clientId || "").trim(); clientSecret = String(clientSecret || "").trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) throw new Error("Client ID 형식이 올바르지 않습니다.");
  if (clientSecret && clientSecret.length > 500) throw new Error("Client Secret이 너무 깁니다.");
  let d = load();
  if (!clientSecret && !d.clientSecret) throw new Error("Client Secret을 입력하세요.");
  if (d.clientId && d.clientId !== clientId) d = dropTokens(d);   // another app: old tokens are useless
  save({ ...d, clientId, clientSecret: clientSecret || d.clientSecret });
  return status();
}
// logout forgets everything (tokens and the client id/secret): the encrypted file is deleted
export function logout() { try { unlinkSync(FILE); } catch {} agileDenied = false; return status(); }

// ── token endpoint (error text carries only Atlassian's error code/description, never request values) ──
async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const e = new Error(`Atlassian 토큰 요청 실패 (HTTP ${res.status}${j.error ? `, ${j.error}` : ""})`);
    e.invalidGrant = j.error === "invalid_grant" || res.status === 403;
    throw e;
  }
  return j;
}
const tokenFields = j => ({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 });

let refreshInFlight = null;
async function getAccessToken(force) {
  const d = load();
  if (!d.refreshToken) throw new Error("Atlassian 로그인이 필요합니다.");
  if (!force && !J.tokenNeedsRefresh(d)) return d.accessToken;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const cur = load();   // re-read: another refresh may have rotated the token meanwhile
      if (!force && !J.tokenNeedsRefresh(cur)) return cur.accessToken;
      try {
        const j = await tokenRequest({ grant_type: "refresh_token", client_id: cur.clientId, client_secret: cur.clientSecret, refresh_token: cur.refreshToken });
        const next = { ...cur, ...tokenFields(j) };
        if (!j.refresh_token) next.refreshToken = cur.refreshToken;
        save(next);
        return next.accessToken;
      } catch (e) {
        if (e.invalidGrant) { save(dropTokens(load())); throw new Error("Atlassian 로그인이 만료되었습니다. Jira 탭에서 다시 로그인하세요."); }
        throw e;
      }
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function apiFetch(url, opts = {}, retried = false) {
  const token = await getAccessToken(false);
  const res = await fetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (res.status === 401 && !retried) { await getAccessToken(true); return apiFetch(url, opts, true); }
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = j && (j.errorMessages || []).concat(Object.values(j.errors || {})).join("; ");
    throw new Error(`Jira API HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`);
  }
  return j;
}
function jiraUrl(path, api = "api/3") {
  const d = load();
  if (!d.cloudId) throw new Error("Jira 사이트가 선택되지 않았습니다.");
  return `https://api.atlassian.com/ex/jira/${encodeURIComponent(d.cloudId)}/rest/${api}${path}`;
}

async function refreshSites() {
  const token = await getAccessToken(false);
  const res = await fetch(RESOURCES_URL, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`accessible-resources HTTP ${res.status}`);
  const all = await res.json();
  const sites = J.jiraSites(all).map(r => ({ id: r.id, url: r.url, name: r.name }));
  const d = load();
  const pick = sites.find(s => s.id === d.cloudId) || J.pickSite(sites, PREFERRED_SITE);
  save({ ...d, sites, cloudId: pick ? pick.id : "", siteUrl: pick ? pick.url : "", siteName: pick ? pick.name : "" });
  if (!pick) throw new Error("이 계정으로 접근할 수 있는 Jira 사이트가 없습니다.");
}
export function chooseSite(cloudId) {
  const d = load(); const s = (d.sites || []).find(x => x.id === cloudId);
  if (!s) throw new Error("알 수 없는 사이트입니다.");
  save({ ...d, cloudId: s.id, siteUrl: s.url, siteName: s.name });
  return status();
}

// ── login: one-shot loopback server for the authorization code ──
let loginInFlight = null;
export function login() {
  if (loginInFlight) return loginInFlight;
  const d = load();
  if (!safeStorage.isEncryptionAvailable()) return Promise.reject(new Error("암호화 저장소(safeStorage)를 쓸 수 없어 로그인할 수 없습니다."));
  if (!d.clientId || !d.clientSecret) return Promise.reject(new Error("먼저 Client ID와 Client Secret을 저장하세요."));
  const state = randomBytes(24).toString("hex");
  loginInFlight = new Promise((resolve, reject) => {
    const servers = [];
    let finished = false;
    const finish = (err, code) => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      for (const s of servers) { try { s.close(); } catch {} }
      if (err) reject(err); else resolve(code);
    };
    const timer = setTimeout(() => finish(new Error("로그인 시간이 초과되었습니다 (5분).")), LOGIN_TIMEOUT_MS);
    const handler = (req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ok ? "AgentDesk에 연결되었습니다. 이 창을 닫아도 됩니다." : "AgentDesk 로그인에 실패했습니다. 위젯에서 다시 시도하세요.");
      if (u.searchParams.get("error")) finish(new Error(`Atlassian이 로그인을 거부했습니다 (${String(u.searchParams.get("error")).slice(0, 60)})`));
      else if (u.searchParams.get("state") !== state) finish(new Error("로그인 응답의 state가 일치하지 않습니다."));
      else if (ok) finish(null, u.searchParams.get("code"));
    };
    const main = createServer(handler); servers.push(main);
    main.on("error", e => finish(new Error(e.code === "EADDRINUSE" ? `포트 ${OAUTH_PORT}이(가) 이미 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 시도하세요.` : `로그인 서버를 열지 못했습니다 (${e.code || e.message})`)));
    main.listen(OAUTH_PORT, "127.0.0.1", () => {
      // "localhost" may resolve to ::1 in the browser; listen there too when the system has IPv6 loopback (best effort)
      const v6 = createServer(handler); v6.on("error", () => {}); v6.listen(OAUTH_PORT, "::1"); servers.push(v6);
      const q = new URLSearchParams({ audience: "api.atlassian.com", client_id: d.clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state, response_type: "code", prompt: "consent" });
      shell.openExternal(`${AUTH_URL}?${q}`).catch(() => finish(new Error("브라우저를 열지 못했습니다.")));
    });
  }).then(async code => {
    const cur = load();
    const j = await tokenRequest({ grant_type: "authorization_code", client_id: cur.clientId, client_secret: cur.clientSecret, code, redirect_uri: REDIRECT_URI });
    save({ ...cur, ...tokenFields(j) });
    await refreshSites();
    return status();
  }).finally(() => { loginInFlight = null; });
  return loginInFlight;
}

// ── Jira calls; replies mimic the Orca CLI envelope ({ ok, result }) so the renderer parses one shape ──
const FIELDS = ["summary", "status", "priority", "assignee", "duedate", "updated", "labels", "description"];
export async function list(filter, limit) {
  const j = await apiFetch(jiraUrl("/search/jql"), { method: "POST", body: JSON.stringify({ jql: J.jqlFor(filter), maxResults: limit, fields: FIELDS }) });
  return { ok: true, result: { issues: (j && j.issues) || [] } };
}
export async function search(jql, limit) {
  const j = await apiFetch(jiraUrl("/search/jql"), { method: "POST", body: JSON.stringify({ jql, maxResults: limit, fields: FIELDS }) });
  return { ok: true, result: { issues: (j && j.issues) || [] } };
}
export async function issue(key) {
  if (!J.isKey(key)) throw new Error("invalid Jira key");
  return { ok: true, result: await apiFetch(jiraUrl(`/issue/${key}?fields=summary,description,status,priority,assignee,labels`)) };
}
// the only write this app ever makes with write:jira-work
export async function comment(key, text) {
  if (!J.isKey(key)) throw new Error("invalid Jira key");
  const j = await apiFetch(jiraUrl(`/issue/${key}/comment`), { method: "POST", body: JSON.stringify({ body: J.textToAdf(text) }) });
  return { ok: true, result: { id: j && j.id } };
}
export function connectionResult() {
  const d = load();
  return { ok: true, result: { connected: true, via: "oauth", sites: [{ id: d.cloudId, url: d.siteUrl, name: d.siteName }] } };
}

// ── Kanban board: projects, columns (agile board config when the token may read it, else project statuses), issues ──
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;
const BOARD_FIELDS = ["summary", "status", "priority", "assignee", "duedate", "issuetype", "subtasks", "labels", "updated", "resolutiondate"];
const BOARD_MAX = 300;
let agileDenied = false;   // the app has no Jira Software scopes → stop asking (and never trigger a token refresh for it)
export async function projects() {
  const j = await apiFetch(jiraUrl("/project/search?maxResults=50&orderBy=-lastIssueUpdatedTime"));
  return { ok: true, result: { projects: ((j && j.values) || []).map(p => ({ id: p.id, key: p.key, name: p.name })) } };
}
async function agileColumns(key) {
  if (agileDenied) return null;
  try {
    const b = await apiFetch(jiraUrl(`/board?projectKeyOrId=${key}&maxResults=10`, "agile/1.0"), {}, true);
    const vals = (b && b.values) || [], board = vals.find(v => v.type === "kanban") || vals[0];
    if (!board) return null;
    const c = await apiFetch(jiraUrl(`/board/${encodeURIComponent(board.id)}/configuration`, "agile/1.0"), {}, true);
    const cols = (c && c.columnConfig && c.columnConfig.columns) || [];
    return cols.length ? cols.map(x => ({ name: x.name, statusIds: (x.statuses || []).map(s => String(s.id)) })) : null;
  } catch (e) { if (/HTTP 40[13]/.test(e.message)) agileDenied = true; return null; }
}
async function boardSearch(key, mine, order) {
  const issues = []; let token;
  do {
    const body = { jql: J.boardJql(key, mine, order), maxResults: 100, fields: BOARD_FIELDS };
    if (token) body.nextPageToken = token;
    const j = await apiFetch(jiraUrl("/search/jql"), { method: "POST", body: JSON.stringify(body) });
    issues.push(...((j && j.issues) || []));
    token = j && !j.isLast ? j.nextPageToken : null;
  } while (token && issues.length < BOARD_MAX);
  return { issues: issues.slice(0, BOARD_MAX), truncated: !!token };
}
export async function board(key, mine) {
  if (!PROJECT_KEY_RE.test(key || "")) throw new Error("invalid project key");
  const [statuses, boardColumns, me] = await Promise.all([
    apiFetch(jiraUrl(`/project/${key}/statuses`)),
    agileColumns(key),
    apiFetch(jiraUrl("/myself")).catch(() => null),
  ]);
  let found;
  try { found = await boardSearch(key, !!mine, "rank"); }
  catch { found = await boardSearch(key, !!mine, "updated"); }   // projects without a rank field reject ORDER BY rank
  return { ok: true, result: {
    statuses: Array.isArray(statuses) ? statuses : [], boardColumns, ...found,
    me: me ? { accountId: me.accountId, displayName: me.displayName, avatar: (me.avatarUrls && me.avatarUrls["24x24"]) || "" } : null,
  } };
}
