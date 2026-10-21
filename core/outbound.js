// AgentDesk core: what may leave the company network (a Jira comment, a Slack thread reply), checked and masked.
// Pure, no Electron / fs. Loaded for its side effect after core/mask.js (`import "./core/mask.js";
// import "./core/outbound.js"; const O = globalThis.AgentDeskOutbound;`) by main.mjs and recall/slack-format.mjs.
//
//   REPLY_ICONS                         → the icons a Slack reply may carry (the prefixes the widget writes)
//   replyIcon(icon)                     → icon when it is one of REPLY_ICONS, else the first one
//   routeFromTask(task)                 → { channel, thread } of a Slack inbox task when both look like Slack ids, else null
//   checkJql(raw)                       → { ok, jql } | { ok: false, error }: control characters → spaces, ≤ 2,000
//                                         characters, no leading "-", and refused when it holds a credential (token,
//                                         password=…, connection URI, private key; masking would break the query).
//                                         E-mail addresses and long numbers are fine there (reporter = "…", ids)
//   prepareJiraComment(raw)             → { ok, body, masked } | { ok: false, error }: masked first, then checked
//   prepareInboxReply(reply, route)     → { ok, reply, masked } | { ok: false, error }: only known fields, channel /
//                                         thread from `route` (what the main process saved for the task id), never
//                                         from the renderer; every text field masked before it is cut
(function (root) {
'use strict';
const REPLY_ICONS = Object.freeze(['✅', '⏸', '▶', '⚠️', '⏱']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/, CHANNEL_RE = /^[A-Z0-9]{5,20}$/, THREAD_RE = /^\d+\.\d+$/;
const JIRA_COMMENT_MAX = 32000, REPLY_TEXT_MAX = 60000, REPLY_REPORT_MAX = 12000, REPLY_LABEL_MAX = 500;

function maskApi() {
  const M = root.AgentDeskMask;
  if (!M || typeof M.maskForSend !== 'function') throw new Error('core/outbound.js: core/mask.js is not loaded');
  return M;
}
const replyIcon = icon => (REPLY_ICONS.includes(icon) ? icon : REPLY_ICONS[0]);
function routeFromTask(task) {
  const t = task && typeof task === 'object' ? task : {};
  return typeof t.channel === 'string' && CHANNEL_RE.test(t.channel) && typeof t.thread === 'string' && THREAD_RE.test(t.thread)
    ? { channel: t.channel, thread: t.thread } : null;
}
function checkJql(raw) {
  const jql = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() : '';
  if (!jql) return { ok: true, jql: '' };
  if (jql.length > 2000 || jql.startsWith('-')) return { ok: false, error: 'invalid JQL' };
  if (maskApi().hasCredential(jql)) return { ok: false, error: 'JQL contains a credential (token, password, connection URI, key)' };
  return { ok: true, jql };
}
function prepareJiraComment(raw) {
  const m = maskApi().maskForSend(raw, { max: JIRA_COMMENT_MAX });
  if (!m.ok) return { ok: false, error: m.error === 'body is too long after masking' ? `comment body is too long (over ${JIRA_COMMENT_MAX} characters, counted after masking)` : `comment ${m.error}` };
  return { ok: true, body: m.text, masked: m.masked };
}
function prepareInboxReply(reply, route) {
  const M = maskApi(), r = reply && typeof reply === 'object' ? reply : {};
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return { ok: false, error: 'bad id' };
  const rt = routeFromTask(route);
  if (!rt) return { ok: false, error: 'unknown task' };
  const text = M.maskForSend(r.text, { max: REPLY_TEXT_MAX, truncate: true });
  if (!text.ok) return { ok: false, error: `reply ${text.error}` };
  const out = { id: r.id, channel: rt.channel, thread: rt.thread, text: text.text };
  let masked = text.masked;
  if (r.report != null) {
    const rep = M.maskForSend(r.report, { max: REPLY_REPORT_MAX, truncate: true });
    if (rep.ok) { out.report = rep.text; masked += rep.masked; }
  }
  // a label is cut to 4× its cap before masking (bounded work), masked, then cut to the cap
  for (const k of ['title', 'session']) {
    if (r[k] == null) continue;
    const l = M.maskWithCount(String(r[k]).slice(0, REPLY_LABEL_MAX * 4));
    out[k] = l.text.slice(0, REPLY_LABEL_MAX); masked += l.count;
  }
  if (r.icon != null) out.icon = replyIcon(r.icon);
  return { ok: true, reply: out, masked };
}

const AgentDeskOutbound = { REPLY_ICONS, replyIcon, routeFromTask, checkJql, prepareJiraComment, prepareInboxReply, JIRA_COMMENT_MAX };
root.AgentDeskOutbound = AgentDeskOutbound;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskOutbound;
})(typeof globalThis !== 'undefined' ? globalThis : this);
