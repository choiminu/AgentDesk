// AgentDesk core: the review queue (📥 in the header) — one list of everything waiting for the owner, built from state
// the renderer already keeps. Pure functions only — no DOM, no timers, no storage of its own; the caller passes `now`.
//
//   buildInbox(input, opts) → [{ kind, id, title, detail, at, severity: 'high'|'normal'|'low', target }]
//     input: { jiraDispatch, sessions, peerNotes, permRequests, teamStatus, usage, now, lang }
//     opts:  { kinds: { <kind>: false } }  a kind set to false is left out (settings toggle); missing = on
//   Sorted by severity (high → normal → low), then oldest `at` first (at 0 / unknown = now), then id. At most
//   MAX_ITEMS items. id / target fields are exact (lookup keys); title / detail are cut and cleaned (display).
//
// Kinds — when an item is included, and how urgent it is:
//   perm         high    a widget permission request (permRequests[], not expired) whose session is on the dashboard
//   perm-orphan  high    the same, but its session is gone from the dashboard (r.orphan === true)
//   peer-ask     high    a teammate session delegated to me that needs the owner's approval (needsInput, not ended)
//                normal  … or is waiting for input (status 'waiting', not ended). Only connected teammates (p.ok).
//                        Mirrors core/notify.js stateOf 'ask' / 'input'.
//   usage        high    5-hour or weekly plan limit at or past the second level (default 95 %)
//                normal  at or past the first level (default 80 %), or forecast to run out within 30 minutes
//   jira-report  normal  a dispatched Jira ticket whose REPORT arrived (state 'report'): the comment draft waits
//   hello        normal  a signed teammate registration / address-change request (teamStatus.pending)
//   note         normal  a teammate's note not yet delivered or ignored (peerNotes[].state === 'new')
//   stuck        normal  one of my sessions running with no tool call or reply past the threshold (s.stuck === true)
//   diff         low     a REPORT arrived and its "변경 보기" (changed files) was not opened yet (s.diffUnseen === true)
// Team kinds (peer-ask, hello) need team sharing configured without error. Text that comes from outside (teammate
// and session names, note text, commands, ticket summaries) is cut to a fixed length and stripped of bidi controls.
(function (root) {
'use strict';
const KINDS = ['perm', 'perm-orphan', 'peer-ask', 'usage', 'jira-report', 'hello', 'note', 'stuck', 'diff'];
const SEV_ORDER = { high: 0, normal: 1, low: 2 };
const MAX_ITEMS = 100;
const LIMIT = { name: 40, title: 80, detail: 160 };
const USAGE_SOON_MS = 30 * 60000;
// C0 / DEL / C1 controls, bidi marks, embeddings, overrides and isolates (LRM/RLM U+200E-200F, ALM U+061C,
// U+202A-202E, U+2066-2069) and the BOM / zero-width no-break space U+FEFF: shown text must not reorder the panel
const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function clip(s, n) {
  const v = String(s == null ? '' : s).replace(CTRL_RE, '').replace(/\s+/g, ' ').trim();
  const a = [...v];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : v;
}
const name = s => clip(s, LIMIT.name);
// ids that the renderer looks things up by (permission request id, note id, hello key, session id): exact, never cut
const rawId = v => String(v == null ? '' : v);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function permItems(list, now, en) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    if (num(r.expiresAt) && num(r.expiresAt) <= now) continue;
    const sm = r.summary || {};
    const what = sm.kind === 'bash' ? sm.command : sm.kind === 'edit' ? sm.filePath : sm.text;
    const orphan = r.orphan === true;
    out.push({
      kind: orphan ? 'perm-orphan' : 'perm', id: rawId(r.id),
      title: clip(`${name(r.name || String(r.sessionId || '').slice(0, 8))} · ${clip(sm.tool || '', 30)}`, LIMIT.title),
      detail: clip(orphan ? `${en ? 'session no longer on the dashboard' : '대시보드에 없는 세션'} · ${what || ''}` : what, LIMIT.detail),
      at: num(r.createdAt), severity: 'high',
      target: { page: 'dashboard', sessionId: orphan ? '' : rawId(r.localId), permId: rawId(r.id) },
    });
  }
  return out;
}

function teamOn(st) { return !!(st && st.configured && !st.error); }

function peerAskItems(st, en) {
  const out = [];
  if (!teamOn(st)) return out;
  for (const p of Object.values(st.peers || {})) {
    if (!p || !p.ok) continue;
    const mine = new Set((Array.isArray(p.delegatedToMe) ? p.delegatedToMe : []).map(d => d && d.sessionId).filter(Boolean));
    if (!mine.size) continue;
    for (const s of Array.isArray(p.sessions) ? p.sessions : []) {
      if (!s || !mine.has(s.id) || s.ended === true) continue;
      if (s.status === 'error' || s.status === 'done') continue;
      const ask = s.needsInput === true, input = !ask && s.status === 'waiting';
      if (!ask && !input) continue;
      out.push({
        kind: 'peer-ask', id: rawId(`${p.name}/${s.id}`),
        title: clip(`@${name(p.name)} / ${name(s.name || s.id)}`, LIMIT.title),
        detail: ask ? (en ? 'needs the owner\'s approval' : '주인 승인 필요') : (en ? 'ready for input' : '입력 가능'),
        at: num(s.askSince) || num(s.time), severity: ask ? 'high' : 'normal',
        target: { page: 'team', peer: rawId(p.name), sessionId: rawId(s.id) },
      });
    }
  }
  return out;
}

function helloItems(st, en) {
  if (!teamOn(st)) return [];
  return (Array.isArray(st.pending) ? st.pending : []).filter(p => p && p.key).map(p => {
    const ip = String(p.host || '').split(':')[0];
    const move = p.kind === 'move';
    return {
      kind: 'hello', id: rawId(p.key),
      title: clip(move ? `@${name(p.existing)}` : `${name(p.name)} (${clip(ip, 45)})`, LIMIT.title),
      detail: clip(move ? (en ? `new address: ${p.from} → ${p.host}` : `주소 변경: ${p.from} → ${p.host}`) : (en ? 'asked to join your team list' : '팀원 등록 요청'), LIMIT.detail),
      at: num(p.at), severity: 'normal', target: { page: 'team', key: rawId(p.key) },
    };
  });
}

function noteItems(notes) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && n.id && n.state === 'new').map(n => ({
    kind: 'note', id: rawId(n.id),
    title: clip(`@${name(n.from)} → ${name(n.toName || n.to)}`, LIMIT.title),
    detail: clip(n.text, LIMIT.detail), at: num(n.at), severity: 'normal',
    target: { page: 'team', peer: rawId(n.from) },
  }));
}

function jiraItems(dispatch, en) {
  return Object.values(dispatch && typeof dispatch === 'object' ? dispatch : {}).filter(d => d && d.key && d.state === 'report').map(d => ({
    kind: 'jira-report', id: rawId(d.key),
    title: clip(`${clip(d.key, 30)} ${d.summary || ''}`, LIMIT.title),
    detail: en ? 'report arrived — review the comment draft' : '보고 도착 — 댓글 초안 확인',
    at: num(d.reportAt) || num(d.sentAt), severity: 'normal',
    target: { page: 'jira', ticket: rawId(d.key) },
  }));
}

function sessionItems(list, en) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.id) continue;
    if (s.stuck === true && s.status === 'running') out.push({
      kind: 'stuck', id: rawId(s.id), title: clip(name(s.name || s.id), LIMIT.title),
      detail: en ? 'no tool call or reply for a while' : '도구 호출이나 응답이 한동안 없음',
      at: num(s.stuckSince), severity: 'normal', target: { page: 'dashboard', sessionId: rawId(s.id) },
    });
    if (s.diffUnseen === true) out.push({
      kind: 'diff', id: rawId(s.id), title: clip(name(s.name || s.id), LIMIT.title),
      detail: en ? 'report arrived — changed files not viewed yet' : '보고 도착 — 바뀐 파일 아직 안 봄',
      at: num(s.reportAt), severity: 'low', target: { page: 'dashboard', sessionId: rawId(s.id) },
    });
  }
  return out;
}

// usage: { levels: [l1, l2], at, s: { pct, etaMs, confidence }, w: … } — pct and etaMs (forecast) may be null;
// a forecast with confidence 'low' never counts as "runs out soon" on its own
function usageItems(u, en) {
  if (!u || typeof u !== 'object') return [];
  const lv = Array.isArray(u.levels) && u.levels.length === 2 ? u.levels.map(Number) : [80, 95];
  const out = [];
  for (const k of ['s', 'w']) {
    const w = u[k]; if (!w) continue;
    const pct = w.pct == null ? NaN : Number(w.pct), eta = w.etaMs == null ? NaN : Number(w.etaMs);
    const over = Number.isFinite(pct) && pct >= lv[0], soon = Number.isFinite(eta) && eta > 0 && eta <= USAGE_SOON_MS && w.confidence !== 'low';
    if (!over && !soon) continue;
    const label = k === 's' ? (en ? '5-hour limit' : '5시간 한도') : (en ? 'Weekly limit' : '주간 한도');
    const min = soon ? Math.max(1, Math.round(eta / 60000)) : 0;
    out.push({
      kind: 'usage', id: k, title: `${label} ${Number.isFinite(pct) ? Math.round(pct) + '%' : ''}`.trim(),
      detail: soon ? (en ? `at this pace it runs out in ${min} min` : `이 속도면 ${min}분 뒤 소진`) : (en ? 'past the warning level' : '경고 임계값 넘음'),
      at: num(u.at), severity: Number.isFinite(pct) && pct >= lv[1] ? 'high' : 'normal', target: { page: 'dashboard' },
    });
  }
  return out;
}

function buildInbox(input, opts) {
  const i = input && typeof input === 'object' ? input : {};
  const off = (opts && opts.kinds) || {};
  const now = num(i.now) || 0, en = i.lang !== 'ko';
  const all = [
    ...permItems(i.permRequests, now, en),
    ...peerAskItems(i.teamStatus, en),
    ...usageItems(i.usage, en),
    ...jiraItems(i.jiraDispatch, en),
    ...helloItems(i.teamStatus, en),
    ...noteItems(i.peerNotes),
    ...sessionItems(i.sessions, en),
  ].filter(x => off[x.kind] !== false);
  for (const x of all) if (!x.at) x.at = now;   // unknown time counts as "now": it must not jump ahead of real old items
  all.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.at - b.at || (a.kind + a.id < b.kind + b.id ? -1 : a.kind + a.id > b.kind + b.id ? 1 : 0));
  return all.slice(0, MAX_ITEMS);
}

// settings value (localStorage roca-inbox): { kinds: { <kind>: false } } — unknown kinds and non-false values dropped
function normalizePrefs(v) {
  const k = (v && typeof v === 'object' && v.kinds && typeof v.kinds === 'object') ? v.kinds : {};
  const kinds = {};
  for (const x of KINDS) if (k[x] === false) kinds[x] = false;
  return { kinds };
}

const AgentDeskInbox = { KINDS, LIMIT, MAX_ITEMS, buildInbox, normalizePrefs, clip };
root.AgentDeskInbox = AgentDeskInbox;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskInbox;
})(typeof globalThis !== 'undefined' ? globalThis : this);
