// AgentDesk core: team sharing (phase 2) logic shared by the renderer (classic <script>) and the tests (CommonJS).
// Pure functions only — no DOM, no Electron, no network. Inputs are session snapshots as published by team/peer.mjs.
//
//   publicSessionId(id)               → the id a teammate sees (same rule as team/peer.mjs sanitizeSessions)
//   conflictsFor(mine, peers)         → [{ mine, mineName, peer, peerName, owner, level, repo, branch, files }]
//   conflictKey(c) / conflictLabel(c) → dedupe key / "⚠ will의 wt-x 와 같은 파일: A.java"
//   conflictPrompt(c)                 → warning text injected into my session (only when the user presses the button)
//   reportSummary(report)             → first 200 chars of the REPORT's [한 일] / [Done] section
//   boardRows(me, peers, now)         → today's team board rows; boardMarkdown(rows) → a Markdown table
//   noteMessage(note)                 → "[팀원 메모 · will] text"
(function (root) {
'use strict';

function publicSessionId(id) {
  let o = String(id == null ? '' : id).split('::')[0];
  if (o.includes('/')) o = o.split('/').filter(Boolean).pop() || '';
  return o;
}
const repoKey = r => (String(r || '').split('/').filter(Boolean).pop() || '').toLowerCase();
const active = s => s && !s.isSub && !s.ended && s.status !== 'done';

// (a) same repo + same branch → 'branch' (weak); (b) same repo + a file both touched in the last 10 min → 'file' (strong).
// `files` are already windowed by the sender (relative paths touched within 10 minutes).
function conflictsFor(mine, peers) {
  const out = [];
  for (const m of (mine || []).filter(active)) {
    const mr = repoKey(m.repo); if (!mr) continue;
    const mf = new Set(m.files || []);
    for (const p of peers || []) {
      for (const s of (p.sessions || []).filter(active)) {
        if (repoKey(s.repo) !== mr) continue;
        const files = (s.files || []).filter(f => mf.has(f));
        const sameBranch = !!(m.branch && s.branch && m.branch === s.branch);
        if (!files.length && !sameBranch) continue;
        out.push({ mine: m.id, mineName: m.name || '', peer: s.id, peerName: s.name || '', owner: p.name, level: files.length ? 'file' : 'branch', repo: s.repo || m.repo, branch: sameBranch ? s.branch : '', files });
      }
    }
  }
  return out.sort((a, b) => (a.level === 'file' ? 0 : 1) - (b.level === 'file' ? 0 : 1));
}
function conflictKey(c) { return `${c.mine}|${c.owner}|${c.peer}|${c.level}`; }
function conflictLabel(c, lang) {
  const files = (c.files || []).map(f => String(f).split('/').pop());
  const list = files.slice(0, 2).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '');
  if (lang === 'en') return c.level === 'file' ? `⚠ same file as ${c.owner}'s ${c.peerName}: ${list}` : `⚠ same branch as ${c.owner}'s ${c.peerName}: ${c.branch}`;
  return c.level === 'file' ? `⚠ ${c.owner}의 ${c.peerName} 와 같은 파일: ${list}` : `⚠ ${c.owner}의 ${c.peerName} 와 같은 브랜치: ${c.branch}`;
}
function conflictPrompt(c) {
  const what = c.level === 'file' && c.files.length ? c.files.join(', ') : `${c.branch} 브랜치`;
  return `[팀 충돌 주의] ${c.owner} 의 세션이 같은 저장소 ${c.repo} 의 ${what} 를 수정 중입니다. 같은 파일을 바꾸기 전에 사용자에게 확인하세요.`;
}

// [한 일] (or [Done]) section of a REPORT block, whitespace collapsed; the whole text when there is no such section
function reportSummary(report) {
  const s = String(report || '').replace(/REPORT_(START|END)/g, '');
  const m = s.match(/\[(한 일|Done)\]\s*([\s\S]*?)(?=\n\s*\[[^\]\n]{1,24}\]|$)/i);
  return (m ? m[2] : s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function startOfDay(now) { const d = new Date(now || Date.now()); d.setHours(0, 0, 0, 0); return d.getTime(); }
// one row per session that reported today or works on a ticket today; me first is not needed — newest first
function boardRows(me, peers, now) {
  const t0 = startOfDay(now);
  const rows = [];
  for (const p of [me, ...(peers || [])]) {
    if (!p) continue;
    for (const s of p.sessions || []) {
      if (s.isSub) continue;
      const rep = s.report && s.report.at >= t0 ? s.report : null;
      if (!rep && !(s.jira && (s.time || 0) >= t0)) continue;
      rows.push({ owner: p.name, mine: !!p.mine, session: s.name || s.id, ticket: s.jira || '', done: rep ? rep.text : '', at: rep ? rep.at : s.time || 0 });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}
function boardMarkdown(rows, lang) {
  const cell = v => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const hm = at => { if (!at) return ''; const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const head = lang === 'en' ? '| Member | Session | Ticket | Done | Time |' : '| 팀원 | 세션 | 티켓 | 한 일 | 시각 |';
  return [head, '|---|---|---|---|---|', ...rows.map(r => `| ${cell(r.owner)} | ${cell(r.session)} | ${cell(r.ticket)} | ${cell(r.done)} | ${hm(r.at)} |`)].join('\n');
}

function noteMessage(note) { return `[팀원 메모 · ${note.from}] ${String(note.text || '').replace(/\r?\n+/g, ' ').trim()}`; }

const AgentDeskTeam = { publicSessionId, conflictsFor, conflictKey, conflictLabel, conflictPrompt, reportSummary, startOfDay, boardRows, boardMarkdown, noteMessage };
// the widget loads this as a classic <script> (one global); tests `import()` it and read globalThis.AgentDeskTeam
root.AgentDeskTeam = AgentDeskTeam;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskTeam;
})(typeof globalThis !== 'undefined' ? globalThis : this);
