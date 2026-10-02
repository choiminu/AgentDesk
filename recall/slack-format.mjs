// Slack mrkdwn for the front desk: the agent's REPORT (plain text as the TUI rendered it) → readable thread reply.
// Pure functions, no Slack client here, so they are unit-testable.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SECTION_ICON = { "한 일": "🛠", "변경 파일": "📄", "막힌 점": "🚧", "다음 제안": "💡", "Done": "🛠", "Changed files": "📄", "Blockers": "🚧", "Next suggestion": "💡" };
// a line that is code even without a ``` fence: SQL (upper-case keywords), shell, JS, or a statement ending in ; { }
const CODE_WORD = /^(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|START TRANSACTION|COMMIT|ROLLBACK|VALUES|JOIN|AND |OR |GROUP BY|ORDER BY|SHOW |CREATE |ALTER |SET |--|\/\/|const |let |var |function |import |export |return |\$ |git |npm |npx |node |curl |cd |ls |rg |grep )|.*[;{}]$/;
// inCode: the previous line was code, so an indented continuation (e.g. " WHERE …" aligned under SELECT) stays in the block
const isCodeLine = (raw, inCode) => /^\s{2,}\S/.test(raw) || CODE_WORD.test(raw.trimStart()) || (inCode && /^\s/.test(raw));

function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")       // markdown link → slack link
    .replace(/\*\*([^*]+)\*\*/g, "*$1*");                          // **bold** → *bold*
}

export function toMrkdwn(report) {
  const out = []; let code = []; let fence = false;
  const flush = () => { if (code.length) { out.push("```\n" + code.join("\n") + "\n```"); code = []; } };
  for (const raw of String(report || "").replace(/\r/g, "").split("\n")) {
    const t = raw.trim();
    if (t.startsWith("```")) { flush(); fence = !fence; out.push("```"); continue; }
    if (fence) { out.push(esc(raw)); continue; }
    if (t && isCodeLine(raw, code.length > 0)) { code.push(esc(raw)); continue; }
    flush();
    if (!t) { out.push(""); continue; }
    let m;
    if ((m = t.match(/^\[([^\]]{1,24})\]\s*(.*)$/))) {           // [한 일] … → section title (+ rest on its own line)
      const icon = SECTION_ICON[m[1]]; out.push("", `*${icon ? icon + " " : ""}${esc(m[1])}*`);
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

// reply file written by the widget → chat.postMessage arguments
export function replyPayload(r) {
  if (!r.report) return { text: r.text || "" };
  const head = `${r.icon || "✅"} *${esc(r.title || "")}*${r.session ? `  ·  _${esc(r.session)}_` : ""}`;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: head } }, { type: "divider" }];
  for (const piece of splitMrkdwn(toMrkdwn(r.report)).slice(0, 45)) blocks.push({ type: "section", text: { type: "mrkdwn", text: piece } });
  return { text: `${r.icon || "✅"} ${r.title || ""}${r.session ? ` · ${r.session}` : ""}`, blocks, unfurl_links: false, unfurl_media: false };
}
