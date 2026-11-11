// AgentDesk core: tmux control mode (`tmux -C attach`) — the protocol side of AgentDesk's own terminal. No DOM, no I/O.
// Loaded as a classic <script> (global AgentDeskTmuxCtl) or required from main / tests.
//
// A control-mode client talks over plain pipes (no pty, so no native module): tmux writes one line per event, and a
// pane's output arrives as  %output %<pane> <data>  with every byte below 0x20 and the backslash written as \ooo
// (three octal digits); bytes from 0x80 up come through as they are, and one UTF-8 character may be split over two
// lines. So everything here works on bytes, and the terminal view decodes them (it keeps a split character's state).
//
//   createParser(onEvent)      → feed(chunk: Uint8Array): calls onEvent({ type: 'output', pane, data: Uint8Array })
//                                 and onEvent({ type: 'exit' }) when the server says the client is done
//   unescape(bytes)            → Uint8Array   \ooo → the byte
//   keysCommands(pane, bytes)  → ['send-keys -t %1 -H 1b 5b 41', …]   typed bytes as commands (KEYS_PER_CMD a line)
//   sizeCommand(cols, rows)    → 'refresh-client -C 120x32'   (clamped to SIZE)
//   sessionName(n)             → 'agentdesk-n'; isSessionName(s): only names this module made are ever attached or killed
//   agentCommand(agent)        → 'claude' | 'codex' | 'gemini' | ''   the line typed into a new terminal ('' = a shell)
//   resumeCommand(agent, id)   → 'claude --resume <id>' | ''   reopening an ended session (a plain id only)
(function (root) {
'use strict';

const KEYS_PER_CMD = 256;
const SIZE = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 };
const NAME_RE = /^agentdesk-[a-z0-9][a-z0-9-]{0,39}$/;
const PANE_RE = /^%\d{1,9}$/;
const AGENTS = { claude: 'claude', codex: 'codex', gemini: 'gemini', shell: '' };

function unescape(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x5c && i + 3 < b.length + 0 && isOct(b[i + 1]) && isOct(b[i + 2]) && isOct(b[i + 3])) {
      out[n++] = ((b[i + 1] - 48) << 6 | (b[i + 2] - 48) << 3 | (b[i + 3] - 48)) & 0xff; i += 3;
    } else out[n++] = c;
  }
  return out.subarray(0, n);
}
const isOct = c => c >= 48 && c <= 55;

const PREFIX = [0x25, 0x6f, 0x75, 0x74, 0x70, 0x75, 0x74, 0x20];   // "%output "
function createParser(onEvent) {
  let rest = new Uint8Array(0);
  const line = l => {
    if (l.length && l[l.length - 1] === 0x0d) l = l.subarray(0, l.length - 1);
    if (l.length >= 5 && l[0] === 0x25 && l[1] === 0x65 && l[2] === 0x78 && l[3] === 0x69 && l[4] === 0x74) { onEvent({ type: 'exit' }); return; }   // %exit
    if (l.length < PREFIX.length + 2) return;
    for (let i = 0; i < PREFIX.length; i++) if (l[i] !== PREFIX[i]) return;
    let sp = PREFIX.length;
    while (sp < l.length && l[sp] !== 0x20) sp++;
    const pane = String.fromCharCode(...l.subarray(PREFIX.length, Math.min(sp, PREFIX.length + 12)));
    if (!PANE_RE.test(pane)) return;
    onEvent({ type: 'output', pane, data: unescape(l.subarray(Math.min(sp + 1, l.length))) });
  };
  return {
    feed(chunk) {
      const buf = new Uint8Array(rest.length + chunk.length);
      buf.set(rest, 0); buf.set(chunk, rest.length);
      let start = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) { line(buf.subarray(start, i)); start = i + 1; }
      rest = buf.slice(start);
      if (rest.length > 4 * 1024 * 1024) rest = new Uint8Array(0);   // a line that never ends: drop it
    },
  };
}

function keysCommands(pane, bytes) {
  if (!PANE_RE.test(String(pane)) || !bytes || !bytes.length) return [];
  const out = [];
  for (let i = 0; i < bytes.length; i += KEYS_PER_CMD) {
    let hex = '';
    for (let k = i; k < Math.min(bytes.length, i + KEYS_PER_CMD); k++) hex += ` ${(bytes[k] & 0xff).toString(16).padStart(2, '0')}`;
    out.push(`send-keys -t ${pane} -H${hex}`);
  }
  return out;
}
const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function sizeOf(cols, rows) { return { cols: clampInt(cols, SIZE.minCols, SIZE.maxCols, 120), rows: clampInt(rows, SIZE.minRows, SIZE.maxRows, 32) }; }
function sizeCommand(cols, rows) { const s = sizeOf(cols, rows); return `refresh-client -C ${s.cols}x${s.rows}`; }
const isSessionName = s => typeof s === 'string' && NAME_RE.test(s);
function sessionName(n) { const s = `agentdesk-${String(n).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 't'}`; return isSessionName(s) ? s : 'agentdesk-t'; }
const agentCommand = a => (Object.prototype.hasOwnProperty.call(AGENTS, a) ? AGENTS[a] : '');
// reopening an ended session in a new terminal: the agent's own resume form, for a plain session id only
const RESUME = { claude: id => `claude --resume ${id}`, gemini: id => `gemini --resume ${id}`, codex: id => `codex resume ${id}` };
const SESSION_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,63}$/;
function resumeCommand(agent, id) { return typeof id === 'string' && SESSION_ID_RE.test(id) && Object.prototype.hasOwnProperty.call(RESUME, agent) ? RESUME[agent](id) : ''; }
const isPane = p => PANE_RE.test(String(p));

const AgentDeskTmuxCtl = { createParser, unescape, keysCommands, sizeCommand, sizeOf, sessionName, isSessionName, agentCommand, resumeCommand, isPane, AGENTS, SIZE, KEYS_PER_CMD };
root.AgentDeskTmuxCtl = AgentDeskTmuxCtl;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskTmuxCtl;
})(typeof globalThis !== 'undefined' ? globalThis : this);
