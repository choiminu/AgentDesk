import { app, BrowserWindow, clipboard, ipcMain, screen, Tray, Menu, nativeImage, Notification, shell } from "electron";
import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync, openSync, readSync, closeSync, watch as fsWatch, chmodSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const WIN_W = 320;
const WIN_H = 480;
const MARGIN = 16;

let mainWindow = null;
let tray = null;
let prevRunningCount = 0;
let saveBoundsTimer = null;

const boundsFile = join(app.getPath("userData"), "window-bounds.json");

function loadBounds() {
  try {
    return JSON.parse(readFileSync(boundsFile, "utf-8"));
  } catch { return null; }
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getBounds();
    writeFileSync(boundsFile, JSON.stringify(b));
  } catch {}
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const saved = loadBounds();

  const x = saved?.x ?? (sw - WIN_W - MARGIN);
  const y = saved?.y ?? (sh - WIN_H - MARGIN);
  const w = saved?.width ?? WIN_W;
  // a widget minimized to its header bar (44px) must not come back minimized
  const h = Math.max(saved?.height ?? WIN_H, 300);

  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    x, y,
    minWidth: 280,
    minHeight: 300,
    maxWidth: 480,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    skipTaskbar: false,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("widget.html", process.env.ROCA_START_PAGE ? { hash: process.env.ROCA_START_PAGE } : undefined);
  if (process.env.ROCA_SHOT) {
    for (const [i, delay] of [[1, 8000], [2, 13500], [3, 24000]]) {
      setTimeout(async () => {
        const img = await mainWindow.webContents.capturePage();
        const out = process.env.ROCA_SHOT.replace(/\.png$/, `-${i}.png`);
        (await import("node:fs")).writeFileSync(out, img.toPNG());
        console.log(`[shot] saved ${out}`);
      }, delay);
    }
  }
  mainWindow.webContents.on("did-finish-load", () => console.log(`[win] did-finish-load url=${mainWindow.webContents.getURL()}`));
  mainWindow.webContents.on("render-process-gone", (_e, d) => console.log(`[win] render-process-gone reason=${d.reason} code=${d.exitCode}`));
  mainWindow.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2 || process.env.ROCA_DEBUG) console.log(`[renderer:${level}] ${msg}`);
  });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const debounceSave = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(saveBounds, 500);
  };
  mainWindow.on("move", debounceSave);
  mainWindow.on("resize", debounceSave);

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      saveBounds();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAIRlWElmTU0AKgAAAAgABQESAAMAAAABAAEAAAEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAIAAIdpAAQAAAABAAAAWgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAACCgAwAEAAAAAQAAACAAAAAAX7wP4AAAAAlwSFlzAAALEwAACxMBAJqcGAAAAmRJREFUWAntl79Lw0AUx19SbautWkVBBychgoMgOIiIi6CL4OLk5Ojs4OAfIDg4OLi5uTqIi4rgIIII/gMiCIqKPzBqrf35vXhXcklzSVoHB1+4y917373vu7t3uURR/j9hBfwWsBXwfN9V0HFc8sQXQvocJz4Jek6i4MSXQO+J7kkXnAXvBAFH4QbCaHTsgL4BIyDlXCQs2AGxIAb4BXIgwxYDK6Ac+BQlP0YJZcR/Jfo+xQUwPb7TUApFRwEhZR6KTHXifcUsggm4IxCOQJ0Y9cFJfB0FOwC66AHqoPJsBJUUtIQf97vALiUzjK5AN0X7J8H8kOxRHDmxMsR1yXI0xG9A5eCpXAMPM07RB/3f7d7F88j5TPZZZKt2rIdJzpfstfsnUj4eAF+PwHNqr/jYJNYA+eBO87swFl5ERF+6TZR2vXA3jt3wFOD6U1KJnagG/TjvQNy2aKOHG/+kS7IMkFk4r8f2IqJpnAAAAAElFTkSuQmCC"
  );
  tray = new Tray(icon.resize({ width: 18, height: 18 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: "Orca Dashboard 열기", click: () => mainWindow.show() },
    { type: "separator" },
    { label: "종료", click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip("Orca Dashboard");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

app.on("before-quit", () => { app.isQuitting = true; });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { app.isQuitting = true; app.quit(); });

// Finder-launched apps only see /usr/bin:/bin:/usr/sbin:/sbin, so look in the usual symlink
// locations and inside the Orca app bundle itself (DMG installs without the brew symlink).
const ORCA_BIN = [
  "/usr/local/bin/orca",
  "/opt/homebrew/bin/orca",
  "/Applications/Orca.app/Contents/Resources/bin/orca",
  join(homedir(), "Applications", "Orca.app", "Contents", "Resources", "bin", "orca"),
  "orca",
];
const EXEC_PATH = `${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/Applications/Orca.app/Contents/Resources/bin`;

async function findOrca() {
  if (process.env.ROCA_ORCA_BIN) return process.env.ROCA_ORCA_BIN;
  for (const bin of ORCA_BIN) {
    try {
      await exec("test", ["-x", bin]);
      return bin;
    } catch {}
  }
  return "orca";
}

let orcaBin = "orca";
let orcaBinFound = null;
const orcaReady = findOrca().then(b => { orcaBin = b; orcaBinFound = b !== "orca"; });

async function orca(...args) {
  await orcaReady;
  try {
    const { stdout } = await exec(orcaBin, [...args, "--json"], {
      timeout: 15000,
      env: { ...process.env, PATH: EXEC_PATH },
    });
    return JSON.parse(stdout);
  } catch (err) {
    const notFound = err.code === "ENOENT" || /ENOENT|not found/i.test(err.message || "");
    return {
      ok: false,
      error: notFound
        ? `Orca CLI를 찾을 수 없습니다 (${orcaBin}). Orca 앱이 /Applications에 설치되어 있는지 확인하세요.`
        : (err.stderr && String(err.stderr).trim()) || err.message,
      bin: orcaBin,
    };
  }
}

ipcMain.handle("orca:ps", () => orca("worktree", "ps"));
ipcMain.handle("orca:terminals", () => orca("terminal", "list"));
ipcMain.handle("orca:rate-limits", () => orca("account", "list"));

// ── Claude Code .jsonl session reader ──

const sessionCache = new Map();

function toEpochMs(ts) {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") { const p = Date.parse(ts); if (!isNaN(p)) return p; }
  return 0;
}

function parseJsonlSummary(projectId, filePath) {
  const id = filePath.split("/").pop().replace(".jsonl", "");
  const stat = statSync(filePath);
  const cached = sessionCache.get(id);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;

  let title = null, customTitle = null, cwd = null, modelId = null, agent = null;
  let messageCount = 0, timeCreated = 0, timeUpdated = 0;
  let tokensInput = 0, tokensOutput = 0, cost = 0;

  const raw = readFileSync(filePath, "utf-8");
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "ai-title") { title = rec.aiTitle ?? title; continue; }
      if (rec.type === "custom-title") { customTitle = rec.customTitle ?? customTitle; continue; }
      if (rec.type === "cost-state") {
        cost = Number(rec.totalCostUSD ?? cost);
        const usage = rec.modelUsage;
        if (usage) {
          tokensInput = 0; tokensOutput = 0;
          for (const entry of Object.values(usage)) {
            tokensInput += Number(entry.inputTokens ?? 0);
            tokensOutput += Number(entry.outputTokens ?? 0);
          }
        }
        continue;
      }
      if (rec.type !== "user" && rec.type !== "assistant") continue;
      messageCount++;
      const ts = toEpochMs(rec.timestamp);
      if (ts) { if (!timeCreated) timeCreated = ts; timeUpdated = ts; }
      cwd = cwd ?? (rec.cwd || null);
      agent = agent ?? (rec.entrypoint || null);
      const msg = rec.message;
      if (msg) modelId = modelId ?? (msg.model || null);
    } catch {}
  }

  if (!timeUpdated) timeUpdated = Math.floor(stat.mtimeMs);
  if (!timeCreated) timeCreated = Math.floor(stat.birthtimeMs || stat.mtimeMs);

  const summary = {
    id, slug: id.slice(0, 8),
    title: customTitle || title || id.slice(0, 8),
    projectId, projectWorktree: cwd || "",
    agent, modelId, timeCreated, timeUpdated,
    messageCount, tokensInput, tokensOutput, cost,
  };
  sessionCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

function listClaudeSessions(filters = {}) {
  const rows = [];
  try {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectDir = join(CLAUDE_PROJECTS_DIR, dir.name);
      try {
        const files = readdirSync(projectDir);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          try {
            const s = parseJsonlSummary(dir.name, join(projectDir, file));
            if (s) rows.push(s);
          } catch {}
        }
      } catch {}
    }
  } catch {}

  let result = rows;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(r => r.title.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || (r.projectWorktree || "").toLowerCase().includes(q));
  }
  return result.sort((a, b) => b.timeUpdated - a.timeUpdated);
}

function getClaudeSessionDetail(sessionId) {
  let filePath = null, projectId = null;
  try {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory() || filePath) continue;
      const p = join(CLAUDE_PROJECTS_DIR, dir.name, sessionId + ".jsonl");
      try { statSync(p); filePath = p; projectId = dir.name; } catch {}
    }
  } catch {}
  if (!filePath) return null;

  const summary = parseJsonlSummary(projectId, filePath);
  const messages = [];
  const toolPartsById = new Map();
  const raw = readFileSync(filePath, "utf-8");
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== "user" && rec.type !== "assistant") continue;
      const msg = rec.message;
      if (!msg) continue;
      const parts = [];
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim()) parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && String(b.text || "").trim()) parts.push({ type: "text", text: String(b.text) });
          else if (b.type === "thinking") parts.push({ type: "reasoning", text: String(b.thinking || "") });
          else if (b.type === "tool_use") {
            const part = { type: "tool", callID: String(b.id || ""), tool: String(b.name || "tool"), state: { status: "running", input: b.input } };
            toolPartsById.set(part.callID, part);
            parts.push(part);
          } else if (b.type === "tool_result") {
            const target = toolPartsById.get(String(b.tool_use_id || ""));
            const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map(x => x?.text || "").join("\n") : "";
            if (target) {
              target.state.status = b.is_error ? "error" : "completed";
              target.state.output = text.length > 20000 ? text.slice(0, 20000) : text;
            }
          }
        }
      }
      if (!parts.length) continue;
      const ts = toEpochMs(rec.timestamp);
      messages.push({ id: String(rec.uuid || `${rec.type}-${messages.length}`), role: String(msg.role || rec.type), agent: rec.entrypoint || null, modelId: msg.model || null, timeCreated: ts || null, parts });
    } catch {}
  }
  return { ...summary, messages };
}

ipcMain.handle("orca:claude-sessions", (_e, filters) => listClaudeSessions(filters));
ipcMain.handle("orca:claude-session-detail", (_e, id) => getClaudeSessionDetail(id));

// ── Orchestration ──
ipcMain.handle("orca:orch-runs", () => orca("orchestration", "run-list"));
ipcMain.handle("orca:orch-tasks", async (_e, runId) => {
  if (runId) return orca("orchestration", "task-list", "--run", runId);
  try {
    const runsRaw = await orca("orchestration", "run-list");
    const runs = (runsRaw?.result?.runs || []).filter(r => !r.legacy);
    const results = await Promise.all(runs.map(r => orca("orchestration", "task-list", "--run", r.id).catch(() => ({ result: { tasks: [] } }))));
    return { result: { tasks: results.flatMap(r => r?.result?.tasks || []) } };
  } catch { return { result: { tasks: [] } }; }
});
ipcMain.handle("orca:orch-workers", () => orca("orchestration", "worker-list"));

ipcMain.handle("orca:orch-dispatch", (_e, taskId, handle) =>
  orca("orchestration", "dispatch", "--task", taskId, "--to", handle)
);
ipcMain.handle("orca:orch-task-create", async (_e, spec, runId) => {
  const args = ["orchestration", "task-create", "--spec", spec];
  if (runId) args.push("--run", runId);
  return orca(...args);
});
ipcMain.handle("orca:orch-send", (_e, handle, text) =>
  orca("terminal", "send", "--terminal", handle, "--text", text, "--enter")
);

// ── tmux adapter: handles look like "tmux:%12" (pane id). Lets the widget read and drive Claude Code
// sessions that run inside tmux when Orca is not installed (or a session is not an Orca terminal). ──
const TMUX_BIN = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "tmux"];
let tmuxBin = null;
async function findTmux() {
  if (tmuxBin !== null) return tmuxBin;
  for (const b of TMUX_BIN) { try { await exec("test", ["-x", b]); tmuxBin = b; return b; } catch {} }
  try { const { stdout } = await exec("/usr/bin/which", ["tmux"], { env: { ...process.env, PATH: EXEC_PATH } }); tmuxBin = stdout.trim() || ""; } catch { tmuxBin = ""; }
  return tmuxBin;
}
async function tmux(...args) {
  const bin = await findTmux();
  if (!bin) throw new Error("tmux not installed");
  const { stdout } = await exec(bin, args, { timeout: 8000, env: { ...process.env, PATH: EXEC_PATH } });
  return stdout;
}
const isTmux = h => typeof h === "string" && h.startsWith("tmux:");
const paneOf = h => h.slice(5);
// panes running a Claude Code process: [{ handle, cwd, cmd, target, pid }]
async function tmuxPanes() {
  try {
    const out = await tmux("list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_title}");
    return out.split("\n").filter(Boolean).map(l => {
      const [id, cwd, cmd, target, pid, title] = l.split("\t");
      return { handle: `tmux:${id}`, cwd, cmd, target, pid: Number(pid), title: title || "" };
    });
  } catch { return []; }
}
// spinner / "esc to interrupt" line of the Claude Code TUI — a turn is in progress
const SPINNER_LINE = /^[·•✢✳✶✻✽✦✧*⠁-⣿]\s*\S[^(]*…\s*(\(|$)|esc to interrupt/;
async function tmuxCapture(pane, lines = 80) {
  const out = await tmux("capture-pane", "-p", "-t", pane, "-S", `-${lines}`);
  const tail = out.replace(/\n+$/, "").split("\n");
  return { ok: true, result: { terminal: { handle: `tmux:${pane}`, tail } } };
}
async function tmuxSend(pane, text, enter) {
  await tmux("send-keys", "-t", pane, "-l", text);
  if (enter !== false) { await new Promise(r => setTimeout(r, 120)); await tmux("send-keys", "-t", pane, "Enter"); }
  // mirror Orca's --wait-submit: report whether the TUI started a turn within ~4s
  let started = false;
  for (let i = 0; i < 8 && !started; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const { result } = await tmuxCapture(pane, 25); started = result.terminal.tail.some(l => SPINNER_LINE.test(l.trim())); } catch {}
  }
  return { ok: true, result: { send: { accepted: true, prompt: { stages: started ? ["submitted", "turn_started"] : ["submitted"] } } } };
}
async function tmuxWaitIdle(pane, timeoutMs) {
  const until = Date.now() + (timeoutMs || 180000);
  while (Date.now() < until) {
    try { const { result } = await tmuxCapture(pane, 25); if (!result.terminal.tail.some(l => SPINNER_LINE.test(l.trim()))) return { ok: true, result: { state: "tui-idle" } }; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, error: "timeout" };
}
async function tmuxSwitch(pane) {
  try {
    const target = (await tmux("display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}")).trim();
    await tmux("select-window", "-t", target); await tmux("select-pane", "-t", pane);
    exec("/usr/bin/osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name is in {"iTerm2", "Terminal", "WezTerm", "Ghostty", "kitty", "Alacritty"}) to true'], { timeout: 3000 }).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle("roca:tmux-panes", () => tmuxPanes());

// claude processes running in ordinary terminal tabs: handle "term:<pid>". iTerm2 sessions are matched by the
// ITERM_SESSION_ID the process inherited (Claude Code may sit on its own pty, so tty alone is unreliable);
// Terminal.app tabs are matched by tty.
const termTargets = new Map();   // pid → { pid, tty, cwd, sessionId, program, itermId, startedAt, handle }
// walk the parent chain of a pid (up to 6 levels) and return the first ancestor that is a tmux pane shell
async function tmuxPaneForPid(pid, paneByPid) {
  let cur = pid;
  for (let i = 0; i < 6 && cur > 1; i++) {
    if (paneByPid.has(cur)) return paneByPid.get(cur);
    try { const { stdout } = await exec("/bin/ps", ["-o", "ppid=", "-p", String(cur)]); cur = Number(stdout.trim()); } catch { break; }
  }
  return null;
}
async function ttyTargets() {
  try {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,tty=,lstart=,command="]);
    const rows = stdout.split("\n").map(l => l.trim()).filter(l => /^\d+\s+ttys\d+\s+.+?\s(\S*\/)?claude(\s|$)/.test(l));
    const panes = await tmuxPanes();
    const paneByPid = new Map(panes.map(p => [p.pid, p]));
    const out = [];
    for (const row of rows) {
      const m = row.match(/^(\d+)\s+(ttys\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/); if (!m) continue;
      const pid = Number(m[1]), tty = `/dev/${m[2]}`, startedAt = Date.parse(m[3]) || 0, cmd = m[4];
      const sessionId = (cmd.match(/--resume\s+([0-9a-f-]{8,})/) || [])[1] || null;
      let cwd = "", program = "", itermId = "", inTmux = false;
      try { const r = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 4000 }); cwd = (r.stdout.split("\n").find(l => l.startsWith("n")) || "").slice(1); } catch {}
      try {
        const r = await exec("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { timeout: 4000 });
        program = (r.stdout.match(/\bTERM_PROGRAM=(\S+)/) || [])[1] || "";
        itermId = ((r.stdout.match(/\bITERM_SESSION_ID=(\S+)/) || [])[1] || "").split(":").pop();
        inTmux = /\bTMUX=/.test(r.stdout);
      } catch {}
      if (/^Orca$/i.test(program)) continue;                                   // Orca terminals are handled by Orca itself
      let handle = `term:${pid}`, kind = itermId ? "iterm" : "terminal";
      if (inTmux) { const pane = await tmuxPaneForPid(pid, paneByPid); if (pane) { handle = pane.handle; kind = "tmux"; } }
      const target = { handle, kind, pid, tty, cwd, sessionId, program, itermId, startedAt, cmd };
      termTargets.set(pid, target);
      out.push(target);
    }
    return out;
  } catch { return []; }
}
ipcMain.handle("roca:tty-targets", () => ttyTargets());

// first-run onboarding: what this Mac has — Claude Code, the widget hooks, the Orca CLI, running terminal apps
const CLAUDE_PATHS = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude", join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude"), join(homedir(), ".npm-global", "bin", "claude")];
ipcMain.handle("roca:env-check", async () => {
  await orcaReady;
  let claudePath = CLAUDE_PATHS.find(p => existsSync(p)) || null;
  if (!claudePath) { try { claudePath = (await exec("/bin/zsh", ["-lc", "command -v claude"], { timeout: 4000 })).stdout.trim() || null; } catch {} }
  const claudeDir = existsSync(join(homedir(), ".claude"));
  let orcaVersion = null;
  if (orcaBinFound) { try { orcaVersion = (await exec(orcaBin, ["--version"], { timeout: 5000, env: { ...process.env, PATH: EXEC_PATH } })).stdout.trim().split("\n")[0]; } catch {} }
  const terms = [];
  for (const n of ["iTerm2", "Terminal"]) if (await appRunning(n)) terms.push(n);
  return { claude: { found: !!(claudePath || claudeDir), path: claudePath }, hooks: hooksInstalled(), orca: { found: !!orcaBinFound, path: orcaBinFound ? orcaBin : null, version: orcaVersion }, terminals: terms };
});
// trigger macOS Automation prompts (System Events + the running terminal apps) so the user grants them up front
ipcMain.handle("roca:automation-request", async () => {
  const out = {};
  try { await osa('tell application "System Events" to count processes'); out.systemEvents = true; } catch (e) { out.systemEvents = false; }
  for (const n of ["iTerm2", "Terminal"]) {
    if (!(await appRunning(n))) continue;
    try { await osa(`tell application "${n}" to count windows`); out[n] = true; } catch { out[n] = false; }
  }
  return out;
});

async function appRunning(name) { try { return (await osa(`tell application "System Events" to (name of processes) contains "${name}"`)) === "true"; } catch { return false; } }
// reopen an ended Claude Code session in a new terminal tab: cd <cwd> && claude --resume <id>
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
ipcMain.handle("roca:resume-session", async (_e, cwd, sessionId) => {
  if (!/^[0-9a-f-]{8,}$/i.test(String(sessionId || ""))) return { ok: false, error: "invalid session id" };
  const cmd = `cd ${shq(cwd || homedir())} && claude --resume ${sessionId}`;
  try {
    if (await appRunning("iTerm2")) {
      await osa(`tell application "iTerm2"
  set w to (create window with default profile)
  tell current session of current tab of w to write text "${q(cmd)}"
  activate
end tell`);
      return { ok: true, app: "iTerm2" };
    }
    await osa(`tell application "Terminal"
  activate
  do script "${q(cmd)}"
end tell`);
    return { ok: true, app: "Terminal" };
  } catch (e) { return { ok: false, error: e.message }; }
});

const isTerm = h => typeof h === "string" && h.startsWith("term:");
const targetOf = h => termTargets.get(Number(h.slice(5)));
async function osa(script) { const { stdout } = await exec("/usr/bin/osascript", ["-e", script], { timeout: 10000 }); return stdout.replace(/\n$/, ""); }
const q = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// AppleScript that runs `body` with `s` (iTerm session) or `tb` (Terminal tab) bound to the matching terminal
function termScript(tg, bodyIterm, bodyTerminal) {
  if (tg.itermId) return `tell application "iTerm2"
  repeat with w in windows
    repeat with tb in tabs of w
      repeat with s in sessions of tb
        if (id of s) contains "${tg.itermId}" then
          ${bodyIterm}
        end if
      end repeat
    end repeat
  end repeat
end tell
return "__notfound__"`;
  return `tell application "Terminal"
  repeat with w in windows
    repeat with tb in tabs of w
      if tty of tb is "${tg.tty}" then
        ${bodyTerminal}
      end if
    end repeat
  end repeat
end tell
return "__notfound__"`;
}
async function runTerm(tg, bodyIterm, bodyTerminal) {
  const r = await osa(termScript(tg, bodyIterm, bodyTerminal));
  if (r === "__notfound__") throw new Error("terminal tab not found");
  return r;
}
async function termRead(tg) {
  const text = await runTerm(tg, `return contents of s`, `return contents of tb`);
  const tail = text.replace(/\s+$/, "").split("\n").slice(-80);
  return { ok: true, result: { terminal: { handle: tg.handle, tail } } };
}
async function termSend(tg, text, enter) {
  await runTerm(tg, `tell s to write text "${q(text)}" newline ${enter === false ? "false" : "true"}
          return "ok"`, `do script "${q(text)}" in tb
        return "ok"`);
  let started = false;
  for (let i = 0; i < 8 && !started; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const { result } = await termRead(tg); started = result.terminal.tail.slice(-25).some(l => SPINNER_LINE.test(l.trim())); } catch {}
  }
  return { ok: true, result: { send: { accepted: true, prompt: { stages: started ? ["submitted", "turn_started"] : ["submitted"] } } } };
}
async function termWaitIdle(tg, timeoutMs) {
  const until = Date.now() + (timeoutMs || 180000);
  while (Date.now() < until) {
    try { const { result } = await termRead(tg); if (!result.terminal.tail.slice(-25).some(l => SPINNER_LINE.test(l.trim()))) return { ok: true, result: { state: "tui-idle" } }; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: false, error: "timeout" };
}
async function termSwitch(tg) {
  try {
    await runTerm(tg, `tell tb to select
          tell w to select
          activate
          return "ok"`, `set selected of tb to true
        set frontmost of w to true
        activate
        return "ok"`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function termInterrupt(tg) {
  try {
    if (tg.itermId) await runTerm(tg, `tell s to write text (ASCII character 27) newline false
          return "ok"`, ``);
    else { await termSwitch(tg); await osa(`tell application "System Events" to key code 53`); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
const withTarget = (handle, fn) => { const tg = targetOf(handle); return tg ? fn(tg) : Promise.resolve({ ok: false, error: "terminal process is gone" }); };

ipcMain.handle("orca:terminal-switch", async (_e, handle) => {
  if (isTmux(handle)) return tmuxSwitch(paneOf(handle));
  if (isTerm(handle)) return withTarget(handle, termSwitch);
  const result = await orca("terminal", "switch", "--terminal", handle);
  exec("/usr/bin/osascript", ["-e", 'tell application "Orca" to activate'], { timeout: 3000 }).catch(() => {});
  return result;
});

ipcMain.handle("orca:terminal-interrupt", async (_e, handle) => {
  if (isTmux(handle)) { try { await tmux("send-keys", "-t", paneOf(handle), "Escape"); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
  if (isTerm(handle)) return withTarget(handle, termInterrupt);
  return orca("terminal", "send", "--terminal", handle, "--interrupt");
});

ipcMain.handle("orca:terminal-send", (_e, handle, text, enter, waitSubmit) => {
  if (isTmux(handle)) return tmuxSend(paneOf(handle), text, enter).catch(err => ({ ok: false, error: err.message }));
  if (isTerm(handle)) return withTarget(handle, tg => termSend(tg, text, enter)).catch(err => ({ ok: false, error: err.message }));
  const args = ["terminal", "send", "--terminal", handle, "--text", text];
  if (enter) args.push("--enter");
  if (waitSubmit) args.push("--wait-submit", String(waitSubmit));
  const timeoutMs = waitSubmit ? (waitSubmit * 1000 + 10000) : 15000;
  return exec(orcaBin, [...args, "--json"], {
    timeout: timeoutMs,
    env: { ...process.env, PATH: EXEC_PATH },
  }).then(({ stdout }) => JSON.parse(stdout)).catch(err => ({ ok: false, error: err.message }));
});

ipcMain.handle("orca:terminal-wait", (_e, handle, condition, timeoutMs) => {
  if (isTmux(handle)) return tmuxWaitIdle(paneOf(handle), timeoutMs);
  if (isTerm(handle)) return withTarget(handle, tg => termWaitIdle(tg, timeoutMs));
  const args = ["terminal", "wait", "--terminal", handle, "--for", condition];
  if (timeoutMs) args.push("--timeout-ms", String(timeoutMs));
  return exec(orcaBin, [...args, "--json"], {
    timeout: (timeoutMs || 180000) + 5000,
    env: { ...process.env, PATH: EXEC_PATH },
  }).then(({ stdout }) => JSON.parse(stdout)).catch(err => ({ ok: false, error: err.message }));
});

ipcMain.handle("orca:terminal-read", async (_e, handle, screen, cursor, limit) => {
  if (isTmux(handle)) return tmuxCapture(paneOf(handle)).catch(err => ({ ok: false, error: err.message }));
  if (isTerm(handle)) return withTarget(handle, termRead).catch(err => ({ ok: false, error: err.message }));
  const args = ["terminal", "read", "--terminal", handle];
  if (screen) args.push("--screen");
  if (cursor != null) args.push("--cursor", String(cursor));
  if (limit != null) args.push("--limit", String(limit));
  const res = await orca(...args);
  const tail = res?.result?.terminal?.tail;
  if (process.env.ROCA_DEBUG) console.log(`[terminal-read] screen=${!!screen} tail=${Array.isArray(tail) ? tail.length : 'none'}`);
  return res;
});

ipcMain.handle("orca:terminal-close", async (_e, handle) => {
  if (isTmux(handle)) { try { await tmux("kill-pane", "-t", paneOf(handle)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
  if (isTerm(handle)) return { ok: false, error: "close is not supported for plain terminal tabs" };
  return orca("terminal", "close", "--terminal", handle);
});

// ── transcript metadata for hook-discovered sessions (no Orca): last assistant text, context usage, git branch ──
const transcriptMetaCache = new Map();
ipcMain.handle("roca:session-meta", async (_e, transcriptPath, cwd) => {
  const out = { title: null, lastMsg: "", ctxPct: null, branch: "", model: null };
  try {
    if (transcriptPath && existsSync(transcriptPath)) {
      const st = statSync(transcriptPath);
      const cached = transcriptMetaCache.get(transcriptPath);
      if (cached && cached.mtimeMs === st.mtimeMs) Object.assign(out, cached.meta);
      else {
        const size = st.size, from = Math.max(0, size - 400000);
        const fd = openSync(transcriptPath, "r");
        const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from);
        // title records (ai-title / custom-title) sit near the top of the file
        const headLen = Math.min(size, 200000); const head = Buffer.alloc(headLen); readSync(fd, head, 0, headLen, 0);
        closeSync(fd);
        let usage = null, model = null, lastText = "", title = null, customTitle = null;
        const lines = from > headLen ? head.toString("utf-8").split("\n").concat(buf.toString("utf-8").split("\n")) : buf.toString("utf-8").split("\n");
        for (const line of lines) {
          if (!line.startsWith("{")) continue;
          let rec; try { rec = JSON.parse(line); } catch { continue; }
          if (rec.type === "ai-title") title = rec.aiTitle || title;
          if (rec.type === "custom-title") customTitle = rec.customTitle || customTitle;
          if (rec.type !== "assistant") continue;
          const m = rec.message || {};
          if (m.usage) { usage = m.usage; model = m.model || model; }
          for (const c of (m.content || [])) if (c && c.type === "text" && c.text) lastText = c.text;
        }
        if (usage) {
          const used = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          const window = /1m|fable/i.test(model || "") ? 1000000 : 200000;
          out.ctxPct = Math.min(100, Math.round(used / window * 100));
        }
        out.lastMsg = lastText.slice(0, 300); out.model = model; out.title = customTitle || title;   // /rename wins over the AI title
        transcriptMetaCache.set(transcriptPath, { mtimeMs: st.mtimeMs, meta: { ...out } });
      }
    }
    if (cwd) { try { const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000, env: { ...process.env, PATH: EXEC_PATH } }); out.branch = stdout.trim(); } catch {} }
  } catch {}
  return out;
});

ipcMain.on("orca:session-counts", (_e, counts) => {
  const { running, asks } = counts;
  if (tray) {
    const parts = [];
    if (running > 0) parts.push(`▶${running}`);
    if (asks > 0) parts.push(`?${asks}`);
    tray.setTitle(parts.length ? ` ${parts.join(" ")}` : "");
  }
  if (running > prevRunningCount && prevRunningCount >= 0) {
    new Notification({
      title: "Orca Dashboard",
      body: `${running - prevRunningCount}개 세션이 새로 실행을 시작했습니다`,
    }).show();
  }
  prevRunningCount = running;
});

let resizeAnim = null;
ipcMain.on("orca:resize-window", (_e, w, h, forceHeight) => {
  if (!mainWindow) return;
  const [curW, curH] = mainWindow.getSize();
  const [curX, curY] = mainWindow.getPosition();

  const display = screen.getDisplayMatching({ x: curX, y: curY, width: curW, height: curH });
  const wa = display.workArea;

  let targetW = Math.min(w, wa.width);
  let targetH = forceHeight ? Math.min(h, wa.height) : curH;

  let targetX = curX;
  let targetY = curY;
  if (targetX + targetW > wa.x + wa.width) targetX = wa.x + wa.width - targetW;
  if (targetY + targetH > wa.y + wa.height) targetY = wa.y + wa.height - targetH;
  if (targetX < wa.x) targetX = wa.x;
  if (targetY < wa.y) targetY = wa.y;

  mainWindow.setMinimumSize(Math.min(280, Math.min(targetW, curW)), Math.min(44, Math.min(targetH, curH)));
  mainWindow.setMaximumSize(Math.max(480, Math.max(targetW, curW)), Math.max(Math.max(targetH, curH), wa.height));

  if (resizeAnim) { clearInterval(resizeAnim); resizeAnim = null; }
  const steps = 12;
  let step = 0;
  resizeAnim = setInterval(() => {
    step++;
    const t = step / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const sw = Math.round(curW + (targetW - curW) * ease);
    const sh = Math.round(curH + (targetH - curH) * ease);
    const sx = Math.round(curX + (targetX - curX) * ease);
    const sy = Math.round(curY + (targetY - curY) * ease);
    mainWindow.setBounds({ x: sx, y: sy, width: sw, height: sh });
    if (step >= steps) {
      clearInterval(resizeAnim);
      resizeAnim = null;
      mainWindow.setMinimumSize(Math.min(280, targetW), Math.min(44, targetH));
      mainWindow.setMaximumSize(Math.max(480, targetW), Math.max(targetH, wa.height));
      mainWindow.setBounds({ x: targetX, y: targetY, width: targetW, height: targetH });
    }
  }, 16);
});

ipcMain.on("orca:done-notify", (_e, name) => {
  new Notification({ title: "작업 완료", body: name }).show();
});

// ── Clipboard ──
ipcMain.handle("orca:clipboard-read", () => clipboard.readText());
ipcMain.handle("orca:clipboard-write", (_e, text) => { clipboard.writeText(text); return true; });

// ── Port Monitor ──
const execAsync = promisify(execCb);
ipcMain.handle("orca:scan-ports", async () => {
  try {
    const { stdout } = await execAsync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true", { timeout: 5000 });
    const lines = stdout.split("\n").slice(1).filter(Boolean);
    const ports = [];
    const seen = new Set();
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts[0];
      const pid = parts[1];
      const user = parts[2];
      const addrPort = parts[8];
      const match = addrPort.match(/:(\d+)$/);
      if (!match) continue;
      const port = Number(match[1]);
      const key = `${port}-${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ port, pid: Number(pid), name, user });
    }
    ports.sort((a, b) => a.port - b.port);
    return ports;
  } catch { return []; }
});

ipcMain.handle("orca:kill-process", async (_e, pid) => {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) { throw new Error(err.message); }
});


ipcMain.on("orca:set-opacity", (_e, val) => {
  if (!mainWindow) return;
  mainWindow.setOpacity(val);
});

// ── Claude Code hooks → ~/.roca/events.jsonl → renderer (exact working/waiting/needs-input) ──
const ROCA_DIR = join(homedir(), ".roca");
const HOOK_SCRIPT = join(ROCA_DIR, "hook.sh");
const EVENTS_FILE = join(ROCA_DIR, "events.jsonl");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification", "PermissionRequest", "SubagentStart", "SubagentStop", "SessionEnd", "PostCompact"];
const HOOK_SH = `#!/bin/bash
# Orca Widget hook: append the Claude Code hook payload to ~/.roca/events.jsonl and exit immediately.
f="$HOME/.roca/events.jsonl"
payload=$(cat | tr -d '\n')
[ -z "$payload" ] && exit 0
# term: which terminal app launched this claude (Orca / iTerm.app / tmux / Apple_Terminal) — lets the widget tell Orca sessions apart
printf '{"ts":%s,"term":"%s","ev":%s}\n' "$(date +%s)" "\${TERM_PROGRAM//[^A-Za-z0-9._-]/}" "$payload" >> "$f" 2>/dev/null
# keep the log bounded (~5000 lines)
if [ $(( $(date +%s) % 50 )) -eq 0 ] && [ -f "$f" ] && [ "$(wc -l < "$f")" -gt 6000 ]; then
  tail -n 4000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
fi
exit 0
`;

function readSettings() {
  try { return JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf-8")); } catch { return {}; }
}
function isOurHook(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h?.command === "string" && h.command.includes("/.roca/hook.sh"));
}
function hooksInstalled() {
  const s = readSettings();
  const h = s.hooks || {};
  return HOOK_EVENTS.every(ev => Array.isArray(h[ev]) && h[ev].some(isOurHook)) && existsSync(HOOK_SCRIPT);
}
function installHooks() {
  mkdirSync(ROCA_DIR, { recursive: true });
  writeFileSync(HOOK_SCRIPT, HOOK_SH);
  chmodSync(HOOK_SCRIPT, 0o755);
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, "");
  const s = readSettings();
  if (existsSync(CLAUDE_SETTINGS)) copyFileSync(CLAUDE_SETTINGS, join(ROCA_DIR, `settings.backup-${Date.now()}.json`));
  s.hooks = s.hooks || {};
  for (const ev of HOOK_EVENTS) {
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev].filter(e => !isOurHook(e)) : [];
    arr.push({ hooks: [{ type: "command", command: HOOK_SCRIPT, timeout: 5, async: true }] });
    s.hooks[ev] = arr;
  }
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
  startEventsWatch();
  return { ok: true };
}
function uninstallHooks() {
  const s = readSettings();
  if (s.hooks) {
    for (const ev of Object.keys(s.hooks)) {
      if (!Array.isArray(s.hooks[ev])) continue;
      s.hooks[ev] = s.hooks[ev].filter(e => !isOurHook(e));
      if (!s.hooks[ev].length) delete s.hooks[ev];
    }
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n");
  }
  return { ok: true };
}

let eventsOffset = 0;
let eventsWatcher = null;
let eventsPollTimer = null;
function readNewEvents() {
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    const size = statSync(EVENTS_FILE).size;
    if (size < eventsOffset) eventsOffset = 0;            // truncated/rotated
    if (size === eventsOffset) return [];
    const fd = openSync(EVENTS_FILE, "r");
    const buf = Buffer.alloc(size - eventsOffset);
    readSync(fd, buf, 0, buf.length, eventsOffset);
    closeSync(fd);
    eventsOffset = size;
    const out = [];
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}
function pushEvents(evts) {
  if (evts.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:hook-events", evts);
}
function startEventsWatch() {
  if (eventsWatcher || eventsPollTimer) return;
  if (!existsSync(EVENTS_FILE)) return;
  try { eventsWatcher = fsWatch(EVENTS_FILE, () => pushEvents(readNewEvents())); } catch {}
  eventsPollTimer = setInterval(() => pushEvents(readNewEvents()), 1500);   // fs.watch can miss appends on macOS
}
ipcMain.handle("orca:version", async () => {
  await orcaReady;
  try { const { stdout } = await exec(orcaBin, ["--version"], { timeout: 8000, env: { ...process.env, PATH: EXEC_PATH } }); return stdout.trim(); }
  catch { return null; }
});
ipcMain.handle("orca:hooks-status", () => ({ installed: hooksInstalled(), script: HOOK_SCRIPT, events: EVENTS_FILE }));
ipcMain.handle("orca:hooks-install", () => { try { return installHooks(); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("orca:hooks-uninstall", () => { try { return uninstallHooks(); } catch (e) { return { ok: false, error: e.message }; } });
const TEAMS_FILE = join(ROCA_DIR, "teams.json");
ipcMain.handle("orca:teams-read", () => { try { return JSON.parse(readFileSync(TEAMS_FILE, "utf-8")); } catch { return null; } });
ipcMain.handle("orca:teams-write", (_e, data) => { try { mkdirSync(ROCA_DIR, { recursive: true }); writeFileSync(TEAMS_FILE, JSON.stringify(data, null, 2)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
const ZONES_FILE = join(ROCA_DIR, "zones.json");
ipcMain.handle("orca:zones-read", () => { try { return JSON.parse(readFileSync(ZONES_FILE, "utf-8")); } catch { return null; } });
ipcMain.handle("orca:zones-write", (_e, data) => { try { mkdirSync(ROCA_DIR, { recursive: true }); writeFileSync(ZONES_FILE, JSON.stringify(data, null, 2)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("orca:hooks-recent", () => {
  // replay the last ~30 minutes so state is right immediately after launch
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
    eventsOffset = statSync(EVENTS_FILE).size;
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const out = [];
    for (const l of lines) { try { const o = JSON.parse(l); if (o.ts >= cutoff) out.push(o); } catch {} }
    return out;
  } catch { return []; }
});

app.on("ready", () => {
  createWindow();
  if (process.env.ROCA_HOOKS_INSTALL) { try { installHooks(); console.log("[hooks] installed"); } catch (e) { console.log("[hooks] install failed", e.message); } }
  // keep an already-installed hook script current after widget updates
  try { if (existsSync(HOOK_SCRIPT) && readFileSync(HOOK_SCRIPT, "utf-8") !== HOOK_SH) { writeFileSync(HOOK_SCRIPT, HOOK_SH); chmodSync(HOOK_SCRIPT, 0o755); console.log("[hooks] script refreshed"); } } catch (e) { console.log("[hooks] refresh failed", e.message); }
  startEventsWatch();
  createTray();
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
