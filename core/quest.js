// AgentDesk core: Quest board pure helpers (Jira tickets as quests, party of live sessions, front-desk prompt and answer check).
// No DOM, no Electron, no I/O. Loaded as a classic <script> (global AgentDeskQuest) or required from main.
//
//   difficulty(priorityName)             → 0 | 1 | 2 | 3   Highest/High 3, Medium 2, Low/Lowest 1, none 0, unknown 2
//   groupOf(issue, state, liveIds)       → 'new' | 'doing' | 'report' | 'done'   state = this ticket's entry; AgentDesk state wins
//   questView(issues, stateFile, liveIds)→ [{ key, title, difficulty, group, status, due?, assignee?, quest?: { kind, sessionId?, repo?, at, reportAt?, ended? } }]
//   partyOf(sessions, handles)           → [{ id, name, repo, branch, status, eligible, doing, skills[] }]  my live interactive sessions
//   deskPrompt(issue, party, repos)      → string (the front-desk input; the caller masks it before sending)
//   DESK_SCHEMA                          → JSON schema string for { choice, reason }
//   acceptProposal(answer, party, repos) → { kind: 'session', id } | { kind: 'worktree', repo } | null
//   pruneState(stateFile, issues, now)   → new state file without tickets done in Jira more than 30 days ago
(function (root) {
'use strict';
const PRUNE_MS = 30 * 864e5;
const DESC_MAX = 1500;
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const nameOf = v => (v && typeof v === 'object' ? str(v.displayName || v.name || v.value) : str(v));

function difficulty(priorityName) {
  const n = str(priorityName).trim().toLowerCase();
  if (!n) return 0;
  if (n === 'highest' || n === 'high') return 3;
  if (n === 'low' || n === 'lowest') return 1;
  return 2;
}

const fieldsOf = i => (i && typeof i === 'object' && i.fields && typeof i.fields === 'object' ? i.fields : {});

function categoryOf(issue) {
  const f = fieldsOf(issue);
  const st = f.status || issue.status;
  const c = (st && typeof st === 'object' && st.statusCategory) || issue.statusCategory || f.statusCategory;
  const k = c && typeof c === 'object' ? c.key : c;
  return k === 'indeterminate' || k === 'done' ? k : 'new';
}

function groupOf(issue, state, liveIds) {
  const live = liveIds && typeof liveIds.has === 'function' ? liveIds : new Set();
  if (state && typeof state === 'object') {
    if (state.reportAt) return 'report';
    if (state.sessionId ? live.has(state.sessionId) : state.kind === 'worktree') return 'doing';
  }
  const c = categoryOf(issue || {});
  return c === 'indeterminate' ? 'doing' : c;
}

function questView(issues, stateFile, liveIds) {
  const quests = stateFile && typeof stateFile === 'object' && stateFile.quests && typeof stateFile.quests === 'object' ? stateFile.quests : {};
  const live = liveIds && typeof liveIds.has === 'function' ? liveIds : new Set();
  const out = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || typeof issue !== 'object' || !issue.key) continue;
    const f = fieldsOf(issue);
    const entry = Object.prototype.hasOwnProperty.call(quests, issue.key) ? quests[issue.key] : undefined;
    const card = {
      key: str(issue.key),
      title: str(f.summary != null ? f.summary : issue.summary),
      difficulty: difficulty(nameOf(f.priority || issue.priority)),
      group: groupOf(issue, entry, live),
      status: nameOf(f.status || issue.status),
    };
    const due = str(f.duedate || issue.duedate);
    if (due) card.due = due;
    const who = nameOf(f.assignee || issue.assignee);
    if (who) card.assignee = who;
    if (entry && typeof entry === 'object') {
      const q = { kind: entry.kind, at: entry.at };
      if (entry.sessionId) q.sessionId = entry.sessionId;
      if (entry.repo) q.repo = entry.repo;
      if (entry.reportAt) q.reportAt = entry.reportAt;
      if (entry.sessionId && !entry.reportAt && !live.has(entry.sessionId)) q.ended = true;
      card.quest = q;
    }
    out.push(card);
  }
  return out;
}

function partyOf(sessions, handles) {
  const has = id => !!(handles && typeof handles.get === 'function' && handles.get(id));
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object' || !s.id) continue;
    if (!s.connected || !has(s.id) || s.isSub || s.peer) continue;
    const status = str(s.status);
    out.push({
      id: s.id,
      name: str(s.name),
      repo: str(s.repo),
      branch: str(s.branch),
      status,
      eligible: !s.hasPerm && (status === 'waiting' || status === 'done'),
      doing: str(s.doing || s.summary || ''),
      skills: Array.isArray(s.skills) ? s.skills.map(str).filter(Boolean).slice(0, 8) : [],
    });
  }
  return out;
}

const DESK_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    choice: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'session' }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'worktree' }, repo: { type: 'string' } }, required: ['kind', 'repo'], additionalProperties: false },
      ],
    },
    reason: { type: 'string' },
  },
  required: ['choice', 'reason'],
  additionalProperties: false,
});

function deskPrompt(issue, party, repos) {
  const i = issue && typeof issue === 'object' ? issue : {};
  const f = fieldsOf(i);
  const labels = Array.isArray(i.labels) ? i.labels : Array.isArray(f.labels) ? f.labels : [];
  const desc = str(i.description || f.description).slice(0, DESC_MAX);
  const lines = ['Ticket', `key: ${str(i.key)}`, `title: ${str(f.summary != null ? f.summary : i.summary)}`];
  if (labels.length) lines.push(`labels: ${labels.map(nameOf).filter(Boolean).join(', ')}`);
  if (desc) lines.push(`description: ${desc}`);
  lines.push('', 'Available sessions (idle, can take the ticket now)');
  const idle = (Array.isArray(party) ? party : []).filter(p => p && p.eligible);
  if (!idle.length) lines.push('(none)');
  for (const p of idle) {
    lines.push(`- id: ${p.id} | name: ${p.name} | repo: ${p.repo} | branch: ${p.branch} | status: ${p.status} | doing: ${p.doing || '-'} | skills: ${(p.skills || []).join(', ') || '-'}`);
  }
  lines.push('', 'Repos for a new worktree');
  const rs = (Array.isArray(repos) ? repos : []).map(str).filter(Boolean);
  if (!rs.length) lines.push('(none)');
  for (const r of rs) lines.push(`- ${r}`);
  lines.push('', 'Pick one session id from the list, or one repo for a new worktree. Answer with JSON only.');
  return lines.join('\n');
}

function acceptProposal(answer, party, repos) {
  let a = answer;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  const c = a && typeof a === 'object' ? a.choice : null;
  if (!c || typeof c !== 'object') return null;
  if (c.kind === 'session') {
    if (typeof c.id !== 'string') return null;
    return (Array.isArray(party) ? party : []).some(p => p && p.eligible && p.id === c.id) ? { kind: 'session', id: c.id } : null;
  }
  if (c.kind === 'worktree') {
    if (typeof c.repo !== 'string') return null;
    return Array.isArray(repos) && repos.includes(c.repo) ? { kind: 'worktree', repo: c.repo } : null;
  }
  return null;
}

function pruneState(stateFile, issues, now) {
  const src = stateFile && typeof stateFile === 'object' && stateFile.quests && typeof stateFile.quests === 'object' ? stateFile.quests : {};
  const old = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || !issue.key || categoryOf(issue) !== 'done') continue;
    const f = fieldsOf(issue);
    const t = Date.parse(str(f.resolutiondate || issue.resolutiondate || f.updated || issue.updated));
    if (Number.isFinite(t) && now - t > PRUNE_MS) old.add(issue.key);
  }
  const quests = {};
  for (const k of Object.keys(src)) if (!old.has(k)) quests[k] = src[k];
  return { v: 1, quests };
}

const AgentDeskQuest = { difficulty, groupOf, questView, partyOf, deskPrompt, DESK_SCHEMA, acceptProposal, pruneState };
root.AgentDeskQuest = AgentDeskQuest;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskQuest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
