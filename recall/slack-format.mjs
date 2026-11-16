// Slack mrkdwn for the front desk: the agent's REPORT (plain text as the TUI rendered it) → readable thread reply.
// Pure functions, no Slack client here, so they are unit-testable.
import "../core/mask.js";   // globalThis.AgentDeskMask: replyPayload masks whatever the reply file holds
import "../core/outbound.js";   // globalThis.AgentDeskOutbound: the reply icon set, shared with the main process
const mask = s => globalThis.AgentDeskMask.mask(s);
const { routeFromTask } = globalThis.AgentDeskOutbound;
export { routeFromTask };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// no emoji in anything the bot posts (the owner's preference): pictographs, their variation selectors and joiners, and
// :shortcodes:, dropped together with the space after a leading one. Code blocks keep their text (only pictographs go)
const PIC = "[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}][\\u{FE0F}\\u{200D}\\u{20E3}\\p{Extended_Pictographic}]*";
const TOKEN = `(?:${PIC}|(?<![\\w:]):[a-z][a-z0-9_+-]{1,40}:(?![\\w:]))`;   // a pictograph, or a :shortcode: standing alone
const LEAD_RE = new RegExp(`(^|\\n)[ \\t]*${TOKEN}(?:[ \\t]*${TOKEN})*[ \\t]*`, "gu");
const INLINE_RE = new RegExp(` ?${TOKEN} ?`, "gu");
export function noEmoji(s) {
  // a leading one goes with its space; one inside a line leaves one space if it had any around it; indentation stays
  return String(s ?? "").replace(LEAD_RE, "$1").replace(INLINE_RE, m => (/\s/.test(m) ? " " : "")).replace(/[\u{FE0F}\u{200D}]/gu, "");
}
// a line that is code even without a ``` fence: SQL (upper-case keywords), shell, JS, or a statement ending in ; { }
const CODE_WORD = /^(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|START TRANSACTION|COMMIT|ROLLBACK|VALUES|JOIN|AND |OR |GROUP BY|ORDER BY|SHOW |CREATE |ALTER |SET |--|\/\/|const |let |var |function |import |export |return |\$ |git |npm |npx |node |curl |cd |ls |rg |grep )|.*[;{}]$/;
// inCode: the previous line was code, so an indented continuation (e.g. " WHERE …" aligned under SELECT) stays in the block
const isCodeLine = (raw, inCode) => /^\s{2,}\S/.test(raw) || CODE_WORD.test(raw.trimStart()) || (inCode && /^\s/.test(raw));

function inline(s) {
  return esc(s)
    // markdown link → slack link; the URL may hold a "[MASKED EMAIL]"-style marker (its spaces become %20)
    .replace(/\[([^\]]+)\]\((https?:(?:[^)\s\[]|\[MASKED[A-Z ]{0,16}\]){1,2048})\)/g, (_, label, url) => `<${url.replace(/ /g, "%20")}|${label}>`)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*");                          // **bold** → *bold*
}

export function toMrkdwn(report) {
  const out = []; let code = []; let fence = false;
  const flush = () => { if (code.length) { out.push("```\n" + code.join("\n") + "\n```"); code = []; } };
  for (const raw of String(report || "").replace(/\r/g, "").split("\n")) {
    const t = raw.trim();
    if (t.startsWith("```")) { flush(); fence = !fence; out.push("```"); continue; }
    if (fence) { out.push(esc(raw)); continue; }
    if (!code.length && /^([-*_])\1{2,}$/.test(t)) { out.push(""); continue; }   // a Markdown rule (---), not SQL "--"
    if (t && isCodeLine(raw, code.length > 0)) { code.push(esc(raw)); continue; }
    flush();
    if (!t) { out.push(""); continue; }
    let m;
    // [한 일] … → section title (+ rest on its own line); a line that starts with a [MASKED…] marker is not a section
    if ((m = t.match(/^\[([^\]]{1,24})\]\s*(.*)$/)) && !/^MASKED\b/.test(m[1])) {
      out.push("", `*${esc(m[1])}*`);
      if (m[2]) out.push(inline(m[2])); continue;
    }
    if ((m = t.match(/^#{1,6}\s+(.*)$/))) { out.push("", `*${inline(m[1])}*`); continue; }
    if ((m = t.match(/^[-*]\s+(.*)$/))) { out.push("• " + inline(m[1])); continue; }
    if ((m = t.match(/^([•·▪])\s*(.*)$/))) { out.push("• " + inline(m[2])); continue; }
    if ((m = t.match(/^(\d+)[.)]\s+(.*)$/))) { out.push(`${m[1]}. ` + inline(m[2])); continue; }
    out.push(inline(t));
  }
  flush(); if (fence) out.push("```");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// split mrkdwn into ≤ max-char pieces at line boundaries, keeping ``` fences balanced in every piece
export function splitMrkdwn(text, max = 2900) {
  const pieces = []; let cur = ""; let open = false;
  for (const line of text.split("\n")) {
    const next = cur ? cur + "\n" + line : line;
    if (next.length > max && cur) {
      pieces.push(open ? cur + "\n```" : cur);
      cur = (open ? "```\n" : "") + line;
    } else cur = next;
    if (line.trim().startsWith("```")) open = !open;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// the front desk's direct answer (a question about the sessions, a thread summary) → chat.postMessage arguments:
// masked, mrkdwn (bullets, code, no Markdown headings), one section per ≤ 2,900 characters
export function answerPayload(reply, title) {
  const body = toMrkdwn(noEmoji(mask(String(reply || "")))), head = esc(noEmoji(mask(String(title || ""))).trim());
  const blocks = splitMrkdwn(body).slice(0, 45).map(piece => ({ type: "section", text: { type: "mrkdwn", text: piece } }));
  return { text: head || body.slice(0, 150), blocks, unfurl_links: false, unfurl_media: false };
}

// reply file written by the widget → chat.postMessage arguments. Masked here (raw text, before the mrkdwn conversion,
// so code blocks are covered too) even though the main process masked it already: anyone may write a reply file.
// Only the known fields are read, and every free-text path is escaped (& < >), so no <!channel> / <@U…> / link gets in
export function replyPayload(raw) {
  const src = raw && typeof raw === "object" ? raw : {}, r = {};
  for (const k of ["text", "report", "title", "session"]) if (src[k]) r[k] = noEmoji(mask(String(src[k]))).trim();
  if (!r.report) return { text: esc(r.text || "") };
  const head = `*${esc(r.title || "")}*${r.session ? `  ·  _${esc(r.session)}_` : ""}`;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: head } }, { type: "divider" }];
  for (const piece of splitMrkdwn(toMrkdwn(r.report)).slice(0, 45)) blocks.push({ type: "section", text: { type: "mrkdwn", text: piece } });
  return { text: esc(`${r.title || ""}${r.session ? ` · ${r.session}` : ""}`), blocks, unfurl_links: false, unfurl_media: false };
}
