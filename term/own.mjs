// AgentDesk's own terminals: tmux sessions this app starts (named agentdesk-…), shown in the widget's terminal page.
// tmux keeps the session (it survives the widget closing); a control-mode client (`tmux -C attach`, plain pipes: no
// pty, no native module) streams the pane's output and carries the keys typed in the view. Protocol: core/tmuxctl.js.
//
// Only sessions whose name this module made are ever listed, attached, typed into or killed, and a new terminal runs
// one of the known agent commands (or nothing: a shell) — the renderer never supplies a command line.
import { spawn, execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import '../core/tmuxctl.js';

const C = globalThis.AgentDeskTmuxCtl;
const MAX_TERMS = 12, SNAPSHOT_LINES = 1000, SETTLE_MS = 200;

export function createOwnTerms({ findTmux, env, onData, onExit }) {
  const clients = new Map();   // session name → { proc, pane, live }
  const tmux = async (args, opts = {}) => {
    const bin = await findTmux();
    if (!bin) throw new Error('tmux not installed');
    return new Promise((resolve, reject) => execFile(bin, args, { timeout: 8000, env, maxBuffer: 8 * 1024 * 1024, encoding: opts.buffer ? 'buffer' : 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  };
  async function list() {
    let out = '';
    try { out = await tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{session_created}']); } catch { return []; }
    const seen = new Set(), rows = [];
    for (const line of out.split('\n')) {
      const [name, pane, cwd, cmd, created] = line.split('\t');
      if (!C.isSessionName(name) || !C.isPane(pane) || seen.has(name)) continue;
      seen.add(name);   // the session's first pane (AgentDesk makes one pane per terminal)
      rows.push({ name, pane, cwd: cwd || '', cmd: cmd || '', created: (Number(created) || 0) * 1000, attached: clients.has(name) });
    }
    return rows.sort((a, b) => a.created - b.created);
  }
  async function create({ cwd, agent, cols, rows, resumeId }) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || !existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, error: 'folder not found' };
    if ((await list()).length >= MAX_TERMS) return { ok: false, error: 'too many terminals' };
    const cmd = resumeId ? C.resumeCommand(agent, resumeId) : C.agentCommand(agent);
    if (resumeId && !cmd) return { ok: false, error: 'cannot resume this session' };
    const s = C.sizeOf(cols, rows), name = C.sessionName(`${basename(cwd)}-${Date.now().toString(36).slice(-4)}`);
    await tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', String(s.cols), '-y', String(s.rows)]);
    if (cmd) { await tmux(['send-keys', '-t', name, '-l', cmd]); await tmux(['send-keys', '-t', name, 'Enter']); }
    const pane = (await tmux(['display-message', '-p', '-t', name, '#{pane_id}'])).trim();
    return { ok: true, name, pane };
  }
  function detach(name) {
    const c = clients.get(name); if (!c) return;
    clients.delete(name);
    try { c.proc.stdin.end(); } catch {}
    try { c.proc.kill(); } catch {}
  }
  // → { ok, pane, snapshot (base64: the pane as it is now, colours kept), cursor: { x, y }, cols, rows }
  async function attach(name, cols, rows) {
    if (!C.isSessionName(name)) return { ok: false, error: 'not an AgentDesk terminal' };
    detach(name);
    const bin = await findTmux();
    if (!bin) return { ok: false, error: 'tmux not installed' };
    let pane = '';
    try { pane = (await tmux(['display-message', '-p', '-t', name, '#{pane_id}'])).trim(); } catch { return { ok: false, error: 'terminal is gone' }; }
    if (!C.isPane(pane)) return { ok: false, error: 'terminal is gone' };
    const proc = spawn(bin, ['-C', 'attach', '-t', name], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const c = { proc, pane, live: false };
    clients.set(name, c);
    const parser = C.createParser(e => {
      if (e.type === 'output') { if (c.live && e.pane === c.pane) onData(name, e.data); }
      else if (e.type === 'exit') proc.kill();
    });
    proc.stdout.on('data', d => parser.feed(d));
    proc.on('error', () => {});
    proc.on('exit', () => { if (clients.get(name) === c) { clients.delete(name); onExit(name); } });
    proc.stdin.on('error', () => {});
    // the pane takes the view's size first (a full-screen program repaints), then its screen is read once: what was
    // streamed before that is already in the picture, what comes after is forwarded
    const s = C.sizeOf(cols, rows);
    proc.stdin.write(`${C.sizeCommand(s.cols, s.rows)}\n`);
    await new Promise(r => setTimeout(r, SETTLE_MS));
    let snap = Buffer.alloc(0), cur = { x: 0, y: 0 };
    try {
      snap = await tmux(['capture-pane', '-p', '-e', '-t', pane, '-S', `-${SNAPSHOT_LINES}`], { buffer: true });
      const m = /^(\d+) (\d+)/.exec((await tmux(['display-message', '-p', '-t', pane, '#{cursor_x} #{cursor_y}'])).trim());
      if (m) cur = { x: Number(m[1]), y: Number(m[2]) };
    } catch {}
    c.live = true;
    return { ok: true, pane, snapshot: snap.toString('base64'), cursor: cur, cols: s.cols, rows: s.rows };
  }
  function input(name, bytes) {
    const c = clients.get(name); if (!c || !bytes || !bytes.length || bytes.length > 64 * 1024) return false;
    for (const cmd of C.keysCommands(c.pane, bytes)) c.proc.stdin.write(`${cmd}\n`);
    return true;
  }
  function resize(name, cols, rows) {
    const c = clients.get(name); if (!c) return false;
    c.proc.stdin.write(`${C.sizeCommand(cols, rows)}\n`);
    return true;
  }
  async function kill(name) {
    if (!C.isSessionName(name)) return { ok: false, error: 'not an AgentDesk terminal' };
    detach(name);
    try { await tmux(['kill-session', '-t', name]); } catch {}
    return { ok: true };
  }
  return { list, create, attach, detach, input, resize, kill, closeAll() { for (const n of [...clients.keys()]) detach(n); } };
}
