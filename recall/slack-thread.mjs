// Slack thread context for the front desk: the parent message and every reply, so the agent sees the whole conversation,
// not only the line that mentioned the bot.
//   fetchThread(web, channel, threadTs)        → { messages } | { error, needed? } (conversations.replies, paged, ≤ MAX_MESSAGES)
//   formatThread(messages, { botUserId, mentionTs, names }) → markdown text, oldest first; the bot's own posts are left out,
//                                                 the message that called the bot is marked, files are listed by name
//   clipThread(text, max)                       → text ≤ max chars: keeps the start (parent) and the end (latest replies)
// History scopes: channels:history (public), groups:history (private), mpim:history (group DM), im:history (DM).
import "../core/mask.js";   // defines globalThis.AgentDeskMask

export const MAX_MESSAGES = 300;
const mask = s => globalThis.AgentDeskMask.mask(s);
const SCOPE_BY_PREFIX = { C: "channels:history", G: "groups:history", D: "im:history" };

export async function fetchThread(web, channel, threadTs) {
  const messages = [];
  let cursor;
  try {
    do {
      const r = await web.conversations.replies({ channel, ts: threadTs, limit: 200, cursor });
      messages.push(...(r.messages || []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < MAX_MESSAGES);
  } catch (e) {
    const code = e?.data?.error || e.message;
    if (code === "missing_scope") return { error: code, needed: e?.data?.needed || SCOPE_BY_PREFIX[String(channel)[0]] || "channels:history" };
    return { error: code };
  }
  return { messages: messages.slice(0, MAX_MESSAGES) };
}

const when = (ts) => {
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function formatThread(messages, { botUserId = null, mentionTs = null, names = {} } = {}) {
  const who = (id) => (id && names[id] ? `${names[id]} (<@${id}>)` : id ? `<@${id}>` : "bot");
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (!m || (botUserId && m.user === botUserId)) return;
    const author = m.user ? who(m.user) : (m.username || m.bot_profile?.name || "bot");
    const tag = i === 0 ? "본문" : "댓글";
    const mark = mentionTs && m.ts === mentionTs ? " ← 봇 호출" : "";
    const files = (m.files || []).map(f => f.name || f.title).filter(Boolean);
    let body = String(m.text || "").trim();
    if (files.length) body += `${body ? "\n" : ""}[첨부: ${files.join(", ")}]`;
    out.push(`### ${tag} · ${author} · ${when(m.ts)}${mark}\n${body || "(내용 없음)"}`);
  });
  return mask(out.join("\n\n"));
}

export function clipThread(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4), tail = max - head - 40;
  return `${s.slice(0, head)}\n\n… (중간 ${s.length - head - tail}자 생략) …\n\n${s.slice(-tail)}`;
}
