// AgentDesk core: agent CLI sessions found in the process list alone (no hook event yet, or hooks off).
// Pure functions only — no DOM, no Electron. Shared by the renderer (classic <script>), main (import) and the tests.
//
//   isInteractiveAgentCmd(cmd)                 → false for headless / helper runs (claude -p, claude mcp serve, …)
//   liveWorktreePaths(wts)                     → Set of Orca worktree paths with a live Orca terminal
//   procSessions({ procs, hookOnly, wts })     → detected-session candidates: [{ id, proc, handle }]
//   migrateIds(prevProc, hookOnly)             → [{ from, to }]: a detected card that became a hook card this poll
(function (root) {
'use strict';
const AGENT_BIN_RE = /(?:^|\/)(claude|gemini|codex|opencode)$/;

// the arguments after the agent binary (`node /…/claude --resume x` → ['--resume', 'x']); null when no agent binary
function agentArgs(cmd) {
  const toks = String(cmd || '').trim().split(/\s+/).filter(Boolean);
  const i = toks.findIndex(tk => AGENT_BIN_RE.test(tk));
  return i < 0 ? null : { agent: toks[i].match(AGENT_BIN_RE)[1], args: toks.slice(i + 1) };
}
// a TUI the user works in, not a one-shot print run, an MCP server, the browser bridge or `codex exec`
function isInteractiveAgentCmd(cmd) {
  const a = agentArgs(cmd);
  if (!a) return false;
  for (const x of a.args) {
    if (x === '-p' || x === '--print' || x.startsWith('--print=') || x === '--prompt' || x.startsWith('--prompt=')) return false;
    if (x === '--chrome-native-host' || x.startsWith('--chrome-native-host=')) return false;
  }
  const sub = a.args.find(x => !x.startsWith('-'));
  if (sub === 'mcp') return false;
  if (a.agent === 'codex' && sub === 'exec') return false;
  return true;
}

const trimSlash = p => String(p || '').replace(/\/$/, '');
// Orca worktrees with a live Orca terminal, by exact path. Prefix matching is wrong here: the home folder
// itself can be an Orca worktree, which would swallow every terminal session under it.
function liveWorktreePaths(wts) {
  return new Set((wts || []).filter(w => w && ((w.liveTerminalCount || 0) > 0 || w.hasAttachedPty))
    .map(w => trimSlash(w.path || String(w.worktreeId || '').split('::').pop() || '')).filter(Boolean));
}

const procIdOf = p => `proc:${p.agent || 'claude'}:${p.sessionId || p.pid}::${p.cwd}`;
// agent processes not yet covered by a hook card or a live Orca worktree; procs are main's tty targets
// ({ pid, cwd, agent, sessionId, cmd, handle, drivable, recall }), hookOnly the widget's hook-only list ({ id, st, pane })
function procSessions({ procs, hookOnly, wts } = {}) {
  const hooks = hookOnly || [];
  const pairedPids = new Set(hooks.filter(h => h && h.pane).map(h => h.pane.pid));
  const hookSids = new Set(hooks.filter(h => h && h.st && h.st.sid).map(h => h.st.sid));
  const live = liveWorktreePaths(wts);
  const out = [], seen = new Set();
  for (const p of procs || []) {
    if (!p || !p.cwd || p.recall) continue;
    if (!isInteractiveAgentCmd(p.cmd)) continue;
    if (pairedPids.has(p.pid)) continue;
    if (p.sessionId && hookSids.has(p.sessionId)) continue;
    if (live.has(trimSlash(p.cwd))) continue;
    const id = procIdOf(p);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, proc: p, handle: p.drivable !== false && p.handle ? p.handle : null });
  }
  return out;
}

// prevProc: last poll's detected cards as { id, pid, sessionId }; a hook card that now holds the same process
// (or the same resumed session id) takes over the card's id-keyed state (name, pin, dock order …)
function migrateIds(prevProc, hookOnly) {
  const out = [], used = new Set();
  for (const pr of prevProc || []) {
    if (!pr || !pr.id) continue;
    const h = (hookOnly || []).find(x => x && !used.has(x.id) && ((x.pane && x.pane.pid === pr.pid) || (pr.sessionId && x.st && x.st.sid === pr.sessionId)));
    if (!h || h.id === pr.id) continue;
    used.add(h.id);
    out.push({ from: pr.id, to: h.id });
  }
  return out;
}

const AgentDeskDiscover = { isInteractiveAgentCmd, liveWorktreePaths, procSessions, migrateIds, procIdOf };
root.AgentDeskDiscover = AgentDeskDiscover;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskDiscover;
})(typeof globalThis !== 'undefined' ? globalThis : this);
