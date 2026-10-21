// AgentDesk core: Jira ticket panel logic shared by the renderer (classic <script>) and the tests (CommonJS).
// Pure functions only — no DOM, no Electron. Inputs are `orca jira … --json` replies (shapes not pinned down by Orca's
// docs, so every reader accepts several plausible field names) and REPORT text captured from a terminal screen.
//
//   isKey(k)                         → true for "ABC-123"
//   normalizeIssue(raw)              → { key, summary, status, priority, assignee, labels, description, url, updated } | null
//   issuesFrom(res) / issueFrom(res) → normalized issues out of a list/search or an issue reply
//   connectionFrom(res)              → { connected, sites, error }
//   worktreeName(key)                → safe worktree name ("abc-123")
//   worktreePrompt(issue, opts)      → prompt for a fresh worktree agent (guidance first, autopilot appended)
//   sessionMessage(issue, guidance)  → message for an existing session: guidance first, then the ticket, then REPORT
//   extractReport(text)              → REPORT body or null (ignores the echoed format hint)
//   reportToComment(report, meta)    → plain-text Jira comment body, secrets masked
//   reportToCommentDraft(report, meta) → { text: that body, masked: [MASKED…] markers added in header + body }
//                                      (meta.maskWithCount, else globalThis.AgentDeskMask.maskWithCount)
//   jqlFor(filter)                   → JQL for the OAuth (REST) path: assigned | reported | all | done
//   textToAdf(text)                  → ADF doc for a REST comment (one paragraph per line, ``` fences → codeBlock)
//   tokenNeedsRefresh(tok, now)      → true when the OAuth access token is missing or expires within 60 s
//   pickSite(resources, preferUrl)   → the Jira site to use out of accessible-resources
// Kanban board (OAuth path):
//   boardJql(key, mine, order)       → JQL for one project's board (open + resolved in the last 30 days)
//   boardIssue(raw)                  → card data (status id/category, assignee id/avatar, due, type, subtasks)
//   buildColumns(issueTypes, prefs, boardCols) → [{ id, name, statusIds, cat, hidden }] (board config > statuses)
//   moveColumn(cols, id, dir)        → new column order (ids) after ◀ / ▶
//   groupIssues(cols, issues)        → Map columnId → issues (unknown status → first column of its category)
//   isOverdue(due, cat, now) · formatDue(due, lang) · priorityIcon(name) · typeIcon(name) · initials(name)
//   filterIssues(issues, { q, assignees }) → client-side board search and assignee chips
// Prompt helpers:
//   promptTemplates(lang)            → [{ id, label, text }] guidance presets (analyze / implement / review / report)
//   reportIssues(report)             → names of the REPORT sections that are missing or empty
//   rememberGuide(list, text, max)   → recent-guidance list with `text` moved to the front (deduped, capped)
(function (root) {
'use strict';
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const DESC_MAX = 2500, COMMENT_MAX = 30000;
const REPORT_HINT = 'REPORT_START [한 일] [변경 파일] [막힌 점] [다음 제안] REPORT_END';

function isKey(k) { return typeof k === 'string' && KEY_RE.test(k); }

// Atlassian Document Format → plain text (paragraphs, headings, list items and hard breaks become newlines)
function adfText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (typeof node !== 'object') return String(node);
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.text || '') + adfText(node.content);
  return /^(paragraph|heading|listItem|codeBlock|blockquote)$/.test(node.type || '') ? inner.replace(/\n?$/, '\n') : inner;
}
const nameOf = v => v == null ? '' : typeof v === 'string' ? v : (v.displayName || v.name || v.value || v.key || '');
const pick = (...vals) => { for (const v of vals) if (v != null && v !== '') return v; return null; };

function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  const key = pick(raw.key, raw.issueKey, f.key, isKey(raw.id) ? raw.id : null);
  if (!isKey(key)) return null;
  const labels = pick(raw.labels, f.labels) || [];
  const desc = pick(raw.descriptionText, raw.description, f.description, raw.body);
  return {
    key,
    summary: String(pick(raw.summary, f.summary, raw.title) || ''),
    status: nameOf(pick(raw.status, f.status, raw.statusName)),
    priority: nameOf(pick(raw.priority, f.priority)),
    assignee: nameOf(pick(raw.assignee, f.assignee, raw.assigneeName)),
    labels: Array.isArray(labels) ? labels.map(nameOf).filter(Boolean) : [],
    description: adfText(desc).replace(/\n{3,}/g, '\n\n').trim().slice(0, DESC_MAX),
    url: String(pick(raw.url, raw.webUrl, raw.browseUrl, raw.htmlUrl) || ''),
    updated: String(pick(raw.updated, f.updated, raw.updatedAt) || ''),
  };
}

const resultOf = res => (res && typeof res === 'object' && 'result' in res) ? res.result : res;
function issuesFrom(res) {
  const r = resultOf(res);
  const arr = Array.isArray(r) ? r : (r && (r.issues || r.items || r.results || r.rows || (r.data && r.data.issues))) || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeIssue).filter(Boolean);
}
function issueFrom(res) { const r = resultOf(res); return r ? normalizeIssue(r.issue || r) : null; }

function errorText(res) {
  if (!res || res.ok !== false) return '';
  const e = res.error; return typeof e === 'string' ? e : (e && (e.message || e.code)) || 'error';
}
function connectionFrom(res) {
  if (!res || res.ok === false) return { connected: false, sites: [], error: errorText(res) || 'no reply' };
  const r = resultOf(res) || {};
  const sites = Array.isArray(r.sites) ? r.sites : [];
  return { connected: !!(r.connected || sites.length), sites, error: '' };
}

function worktreeName(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'jira-ticket';
}

function ticketFacts(issue, en) {
  const out = [`${en ? 'Jira ticket' : 'Jira 티켓'} ${issue.key}: ${issue.summary}`];
  const meta = [issue.status && `${en ? 'status' : '상태'} ${issue.status}`, issue.priority && `${en ? 'priority' : '우선순위'} ${issue.priority}`, issue.labels && issue.labels.length && `${en ? 'labels' : '라벨'} ${issue.labels.join(', ')}`].filter(Boolean);
  if (meta.length) out.push(`(${meta.join(' · ')})`);
  if (issue.description) out.push(`${en ? 'Description' : '설명'}: ${issue.description}`);
  return out.join('\n');
}
const reportLine = en => en ? `When done, finish with ${REPORT_HINT}` : `작업이 끝나면 ${REPORT_HINT} 형식으로 마무리하세요.`;

function worktreePrompt(issue, opts) {
  const o = opts || {}, en = o.lang === 'en';
  const parts = [];
  const g = String(o.guidance || '').trim();
  if (g) parts.push(`${en ? 'Approach' : '접근 지침'}: ${g}`);
  parts.push(ticketFacts(issue, en));
  parts.push(en ? 'Work in this worktree. Do not commit or push unless the guidance says so.' : '이 워크트리에서 작업하세요. 지침에 없으면 커밋·푸시하지 마세요.');
  parts.push(reportLine(en));
  if (o.autopilot) parts.push('autopilot');
  return parts.join('\n\n');
}

function sessionMessage(issue, guidance, lang) {
  const en = lang === 'en', g = String(guidance || '').trim();
  if (!g) return '';
  return [
    `${en ? 'Before reading the ticket, here is how to approach it' : '티켓을 읽기 전에, 이렇게 접근해 주세요'}: ${g}`,
    ticketFacts(issue, en),
    reportLine(en),
  ].join('\n\n');
}

// last REPORT_START…REPORT_END block; null when absent or when it is only the echoed "[한 일] [변경 파일] …" hint
function extractReport(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('REPORT_START'); if (i < 0) return null;
  const j = s.indexOf('REPORT_END', i + 12);
  const body = s.slice(i + 12, j < 0 ? undefined : j).trim();
  if (!body.replace(/\[[^\]]*\]/g, '').trim()) return null;
  return body;
}

function reportToCommentDraft(report, meta) {
  const m = meta || {}, en = m.lang === 'en';
  const body = String(report || '').replace(/REPORT_(START|END)/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const head = `${en ? 'AgentDesk agent report' : 'AgentDesk 에이전트 보고'}${m.session ? ` (${m.session})` : ''}`;
  // masked before the length cap; the main process masks again before anything is sent (this one is for the preview)
  const maskFn = m.maskWithCount || (root.AgentDeskMask && root.AgentDeskMask.maskWithCount);
  if (typeof maskFn !== 'function') throw new Error('reportToComment: core/mask.js is not loaded');
  const r = maskFn(`${head}\n\n${body}`);
  return { text: r.text.slice(0, COMMENT_MAX), masked: r.count };
}
function reportToComment(report, meta) { return reportToCommentDraft(report, meta).text; }

const JQL = {
  assigned: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  reported: 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  all: '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated DESC',
  done: 'assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC',
};
function jqlFor(filter) { return JQL[filter] || JQL.assigned; }

function textToAdf(text) {
  const content = [], lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      const block = { type: 'codeBlock', content: code.join('\n') ? [{ type: 'text', text: code.join('\n') }] : [] };
      if (fence[1]) block.attrs = { language: fence[1] };
      content.push(block);
    } else if (lines[i].trim()) content.push({ type: 'paragraph', content: [{ type: 'text', text: lines[i].replace(/\s+$/, '') }] });
  }
  return { type: 'doc', version: 1, content };
}

function tokenNeedsRefresh(tok, now, skewMs) {
  return !tok || !tok.accessToken || !tok.expiresAt || tok.expiresAt - (now == null ? Date.now() : now) < (skewMs == null ? 60000 : skewMs);
}

// only sites the token can read Jira on; the preferred URL wins when present, otherwise the first one
function jiraSites(resources) { return (Array.isArray(resources) ? resources : []).filter(r => r && r.id && (!Array.isArray(r.scopes) || r.scopes.some(x => /jira/.test(x)))); }
function pickSite(resources, preferUrl) {
  const sites = jiraSites(resources);
  const norm = u => String(u || '').replace(/\/+$/, '').toLowerCase();
  return sites.find(r => preferUrl && norm(r.url) === norm(preferUrl)) || sites[0] || null;
}

const CAT_RANK = { new: 0, indeterminate: 1, done: 2 };
const catOf = st => { const k = st && st.statusCategory && st.statusCategory.key; return k in CAT_RANK ? k : 'indeterminate'; };
function boardJql(key, mine, order) {
  return `project = "${key}" AND (statusCategory != Done OR resolved >= -30d)${mine ? ' AND assignee = currentUser()' : ''} ORDER BY ${order === 'updated' ? 'updated DESC' : 'rank ASC'}`;
}
function boardIssue(raw) {
  if (!raw || !isKey(raw.key)) return null;
  const f = raw.fields || {}, a = f.assignee || null, subs = Array.isArray(f.subtasks) ? f.subtasks : [];
  return {
    key: raw.key, summary: String(f.summary || ''),
    statusId: f.status && f.status.id != null ? String(f.status.id) : '', status: nameOf(f.status), cat: catOf(f.status),
    priority: nameOf(f.priority), assignee: a ? nameOf(a) : '', assigneeId: a ? String(a.accountId || '') : '', avatar: a && a.avatarUrls ? (a.avatarUrls['24x24'] || '') : '',
    due: String(f.duedate || ''), type: nameOf(f.issuetype), labels: Array.isArray(f.labels) ? f.labels : [], description: '',
    subtasks: subs.length ? { done: subs.filter(x => catOf(x && x.fields && x.fields.status) === 'done').length, total: subs.length } : null,
    updated: String(f.updated || ''),
  };
}
// issueTypes: GET /project/{key}/statuses ([{ statuses: [...] }]); boardCols: agile columnConfig as [{ name, statusIds }]
function buildColumns(issueTypes, prefs, boardCols) {
  const seen = new Map();
  for (const it of Array.isArray(issueTypes) ? issueTypes : []) for (const st of (it && it.statuses) || []) {
    if (st && st.id != null && !seen.has(String(st.id))) seen.set(String(st.id), { id: String(st.id), name: String(st.name || ''), cat: catOf(st) });
  }
  let cols;
  if (Array.isArray(boardCols) && boardCols.length) {
    cols = boardCols.map(c => {
      const ids = (c.statusIds || []).map(String), first = ids.map(id => seen.get(id)).find(Boolean);
      return { id: 'b:' + c.name, name: String(c.name || ''), statusIds: ids, cat: first ? first.cat : 'indeterminate' };
    });
  } else {
    cols = [...seen.values()].map((st, i) => ({ id: st.id, name: st.name, statusIds: [st.id], cat: st.cat, i }))
      .sort((a, b) => CAT_RANK[a.cat] - CAT_RANK[b.cat] || a.i - b.i).map(({ i, ...c }) => c);
  }
  const p = prefs || {}, order = Array.isArray(p.order) ? p.order : [], hidden = new Set(Array.isArray(p.hidden) ? p.hidden : []);
  const byId = new Map(cols.map(c => [c.id, c]));
  const ordered = order.filter(id => byId.has(id)).map(id => byId.get(id));
  for (const c of cols) if (!ordered.includes(c)) ordered.push(c);
  return ordered.map(c => ({ ...c, hidden: hidden.has(c.id) }));
}
function moveColumn(cols, id, dir) {
  const ids = cols.map(c => c.id), i = ids.indexOf(id), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}
function groupIssues(cols, issues) {
  const out = new Map(cols.filter(c => !c.hidden).map(c => [c.id, []]));
  const byStatus = new Map();
  for (const c of cols) for (const id of c.statusIds) if (!byStatus.has(id)) byStatus.set(id, c);
  const visible = cols.filter(c => !c.hidden);
  for (const i of issues || []) {
    const c = byStatus.get(i.statusId);
    if (c && c.hidden) continue;   // the user hid that column
    const target = c || visible.find(x => x.cat === i.cat) || visible[0];
    if (target) out.get(target.id).push(i);
  }
  return out;
}
function isOverdue(due, cat, now) {
  if (!due || cat === 'done' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime() <= (now == null ? Date.now() : now);   // past the end of the due day (local time)
}
function formatDue(due, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due || ''); if (!m) return '';
  if (lang === 'en') return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return `${+m[1]}년 ${+m[2]}월 ${+m[3]}일`;
}
const PRIORITY = [[/highest|blocker|critical|긴급|최상/i, '⇈', 'highest'], [/high|major|높음|상/i, '↑', 'high'], [/lowest|trivial|최하/i, '⇊', 'lowest'], [/low|minor|낮음|하/i, '↓', 'low'], [/medium|normal|보통|중/i, '=', 'medium']];
function priorityIcon(name) {
  for (const [re, icon, cls] of PRIORITY) if (re.test(name || '')) return { icon, cls };
  return { icon: name ? '=' : '', cls: 'medium' };
}
function typeIcon(name) {
  const n = String(name || '').toLowerCase();
  if (/bug|버그/.test(n)) return { icon: '●', cls: 'bug' };
  if (/epic|에픽/.test(n)) return { icon: '⚡', cls: 'epic' };
  if (/sub|하위/.test(n)) return { icon: '↳', cls: 'sub' };
  if (/story|스토리/.test(n)) return { icon: '▮', cls: 'story' };
  return { icon: '✓', cls: 'task' };
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (/[가-힣]/.test(parts[0])) return parts[0].slice(-2);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function filterIssues(issues, opts) {
  const o = opts || {}, words = String(o.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const who = o.assignees && o.assignees.size ? o.assignees : null;
  return (issues || []).filter(i => {
    if (who && !who.has(i.assigneeId || '')) return false;
    const hay = `${i.key} ${i.summary}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

const SECTIONS = ['한 일', '변경 파일', '막힌 점', '다음 제안'];
function reportIssues(report) {
  const s = String(report || '');
  return SECTIONS.filter(name => {
    const at = s.indexOf(`[${name}]`); if (at < 0) return true;
    const rest = s.slice(at + name.length + 2), next = rest.search(/\[(한 일|변경 파일|막힌 점|다음 제안)\]/);
    return !(next < 0 ? rest : rest.slice(0, next)).replace(/^[\s:：\-–—]+/, '').trim();
  });
}
function rememberGuide(list, text, max) {
  const g = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  const rest = (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x !== g);
  return (g ? [g, ...rest] : rest).slice(0, max || 8);
}
function promptTemplates(lang) {
  const en = lang === 'en';
  return [
    { id: 'analyze', label: en ? 'Analyze' : '분석만', text: en ? 'Analyze the cause and impact only. Do not change code. List the files to touch and the risks.' : '원인과 영향 범위만 분석하세요. 코드는 고치지 마세요. 손댈 파일과 위험 요소를 정리하세요.' },
    { id: 'implement', label: en ? 'Implement' : '구현', text: en ? 'Make the smallest change that satisfies the ticket, add or update tests, and run them. Do not commit or push.' : '티켓을 만족하는 가장 작은 변경으로 구현하고, 테스트를 추가·수정해 실행하세요. 커밋·푸시는 하지 마세요.' },
    { id: 'review', label: en ? 'Review' : '리뷰', text: en ? 'Review the current changes against the ticket. Point out bugs, missing cases and risky spots with file:line. Do not edit code.' : '현재 변경을 티켓 기준으로 리뷰하세요. 버그·누락된 경우·위험한 곳을 file:line과 함께 짚고 코드는 고치지 마세요.' },
    { id: 'report', label: en ? 'Report' : '보고만', text: en ? 'Do not change anything. Summarize the current state of this work for the ticket.' : '아무것도 바꾸지 말고, 지금까지의 작업 상태를 티켓에 남길 수 있게 정리하세요.' },
  ];
}

const AgentDeskJira = { promptTemplates, reportIssues, rememberGuide, boardJql, boardIssue, buildColumns, moveColumn, groupIssues, isOverdue, formatDue, priorityIcon, typeIcon, initials, filterIssues, jqlFor, textToAdf, tokenNeedsRefresh, jiraSites, pickSite, KEY_RE, REPORT_HINT, isKey, adfText, normalizeIssue, issuesFrom, issueFrom, connectionFrom, errorText, worktreeName, worktreePrompt, sessionMessage, extractReport, reportToComment, reportToCommentDraft };
// the widget loads this as a classic <script> (one global); tests `import()` it and read globalThis.AgentDeskJira
root.AgentDeskJira = AgentDeskJira;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskJira;
})(typeof globalThis !== 'undefined' ? globalThis : this);
