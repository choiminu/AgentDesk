import { app, BrowserWindow, clipboard, ipcMain, screen, Tray, Menu, nativeImage, Notification, shell } from "electron";
import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter as PATH_DELIM } from "node:path";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync, openSync, readSync, closeSync, watch as fsWatch, chmodSync, copyFileSync, cpSync, readlinkSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { readTeamConfig, writeTeamExample, startTeamServer, fetchPeer, TEAM_CFG } from "./team/peer.mjs";
import * as jiraOAuth from "./jira-oauth.mjs";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// platform switches: terminal control (AppleScript) and Orca are macOS-only; tmux works on macOS/Linux; hooks work everywhere
const IS_MAC = process.platform === "darwin", IS_WIN = process.platform === "win32", IS_LINUX = process.platform === "linux";
// `command -v` (POSIX) / `where` (Windows) with the widget's extended PATH
async function whichCmd(name) {
  try {
    if (IS_WIN) return (await exec("where", [name], { timeout: 4000 })).stdout.split(/\r?\n/)[0].trim() || null;
    return (await exec("/bin/sh", ["-lc", `command -v ${name}`], { timeout: 4000, env: { ...process.env, PATH: EXEC_PATH } })).stdout.trim() || null;
  } catch { return null; }
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const WIN_W = 320;
const WIN_H = 480;
const MARGIN = 16;

let mainWindow = null;
let tray = null;
let prevRunningCount = 0;
let saveBoundsTimer = null;

// the app was called "roca" before it became AgentDesk: carry the old profile (window bounds, localStorage) over once
{
  const nu = app.getPath("userData"); const old = join(dirname(nu), "roca");
  if (!existsSync(nu) && existsSync(old)) { try { cpSync(old, nu, { recursive: true }); } catch {} }
}
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
  const savedH = saved?.height ?? WIN_H;
  const h = savedH < 320 ? WIN_H : savedH;   // bounds saved while collapsed → full height (saved is null on first run)

  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    x, y,
    minWidth: 280,
    minHeight: 300,
    maxWidth: 480,
    alwaysOnTop: true,
    frame: false,
    transparent: IS_MAC,
    hasShadow: true,
    resizable: true,
    skipTaskbar: false,
    ...(IS_MAC ? { vibrancy: "under-window", visualEffectState: "active" } : { backgroundColor: "#0e1014" }),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("widget.html", process.env.ROCA_START_PAGE ? { hash: process.env.ROCA_START_PAGE } : undefined);
  if (process.env.ROCA_SHOT) {
    for (const [i, delay] of [[1, 8000], [2, 13500], [3, 24000], [4, 48000]]) {
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
    { label: "AgentDesk 열기", click: () => mainWindow.show() },
    { type: "separator" },
    { label: "종료", click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip("AgentDesk");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

app.on("before-quit", () => { app.isQuitting = true; if (slackChild) { try { slackChild.kill(); } catch {} } if (teamServer) { try { teamServer.close(); } catch {} } });   // no orphan bridge that would post every reply twice
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
const EXEC_PATH = [process.env.PATH || "", ...(IS_WIN ? [] : ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".local", "bin"), "/Applications/Orca.app/Contents/Resources/bin"])].join(PATH_DELIM);

async function findOrca() {
  if (process.env.ROCA_ORCA_BIN) return process.env.ROCA_ORCA_BIN;
  if (!IS_MAC) return (await whichCmd("orca")) || "orca";   // Orca ships for macOS; elsewhere only an explicit install counts
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

function orca(...args) { return orcaTimed(15000, ...args); }
// same as orca() with a caller-chosen timeout (worktree creation, Jira network calls)
async function orcaTimed(timeout, ...args) {
  await orcaReady;
  try {
    const { stdout } = await exec(orcaBin, [...args, "--json"], {
      timeout,
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
      detail: (() => { try { const j = JSON.parse(err.stdout); return String((j.error && (j.error.message || j.error)) || ""); } catch { return ""; } })(),   // the CLI prints its JSON error on stdout and exits 1
      bin: orcaBin,
    };
  }
}

ipcMain.handle("orca:ps", () => orca("worktree", "ps"));
ipcMain.handle("orca:terminals", () => orca("terminal", "list"));
ipcMain.handle("orca:rate-limits", () => orca("account", "list"));
ipcMain.handle("orca:repos", () => orca("repo", "list"));

// ── Jira: Atlassian OAuth (jira-oauth.mjs) when signed in, otherwise Orca's own Jira connection; and a worktree per ticket ──
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const JIRA_FILTERS = new Set(["assigned", "reported", "all", "done"]);
const badArg = (msg) => ({ ok: false, error: msg });
const viaOAuth = (fn) => fn().catch(e => badArg(e.message));
ipcMain.handle("roca:jira-status", () => jiraOAuth.connected() ? jiraOAuth.connectionResult() : orca("jira", "connection"));
ipcMain.handle("roca:jira-list", (_e, opts = {}) => {
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 30));
  const jql = typeof opts.jql === "string" ? opts.jql.trim() : "";
  if (jql && (jql.length > 2000 || jql.startsWith("-"))) return badArg("invalid JQL");
  const filter = JIRA_FILTERS.has(opts.filter) ? opts.filter : "assigned";
  if (jiraOAuth.connected()) return viaOAuth(() => jql ? jiraOAuth.search(jql, limit) : jiraOAuth.list(filter, limit));
  if (jql) return orcaTimed(30000, "jira", "search", jql, "--limit", String(limit));
  return orcaTimed(30000, "jira", "list", "--filter", filter, "--limit", String(limit));
});
ipcMain.handle("roca:jira-issue", (_e, key) => {
  if (!JIRA_KEY_RE.test(key || "")) return badArg("invalid Jira key");
  return jiraOAuth.connected() ? viaOAuth(() => jiraOAuth.issue(key)) : orcaTimed(30000, "jira", "issue", key);
});
ipcMain.handle("roca:jira-comment", async (_e, key, body) => {
  if (!JIRA_KEY_RE.test(key || "")) return badArg("invalid Jira key");
  if (typeof body !== "string" || !body.trim() || body.length > 32000) return badArg("comment body is empty or too long");
  if (jiraOAuth.connected()) return viaOAuth(() => jiraOAuth.comment(key, body));
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-jira-"));
  const file = join(dir, "comment.txt");
  try {
    writeFileSync(file, body, { mode: 0o600 });
    return await orcaTimed(30000, "jira", "comment", "add", key, "--body-file", file);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
// Kanban board (OAuth only; the Orca CLI path keeps the plain list)
ipcMain.handle("roca:jira-projects", () => jiraOAuth.connected() ? viaOAuth(() => jiraOAuth.projects()) : badArg("OAuth not connected"));
ipcMain.handle("roca:jira-board", (_e, key, opts = {}) => jiraOAuth.connected() ? viaOAuth(() => jiraOAuth.board(String(key || ""), !!opts.mine)) : badArg("OAuth not connected"));
// OAuth setup from the Jira tab: the renderer only ever sees status() (client id, hasSecret, site), never secrets or tokens
const oauthCall = (fn) => { try { return Promise.resolve(fn()).catch(e => ({ ok: false, error: e.message })); } catch (e) { return { ok: false, error: e.message }; } };
ipcMain.handle("roca:jira-oauth-status", () => oauthCall(() => jiraOAuth.status()));
ipcMain.handle("roca:jira-oauth-save", (_e, clientId, clientSecret) => oauthCall(() => jiraOAuth.saveCredentials(clientId, clientSecret)));
ipcMain.handle("roca:jira-oauth-login", () => oauthCall(() => jiraOAuth.login()));
ipcMain.handle("roca:jira-oauth-logout", () => oauthCall(() => jiraOAuth.logout()));
ipcMain.handle("roca:jira-oauth-site", (_e, cloudId) => oauthCall(() => jiraOAuth.chooseSite(String(cloudId || ""))));
ipcMain.handle("orca:worktree-create", async (_e, opts = {}) => {
  const name = String(opts.name || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) return badArg("invalid worktree name");
  const args = ["worktree", "create", "--name", name, "--no-parent"];
  if (opts.repo) { if (typeof opts.repo !== "string" || opts.repo.startsWith("-") || opts.repo.length > 500) return badArg("invalid repo"); args.push("--repo", opts.repo); }
  if (opts.agent) { if (!/^[a-z0-9-]{1,30}$/.test(opts.agent)) return badArg("invalid agent"); args.push("--agent", opts.agent); }
  if (opts.prompt) { if (typeof opts.prompt !== "string" || opts.prompt.length > 20000) return badArg("prompt too long"); args.push("--prompt", opts.prompt); }
  if (!opts.reference) return orcaTimed(180000, ...args);
  if (!JIRA_KEY_RE.test(opts.reference)) return badArg("invalid Jira key");
  // --reference needs a Jira site connected in Orca; without one (OAuth users) the CLI refuses up front, so retry without it
  const r = await orcaTimed(180000, ...args, "--reference", opts.reference);
  return r && r.ok === false && /connected Jira site/i.test(r.detail || "") ? orcaTimed(180000, ...args) : r;
});

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
const TMUX_BIN = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
let tmuxBin = null;
async function findTmux() {
  if (tmuxBin !== null) return tmuxBin;
  if (IS_WIN) { tmuxBin = ""; return tmuxBin; }
  for (const b of TMUX_BIN) if (existsSync(b)) { tmuxBin = b; return b; }
  tmuxBin = (await whichCmd("tmux")) || "";
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
    if (IS_MAC) exec("/usr/bin/osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name is in {"iTerm2", "Terminal", "WezTerm", "Ghostty", "kitty", "Alacritty"}) to true'], { timeout: 3000 }).catch(() => {});
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
    try { const { stdout } = await exec("ps", ["-o", "ppid=", "-p", String(cur)]); cur = Number(stdout.trim()); } catch { break; }
  }
  return null;
}
async function ttyTargets() {
  if (IS_WIN) return [];   // no terminal control on Windows yet: sessions come from hooks, read-only
  try {
    const { stdout } = await exec("ps", ["-axo", "pid=,tty=,lstart=,command="]);
    const rows = stdout.split("\n").map(l => l.trim()).filter(l => /^\d+\s+(ttys\d+|pts\/\d+)\s+.+?\s(\S*\/)?(claude|gemini|codex|opencode)(\s|$)/.test(l));
    const panes = await tmuxPanes();
    const paneByPid = new Map(panes.map(p => [p.pid, p]));
    const out = [];
    for (const row of rows) {
      const m = row.match(/^(\d+)\s+(ttys\d+|pts\/\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/); if (!m) continue;
      const pid = Number(m[1]), tty = `/dev/${m[2]}`, startedAt = Date.parse(m[3]) || 0, cmd = m[4];
      const agent = (cmd.match(/(?:^|\s)(?:\S*\/)?(claude|gemini|codex|opencode)(?:\s|$)/) || [])[1] || "claude";
      const sessionId = (cmd.match(/(?:--resume|\bresume)\s+([0-9a-zA-Z_-]{8,})/) || [])[1] || null;
      let cwd = "", program = "", itermId = "", inTmux = false;
      if (IS_LINUX) {
        try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch {}
        try {
          const env = readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0");
          program = (env.find(l => l.startsWith("TERM_PROGRAM=")) || "").slice(13);
          inTmux = env.some(l => l.startsWith("TMUX="));
        } catch {}
      } else {
        try { const r = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 4000 }); cwd = (r.stdout.split("\n").find(l => l.startsWith("n")) || "").slice(1); } catch {}
        try {
          const r = await exec("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { timeout: 4000 });
          program = (r.stdout.match(/\bTERM_PROGRAM=(\S+)/) || [])[1] || "";
          itermId = ((r.stdout.match(/\bITERM_SESSION_ID=(\S+)/) || [])[1] || "").split(":").pop();
          inTmux = /\bTMUX=/.test(r.stdout);
        } catch {}
      }
      if (/^Orca$/i.test(program)) continue;                                   // Orca terminals are handled by Orca itself
      if (!IS_MAC && !inTmux) continue;                                        // outside macOS only tmux panes can be driven
      let handle = `term:${pid}`, kind = itermId ? "iterm" : "terminal";
      if (inTmux) { const pane = await tmuxPaneForPid(pid, paneByPid); if (pane) { handle = pane.handle; kind = "tmux"; } }
      const target = { handle, kind, pid, tty, cwd, sessionId, agent, program, itermId, startedAt, cmd };
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
  if (!claudePath) claudePath = await whichCmd("claude");
  const claudeDir = existsSync(join(homedir(), ".claude"));
  const agents = {};
  for (const c of ["claude", "gemini", "codex", "opencode"]) agents[c] = await whichCmd(c);
  agents.claude = agents.claude || claudePath || null;
  let orcaVersion = null;
  if (orcaBinFound) { try { orcaVersion = (await exec(orcaBin, ["--version"], { timeout: 5000, env: { ...process.env, PATH: EXEC_PATH } })).stdout.trim().split("\n")[0]; } catch {} }
  const terms = [];
  if (IS_MAC) for (const n of ["iTerm2", "Terminal"]) if (await appRunning(n)) terms.push(n);
  const tmuxPath = await findTmux();
  return { platform: process.platform, claude: { found: !!(claudePath || claudeDir), path: claudePath }, agents, hooks: hooksInstalled(), hookAgents: hooksAgents(), orca: { found: !!orcaBinFound, path: orcaBinFound ? orcaBin : null, version: orcaVersion }, terminals: terms, tmux: tmuxPath || null };
});
// trigger macOS Automation prompts (System Events + the running terminal apps) so the user grants them up front
ipcMain.handle("roca:automation-request", async () => {
  const out = {};
  if (!IS_MAC) return out;
  try { await osa('tell application "System Events" to count processes'); out.systemEvents = true; } catch (e) { out.systemEvents = false; }
  for (const n of ["iTerm2", "Terminal"]) {
    if (!(await appRunning(n))) continue;
    try { await osa(`tell application "${n}" to count windows`); out[n] = true; } catch { out[n] = false; }
  }
  return out;
});

async function appRunning(name) { if (!IS_MAC) return false; try { return (await osa(`tell application "System Events" to (name of processes) contains "${name}"`)) === "true"; } catch { return false; } }
// reopen an ended Claude Code session in a new terminal tab: cd <cwd> && claude --resume <id>
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const RESUME_CMD = { claude: id => `claude --resume ${id}`, gemini: id => `gemini --resume ${id}`, codex: id => `codex resume ${id}` };
ipcMain.handle("roca:resume-session", async (_e, cwd, sessionId, agent) => {
  if (!/^[0-9a-zA-Z_-]{8,}$/.test(String(sessionId || ""))) return { ok: false, error: "invalid session id" };
  const mk = RESUME_CMD[agent] || RESUME_CMD.claude;
  const dir = cwd || homedir();
  if (IS_WIN) {
    // Windows Terminal when present, else a plain console window
    const inner = `cd /d "${dir}" && ${mk(sessionId)}`;
    try {
      if (await whichCmd("wt.exe")) spawn("wt.exe", ["-d", dir, "cmd", "/k", mk(sessionId)], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      else spawn("cmd.exe", ["/c", "start", "", "cmd", "/k", inner], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      return { ok: true, app: "Windows Terminal" };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  const cmd = `cd ${shq(dir)} && ${mk(sessionId)}`;
  if (IS_LINUX) {
    // first terminal emulator that exists; the shell stays open after the agent exits
    const sh = `${cmd}; exec bash`;
    const candidates = [
      ["x-terminal-emulator", ["-e", `bash -lc ${shq(sh)}`]],
      ["gnome-terminal", [`--working-directory=${dir}`, "--", "bash", "-lc", sh]],
      ["konsole", ["--workdir", dir, "-e", "bash", "-lc", sh]],
      ["xfce4-terminal", [`--working-directory=${dir}`, "-e", `bash -lc ${shq(sh)}`]],
      ["kitty", ["--directory", dir, "bash", "-lc", sh]],
      ["alacritty", ["--working-directory", dir, "-e", "bash", "-lc", sh]],
      ["xterm", ["-e", "bash", "-lc", sh]],
    ];
    for (const [bin, args] of candidates) {
      if (!(await whichCmd(bin))) continue;
      try { spawn(bin, args, { detached: true, stdio: "ignore" }).unref(); return { ok: true, app: bin }; } catch {}
    }
    return { ok: false, error: "no terminal emulator found (install gnome-terminal, konsole, kitty, alacritty or xterm)" };
  }
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
// transcript readers per agent: title (user's /rename or AI title, else the first real prompt), last assistant text, context usage
function readHeadTail(path, size) {
  const from = Math.max(0, size - 400000);
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from);
  const headLen = Math.min(size, 200000); const head = Buffer.alloc(headLen); readSync(fd, head, 0, headLen, 0);
  closeSync(fd);
  return from > headLen ? head.toString("utf-8").split("\n").concat(buf.toString("utf-8").split("\n")) : buf.toString("utf-8").split("\n");
}
const firstLine = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl — message objects {type:'user'|'gemini', content}, plus {$set:{messages:[…]}} patches
function parseGeminiTranscript(lines) {
  const out = { title: null, lastMsg: "", ctxPct: null, model: null };
  const msgs = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.$set && Array.isArray(rec.$set.messages)) msgs.push(...rec.$set.messages);
    else if (rec.type) msgs.push(rec);
  }
  let lastTokens = null;
  for (const msg of msgs) {
    const text = Array.isArray(msg.content) ? msg.content.map(c => c && c.text || "").join(" ") : String(msg.content || "");
    if (msg.type === "user" && !out.title && text && !/^\s*<session_context>/.test(text)) out.title = firstLine(text);
    if (msg.type === "gemini") { if (text) out.lastMsg = text.slice(0, 300); if (msg.tokens) lastTokens = msg.tokens; if (msg.model) out.model = msg.model; }
  }
  if (lastTokens && lastTokens.total) { const window = /pro/i.test(out.model || "") ? 1000000 : 1000000; out.ctxPct = Math.min(100, Math.round((lastTokens.input || lastTokens.total) / window * 100)); }
  return out;
}
// Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
// and {type:'event_msg', payload:{type:'token_count', info:{last_token_usage:{total_tokens}, model_context_window}}}
function parseCodexTranscript(lines) {
  const out = { title: null, lastMsg: "", ctxPct: null, model: null };
  let used = null, window = null;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const p = rec.payload || rec;
    if (rec.type === "session_meta" || p.type === "session_meta") { out.model = (p.payload && p.payload.model) || p.model || out.model; continue; }
    if (p.type === "message" && Array.isArray(p.content)) {
      const text = p.content.map(c => c && (c.text || c.input_text || c.output_text) || "").join(" ");
      if (p.role === "user" && !out.title && text && !/^\s*(<environment_context>|<user_instructions>|#\s*AGENTS)/i.test(text)) out.title = firstLine(text);
      if (p.role === "assistant" && text) out.lastMsg = text.slice(0, 300);
    }
    if (p.type === "token_count" && p.info) { const u = p.info.last_token_usage || p.info.total_token_usage; if (u) used = u.total_tokens || used; window = p.info.model_context_window || window; }
  }
  if (used && window) out.ctxPct = Math.min(100, Math.round(used / window * 100));
  return out;
}
ipcMain.handle("roca:session-meta", async (_e, transcriptPath, cwd, agent) => {
  const out = { title: null, lastMsg: "", ctxPct: null, branch: "", model: null };
  try {
    if (transcriptPath && existsSync(transcriptPath)) {
      const st = statSync(transcriptPath);
      const cached = transcriptMetaCache.get(transcriptPath);
      if (cached && cached.mtimeMs === st.mtimeMs) Object.assign(out, cached.meta);
      else if (agent === "gemini" || agent === "codex") {
        Object.assign(out, (agent === "gemini" ? parseGeminiTranscript : parseCodexTranscript)(readHeadTail(transcriptPath, st.size)));
        transcriptMetaCache.set(transcriptPath, { mtimeMs: st.mtimeMs, meta: { ...out } });
      } else {
        let usage = null, model = null, lastText = "", title = null, customTitle = null;
        const lines = readHeadTail(transcriptPath, st.size);
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
    if (IS_MAC) tray.setTitle(parts.length ? ` ${parts.join(" ")}` : "");
  }
  if (running > prevRunningCount && prevRunningCount >= 0) {
    new Notification({
      title: "AgentDesk",
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
ipcMain.handle("orca:notify", (_e, title, body) => {
  try { new Notification({ title: String(title || ""), body: String(body || "") }).show(); return true; } catch { return false; }
});

// ── Clipboard ──
ipcMain.handle("orca:clipboard-read", () => clipboard.readText());
ipcMain.handle("orca:clipboard-write", (_e, text) => { clipboard.writeText(text); return true; });

// ── Port Monitor ──
const execAsync = promisify(execCb);
ipcMain.handle("orca:scan-ports", async () => {
  if (IS_WIN) return [];
  if (IS_LINUX) {
    try {
      const { stdout } = await execAsync("ss -ltnpH 2>/dev/null || true", { timeout: 5000 });
      const ports = []; const seen = new Set();
      for (const line of stdout.split("\n").filter(Boolean)) {
        const parts = line.split(/\s+/); const local = parts[3] || ""; const port = Number((local.match(/:(\d+)$/) || [])[1]);
        if (!port) continue;
        const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/); const name = pm ? pm[1] : "?", pid = pm ? pm[2] : "";
        const key = `${port}-${pid}`; if (seen.has(key)) continue; seen.add(key);
        ports.push({ port, pid: Number(pid) || 0, name, user: "" });
      }
      return ports.sort((a, b) => a.port - b.port);
    } catch { return []; }
  }
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
const HOOK_SCRIPT = join(ROCA_DIR, IS_WIN ? "hook.ps1" : "hook.sh");
// the command string registered in each agent's hook settings; `agent` tags events so the widget knows the CLI
function hookCommand(agent) {
  if (IS_WIN) return `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_SCRIPT}"${agent && agent !== "claude" ? ` -Agent ${agent}` : ""}`;
  return `${agent && agent !== "claude" ? `AGENTDESK_AGENT=${agent} ` : ""}${HOOK_SCRIPT}`;
}
const EVENTS_FILE = join(ROCA_DIR, "events.jsonl");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "Notification", "PermissionRequest", "SubagentStart", "SubagentStop", "SessionEnd", "PostCompact"];
const HOOK_PS1 = `param([string]$Agent = "claude")
# AgentDesk hook (Windows): append the agent's hook payload to %USERPROFILE%\\.roca\\events.jsonl and exit immediately.
$f = Join-Path $env:USERPROFILE ".roca\\events.jsonl"
if ($env:AGENTDESK_RECALL) { exit 0 }
$payload = ([Console]::In.ReadToEnd()) -replace "\\r?\\n", ""
if (-not $payload) { exit 0 }
$ts = [int][double]::Parse((Get-Date -UFormat %s))
$term = ($env:TERM_PROGRAM -replace "[^A-Za-z0-9._-]", "")
Add-Content -Path $f -Value ('{"ts":' + $ts + ',"term":"' + $term + '","agent":"' + $Agent + '","ev":' + $payload + '}') -Encoding UTF8
exit 0
`;
const HOOK_SH = IS_WIN ? HOOK_PS1 : `#!/bin/bash
# AgentDesk hook: append the Claude Code hook payload to ~/.roca/events.jsonl and exit immediately.
f="$HOME/.roca/events.jsonl"
[ -n "$AGENTDESK_RECALL" ] && exit 0   # headless summarizer sessions (agentdesk-recall) are not shown as sessions
payload=$(cat | tr -d '\n')
[ -z "$payload" ] && exit 0
# term: which terminal app launched this claude (Orca / iTerm.app / tmux / Apple_Terminal) — lets the widget tell Orca sessions apart
printf '{"ts":%s,"term":"%s","agent":"%s","ev":%s}\n' "$(date +%s)" "\${TERM_PROGRAM//[^A-Za-z0-9._-]/}" "\${AGENTDESK_AGENT:-claude}" "$payload" >> "$f" 2>/dev/null
# keep the log bounded (~5000 lines)
if [ $(( $(date +%s) % 50 )) -eq 0 ] && [ -f "$f" ] && [ "$(wc -l < "$f")" -gt 6000 ]; then
  tail -n 4000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
fi
exit 0
`;

// Every supported agent CLI has a Claude Code-style hook system; each gets the same hook.sh, tagged with its name.
//   claude: ~/.claude/settings.json  "hooks" (timeout in seconds, async)
//   gemini: ~/.gemini/settings.json  "hooks" (BeforeAgent/AfterAgent/BeforeTool/AfterTool…, timeout in ms)
//   codex:  ~/.codex/hooks.json      "hooks" (same event names as Claude Code)
const AGENT_HOOKS = {
  claude: { label: "Claude Code", dir: join(homedir(), ".claude"), settings: CLAUDE_SETTINGS, events: HOOK_EVENTS,
            entry: () => ({ hooks: [{ type: "command", command: hookCommand("claude"), timeout: 5, async: true }] }) },
  gemini: { label: "Gemini CLI", dir: join(homedir(), ".gemini"), settings: join(homedir(), ".gemini", "settings.json"),
            events: ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification", "PreCompress"],
            entry: () => ({ hooks: [{ type: "command", command: hookCommand("gemini"), timeout: 10000 }] }) },
  codex:  { label: "Codex CLI", dir: join(homedir(), ".codex"), settings: join(homedir(), ".codex", "hooks.json"),
            events: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification", "PermissionRequest", "SubagentStart", "SubagentStop", "PostCompact"],
            entry: () => ({ hooks: [{ type: "command", command: hookCommand("codex"), timeout: 5 }] }) },
};
function readJsonFile(p) { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; } }
function readSettings() { return readJsonFile(CLAUDE_SETTINGS); }
function isOurHook(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h?.command === "string" && /[\\/]\.roca[\\/]hook\.(sh|ps1)/.test(h.command));
}
function agentPresent(a) { return existsSync(AGENT_HOOKS[a].dir); }
function agentHooksInstalled(a) {
  const cfg = AGENT_HOOKS[a]; const h = readJsonFile(cfg.settings).hooks || {};
  return cfg.events.every(ev => Array.isArray(h[ev]) && h[ev].some(isOurHook)) && existsSync(HOOK_SCRIPT);
}
// per-agent state for the UI: "on" | "off" | "absent" (CLI not installed on this Mac)
// some of our hooks present but not all (an event was added in an update) → counts as on, and startup re-registers the full set
function agentHooksPartial(a) {
  const cfg = AGENT_HOOKS[a]; const h = readJsonFile(cfg.settings).hooks || {};
  return cfg.events.some(ev => Array.isArray(h[ev]) && h[ev].some(isOurHook)) && !agentHooksInstalled(a);
}
function hooksAgents() {
  const out = {};
  for (const a of Object.keys(AGENT_HOOKS)) out[a] = !agentPresent(a) ? "absent" : (agentHooksInstalled(a) || agentHooksPartial(a)) ? "on" : "off";
  return out;
}
// installed = the user turned exact detection on for at least one agent; newly found CLIs are covered at startup
function hooksInstalled() { return Object.values(hooksAgents()).some(v => v === "on"); }
function installAgentHooks(a) {
  const cfg = AGENT_HOOKS[a];
  const s = readJsonFile(cfg.settings);
  if (existsSync(cfg.settings)) copyFileSync(cfg.settings, join(ROCA_DIR, `${a}-settings.backup-${Date.now()}.json`));
  s.hooks = s.hooks || {};
  for (const ev of cfg.events) {
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev].filter(e => !isOurHook(e)) : [];
    arr.push(cfg.entry());
    s.hooks[ev] = arr;
  }
  mkdirSync(dirname(cfg.settings), { recursive: true });
  writeFileSync(cfg.settings, JSON.stringify(s, null, 2) + "\n");
}
function uninstallAgentHooks(a) {
  const cfg = AGENT_HOOKS[a]; if (!existsSync(cfg.settings)) return;
  const s = readJsonFile(cfg.settings);
  if (!s.hooks) return;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev].filter(e => !isOurHook(e));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeFileSync(cfg.settings, JSON.stringify(s, null, 2) + "\n");
}
function installHooks(agents) {
  mkdirSync(ROCA_DIR, { recursive: true });
  writeFileSync(HOOK_SCRIPT, HOOK_SH);
  if (!IS_WIN) chmodSync(HOOK_SCRIPT, 0o755);
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, "");
  const list = (agents && agents.length ? agents : Object.keys(AGENT_HOOKS)).filter(a => AGENT_HOOKS[a] && agentPresent(a));
  for (const a of list) installAgentHooks(a);
  startEventsWatch();
  return { ok: true, agents: list };
}
function uninstallHooks(agents) {
  const list = (agents && agents.length ? agents : Object.keys(AGENT_HOOKS)).filter(a => AGENT_HOOKS[a]);
  for (const a of list) uninstallAgentHooks(a);
  return { ok: true, agents: list };
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
      try { out.push(JSON.parse(line.replace(/^\uFEFF/, ""))); } catch {}   // PowerShell may write a BOM
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
// new-version check against GitHub Releases, at most once a day (cached in userData); the renderer shows a badge
const UPDATE_API = "https://api.github.com/repos/choiminu/AgentDesk/releases/latest";
const UPDATE_CACHE = join(app.getPath("userData"), "update-check.json");
const semverNewer = (a, b) => { const pa = String(a).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0), pb = String(b).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return false; };
ipcMain.handle("roca:update-check", async (_e, force) => {
  const current = app.getVersion();
  let cache = null; try { cache = JSON.parse(readFileSync(UPDATE_CACHE, "utf-8")); } catch {}
  if (!force && cache && Date.now() - cache.at < 24 * 3600 * 1000) return { ...cache, current, newer: semverNewer(cache.latest, current) };
  try {
    const res = await fetch(UPDATE_API, { headers: { "User-Agent": `AgentDesk/${current}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const info = { at: Date.now(), latest: String(j.tag_name || "").replace(/^v/, ""), url: j.html_url || "https://github.com/choiminu/AgentDesk/releases", name: j.name || "" };
    try { writeFileSync(UPDATE_CACHE, JSON.stringify(info)); } catch {}
    return { ...info, current, newer: semverNewer(info.latest, current) };
  } catch (e) { return { at: Date.now(), current, latest: cache?.latest || null, url: cache?.url || null, newer: cache ? semverNewer(cache.latest, current) : false, error: e.message }; }
});
ipcMain.handle("roca:app-version", () => app.getVersion());
// "what is it doing right now?" — one sentence from the last few turns of the transcript (Haiku), cached per file state for 5 minutes
const nowCache = new Map();   // transcriptPath → { key, at, text }
let nowInFlight = 0;
const NOW_PROMPT = "You get the last turns of an AI coding session. Reply with ONE sentence (≤ 60 characters, same language as the conversation, no subject like 'the agent', present tense, concrete: feature/file/error) saying what is being worked on right now. Return ONLY JSON {\"now\": \"...\"}.";
// headless Claude with the prompt on stdin; resolves stdout, rejects with stderr
function runClaude(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env: { ...process.env, PATH: EXEC_PATH, AGENTDESK_RECALL: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "all" } });
    let out = "", err = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeoutMs || 60000);
    child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `exit ${code}`)); });
    child.stdin.end(input);
  });
}
function transcriptTailText(path, agent) {
  const st = statSync(path); const size = st.size, from = Math.max(0, size - 120000);
  const fd = openSync(path, "r"); const buf = Buffer.alloc(size - from); readSync(fd, buf, 0, buf.length, from); closeSync(fd);
  const turns = [];
  for (const line of buf.toString("utf-8").split("\n")) {
    if (!line.startsWith("{")) continue; let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (agent === "gemini") { const msgs = rec.$set?.messages || (rec.type ? [rec] : []); for (const x of msgs) { const tx = Array.isArray(x.content) ? x.content.map(c => c && c.text || "").join(" ") : String(x.content || ""); if (tx && !/^\s*<session_context>/.test(tx)) turns.push(`${x.type === "user" ? "USER" : "ASSISTANT"}: ${tx.slice(0, 600)}`); } continue; }
    if (agent === "codex") { const p = rec.payload || rec; if (p.type === "message" && Array.isArray(p.content)) { const tx = p.content.map(c => c && (c.text || "")).join(" "); if (tx) turns.push(`${p.role === "user" ? "USER" : "ASSISTANT"}: ${tx.slice(0, 600)}`); } continue; }
    if (rec.type !== "user" && rec.type !== "assistant" || rec.isMeta || rec.isSidechain) continue;
    const c = rec.message?.content; const tx = Array.isArray(c) ? c.map(x => x && (x.text || (x.type === "tool_use" ? `[tool ${x.name} ${String(x.input?.file_path || x.input?.command || x.input?.pattern || "").slice(0, 60)}]` : ""))).filter(Boolean).join(" ") : String(c || "");
    if (!tx || /^<(command-name|local-command|system-reminder)/.test(tx.trim())) continue;
    if (rec.type === "user" && Array.isArray(c) && c.every(x => x && x.type === "tool_result")) continue;
    turns.push(`${rec.type === "user" ? "USER" : "ASSISTANT"}: ${tx.slice(0, 600)}`);
  }
  return { key: `${st.mtimeMs}:${size}`, text: turns.slice(-8).join("\n") };
}
ipcMain.handle("roca:now-summary", async (_e, transcriptPath, agent) => {
  if (!transcriptPath || !existsSync(transcriptPath)) { if (process.env.ROCA_DEBUG) console.log("[now] no transcript", transcriptPath); return null; }
  let tail; try { tail = transcriptTailText(transcriptPath, agent || "claude"); } catch (e) { if (process.env.ROCA_DEBUG) console.log("[now] tail failed", e.message); return null; }
  const c = nowCache.get(transcriptPath);
  if (c && (c.key === tail.key || Date.now() - c.at < 5 * 60 * 1000)) return c.text;
  if (!tail.text || tail.text.length < 80 || nowInFlight >= 2) return c ? c.text : null;
  if (process.env.ROCA_DEBUG) console.log("[now] ask", transcriptPath.split("/").pop().slice(0, 8), "chars", tail.text.length);
  nowInFlight++;
  try {
    // the transcript goes through stdin: --disallowedTools is variadic and would swallow a positional prompt
    const stdout = await runClaude(["-p", "--model", "haiku", "--output-format", "json", "--json-schema", JSON.stringify({ type: "object", additionalProperties: false, required: ["now"], properties: { now: { type: "string" } } }), "--system-prompt", NOW_PROMPT, "--disable-slash-commands", "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"], tail.text, 60000);
    const env2 = JSON.parse(stdout); const obj = env2.structured_output || (typeof env2.result === "string" ? JSON.parse(env2.result) : env2.result);
    const text = String(obj?.now || "").trim().slice(0, 90);
    if (process.env.ROCA_DEBUG) console.log("[now] ->", JSON.stringify(text));
    nowCache.set(transcriptPath, { key: tail.key, at: Date.now(), text });
    return text;
  } catch (e) { if (process.env.ROCA_DEBUG) console.log("[now] failed:", String(e.stderr || e.message).slice(-600)); nowCache.set(transcriptPath, { key: tail.key, at: Date.now() - 4 * 60 * 1000, text: c ? c.text : "" }); return c ? c.text : null; }
  finally { nowInFlight--; }
});
// morning briefing: recall/brief.mjs writes ~/.agentdesk/briefing.json; the main process schedules it once a day
const BRIEF_FILE = join(homedir(), ".agentdesk", "briefing.json");
const BRIEF_CFG = join(app.getPath("userData"), "brief-config.json");
let briefCfg = { enabled: true, time: "08:30" }; try { Object.assign(briefCfg, JSON.parse(readFileSync(BRIEF_CFG, "utf-8"))); } catch {}
let briefRunning = false;
function readBrief() { try { return JSON.parse(readFileSync(BRIEF_FILE, "utf-8")); } catch { return null; } }
function runBrief() {
  if (briefRunning || !RECALL_CLI) return false;
  const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(p => existsSync(p)) || process.execPath;
  briefRunning = true;
  const child = spawn(node, [join(dirname(RECALL_CLI), "brief.mjs")], { detached: true, stdio: "ignore", env: { ...process.env, PATH: EXEC_PATH, ELECTRON_RUN_AS_NODE: "1" } });
  child.on("exit", () => { briefRunning = false; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:brief-updated", readBrief()); });
  child.on("error", () => { briefRunning = false; });
  child.unref();
  return true;
}
function briefTick() {
  if (!briefCfg.enabled) return;
  const now = new Date(); const [hh, mm] = String(briefCfg.time || "08:30").split(":").map(Number);
  const due = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
  const today = now.toISOString().slice(0, 10); const cur = readBrief();
  if (due && (!cur || cur.date !== today)) runBrief();
}
setInterval(briefTick, 5 * 60 * 1000); setTimeout(briefTick, 20000);
ipcMain.handle("roca:brief-read", () => ({ brief: readBrief(), cfg: briefCfg, running: briefRunning, jira: existsSync(join(homedir(), ".agentdesk", "jira.json")) }));
ipcMain.handle("roca:brief-config", (_e, cfg) => { briefCfg = { ...briefCfg, ...(cfg || {}) }; try { writeFileSync(BRIEF_CFG, JSON.stringify(briefCfg)); } catch {} return briefCfg; });
ipcMain.handle("roca:brief-now", () => ({ started: runBrief() }));

// Slack front desk: recall/slack-bridge.mjs runs as a child when ~/.agentdesk/slack.json exists; tasks arrive as files in
// ~/.agentdesk/inbox/, the renderer hands them to a session and writes the REPORT to inbox/replies/ for the bridge to post.
const INBOX_DIR = join(homedir(), ".agentdesk", "inbox"), INBOX_REPLIES = join(INBOX_DIR, "replies"), SLACK_CFG = join(homedir(), ".agentdesk", "slack.json");
let slackChild = null, slackRestartAt = 0, slackStatus = { configured: false, running: false, lastError: "" };
function startSlackBridge() {
  slackStatus.configured = existsSync(SLACK_CFG);
  if (!slackStatus.configured || slackChild || !RECALL_CLI || Date.now() < slackRestartAt) return;
  const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(p => existsSync(p)) || process.execPath;
  const child = spawn(node, [join(dirname(RECALL_CLI), "slack-bridge.mjs")], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: EXEC_PATH, ELECTRON_RUN_AS_NODE: "1" } });
  slackChild = child; slackStatus.running = true; slackStatus.lastError = "";
  let err = ""; child.stderr.on("data", d => { err = (err + d.toString()).slice(-400); });
  child.on("exit", (code) => { slackChild = null; slackStatus.running = false; if (code) slackStatus.lastError = err.trim().split("\n").pop() || `exit ${code}`; slackRestartAt = Date.now() + 60000; });
}
setInterval(startSlackBridge, 30000); setTimeout(startSlackBridge, 8000);
const inboxSeen = new Set();
function pumpInbox() {
  try {
    mkdirSync(INBOX_REPLIES, { recursive: true });
    for (const f of readdirSync(INBOX_DIR).filter(f => f.endsWith(".json"))) {
      const p = join(INBOX_DIR, f); if (inboxSeen.has(p)) continue; inboxSeen.add(p);
      let task; try { task = JSON.parse(readFileSync(p, "utf-8")); } catch { continue; }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:inbox-task", task);
      try { unlinkSync(p); } catch {}
    }
  } catch {}
}
setInterval(pumpInbox, 3000);
ipcMain.handle("roca:inbox-reply", (_e, reply) => { try { mkdirSync(INBOX_REPLIES, { recursive: true }); writeFileSync(join(INBOX_REPLIES, `${reply.id}-${Date.now()}.json`), JSON.stringify(reply)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("roca:inbox-status", () => ({ ...slackStatus, configured: existsSync(SLACK_CFG) }));
ipcMain.handle("roca:inbox-restart", () => { if (slackChild) { try { slackChild.kill(); } catch {} } slackRestartAt = 0; setTimeout(startSlackBridge, 500); return { ok: true }; });
// session notes written by recall/ (MongoDB) for a checkout: spawn the CLI, which knows the worktree/repo rules; [] when unavailable
const RECALL_CLI = [join(__dirname, "recall", "cli.mjs"), join(homedir(), "project", "agentdesk-internal", "recall", "cli.mjs"), join(homedir(), "orca-widget", "recall", "cli.mjs")].find(p => existsSync(p)) || null;
// ── team sharing (phase 1): publish my sessions on the office network, poll teammates' — read-only, see team/peer.mjs ──
let teamCfg = null, teamServer = null, teamServerKey = "", teamStatus = { configured: false, listening: false, error: "", name: "", port: 0, peers: {} };
let teamSnapshot = { at: 0, sessions: [] };
ipcMain.on("roca:team-publish", (_e, sessions) => { teamSnapshot = { at: Date.now(), sessions: Array.isArray(sessions) ? sessions : [] }; });
function teamReload() {
  const cfg = readTeamConfig();
  teamStatus.configured = !!cfg; teamStatus.error = cfg && cfg.error ? cfg.error : "";
  if (!cfg || cfg.error) { teamCfg = null; if (teamServer) { try { teamServer.close(); } catch {} teamServer = null; teamStatus.listening = false; } return; }
  teamCfg = cfg; teamStatus.name = cfg.name; teamStatus.port = cfg.port;
  const key = `${cfg.bind}:${cfg.port}`;
  if (teamServer && teamServerKey === key) return;
  if (teamServer) { try { teamServer.close(); } catch {} teamServer = null; }
  const srv = startTeamServer(cfg, () => teamSnapshot);
  srv.once("error", (e) => { teamStatus.listening = false; teamStatus.error = `listen ${key}: ${e.code || e.message}`; teamServer = null; });
  srv.listen(cfg.port, cfg.bind, () => { teamStatus.listening = true; teamStatus.error = ""; });
  teamServer = srv; teamServerKey = key;
}
async function teamPoll() {
  if (!teamCfg) return;
  const results = await Promise.all(teamCfg.peers.map(p => fetchPeer(p, teamCfg.token)));
  const peers = {};
  for (const r of results) {
    const prev = teamStatus.peers[r.name] || {};
    // keep the last good snapshot for a while so a blip does not empty the list
    peers[r.name] = r.ok ? { ...r, lastOk: r.at } : { name: r.name, ok: false, error: r.error, sessions: prev.lastOk && Date.now() - prev.lastOk < 60000 ? prev.sessions : [], at: prev.at || 0, lastOk: prev.lastOk || 0 };
  }
  teamStatus.peers = peers;
}
setTimeout(() => { teamReload(); teamPoll(); }, 3000);
setInterval(teamReload, 30000);
setInterval(teamPoll, 3000);
ipcMain.handle("roca:team-status", () => teamStatus);
ipcMain.handle("roca:team-setup", () => { try { const created = writeTeamExample(); teamReload(); return { ok: true, created, file: TEAM_CFG }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("roca:team-open-config", () => { shell.showItemInFolder(TEAM_CFG); return true; });
ipcMain.handle("roca:recall-notes", async (_e, cwd, limit) => {
  if (!RECALL_CLI || !cwd || !existsSync(cwd)) return [];
  const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(p => existsSync(p)) || process.execPath;
  const run = async (extra) => { const { stdout } = await exec(node, [RECALL_CLI, "list", "--json", "--limit", String(limit || 3), ...extra], { cwd, timeout: 5000, env: { ...process.env, PATH: EXEC_PATH, ELECTRON_RUN_AS_NODE: "1" } }); const arr = JSON.parse(stdout.trim().split("\n").pop() || "[]"); return Array.isArray(arr) ? arr : []; };
  try {
    // notes from this very checkout first; other worktrees of the same repo only when it has none
    const own = await run(["--worktree", cwd.split("/").filter(Boolean).pop()]);
    return own.length ? own : await run([]);
  } catch { return []; }
});
ipcMain.handle("roca:open-external", (_e, url) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url); });

ipcMain.handle("orca:version", async () => {
  await orcaReady;
  try { const { stdout } = await exec(orcaBin, ["--version"], { timeout: 8000, env: { ...process.env, PATH: EXEC_PATH } }); return stdout.trim(); }
  catch { return null; }
});
ipcMain.handle("orca:hooks-status", () => ({ installed: hooksInstalled(), agents: hooksAgents(), script: HOOK_SCRIPT, events: EVENTS_FILE }));
ipcMain.handle("orca:hooks-install", (_e, agents) => { try { return installHooks(agents); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle("orca:hooks-uninstall", (_e, agents) => { try { return uninstallHooks(agents); } catch (e) { return { ok: false, error: e.message }; } });
const TEAMS_FILE = join(ROCA_DIR, "teams.json");
ipcMain.handle("orca:teams-read", () => { try { return JSON.parse(readFileSync(TEAMS_FILE, "utf-8")); } catch { return null; } });
ipcMain.handle("orca:teams-write", (_e, data) => { try { mkdirSync(ROCA_DIR, { recursive: true }); writeFileSync(TEAMS_FILE, JSON.stringify(data, null, 2)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
// knowledge base: a folder the user points the widget at (Settings → 지침서 저장소). Prompts see it as {kb};
// if it carries agentdesk/zones.json that file becomes the shared zone set. Nothing here assumes a specific repo.
function kbResolve(p) {
  if (!p || typeof p !== "string") return null;
  const t = p.trim(); if (!t) return null;
  return t.startsWith("~") ? join(homedir(), t.slice(1)) : t;
}
ipcMain.handle("orca:kb-check", (_e, p) => {
  const dir = kbResolve(p); if (!dir) return { ok: false, path: null, zones: false };
  let ok = false; try { ok = statSync(dir).isDirectory(); } catch {}
  return { ok, path: dir, zones: ok && existsSync(join(dir, "agentdesk", "zones.json")) };
});
// zone set for a knowledge base: agentdesk/zones.json if the team keeps one, otherwise one zone per top-level
// category folder that has a README.md (name from its first heading). Both are generic — no repo-specific logic.
const KB_SKIP_DIRS = new Set(["node_modules", "common", "scripts", "docs", "dist", "build", "agentdesk", "records", "templates", "procedures", "guides"]);
const KB_ICONS = [[/jira|ticket|issue/i, "🎫"], [/db|sql|data/i, "🗄"], [/settle|fin|pay|account/i, "💰"], [/slack|chat/i, "💬"], [/mail|email/i, "✉"], [/quer/i, "🧮"], [/deploy|ops|infra/i, "🚀"], [/test|qa/i, "🧪"], [/doc|wiki|guide/i, "📄"]];
function kbHeading(file) {
  try { const m = readFileSync(file, "utf-8").match(/^#\s+(.+)$/m); return m ? m[1].replace(/[`*_]/g, "").trim() : ""; } catch { return ""; }
}
function kbGenerateZones(dir) {
  const zones = [];
  const hasSafety = existsSync(join(dir, "common", "safety-rules.md"));
  let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return zones; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".") || KB_SKIP_DIRS.has(e.name)) continue;
    const readme = join(dir, e.name, "README.md"); if (!existsSync(readme)) continue;
    const heading = kbHeading(readme) || e.name;
    const name = heading.split(/\s+[—–-]\s+/).pop().slice(0, 12);
    const icon = (KB_ICONS.find(([re]) => re.test(e.name + " " + heading)) || [null, "📁"])[1];
    const has = sub => existsSync(join(dir, e.name, sub));
    const prompt = `[${name}] ` +
      (hasSafety ? "먼저 `{kb}/common/safety-rules.md`를 읽고 그 규칙을 최우선으로 지켜. " : "") +
      "`{kb}/README.md`의 사용 흐름을 따르고, 이번 요청의 카테고리 문서 `{kb}/" + e.name + "/README.md`를 읽어 절차대로 진행해. " +
      (has("procedures") ? "`{kb}/" + e.name + "/procedures/`에 같은 주제의 문서가 있으면 그대로 따르고, " : "") +
      (has("guides") ? "`guides/`의 규칙·배경을 확인하고, " : "") +
      (has("templates") ? "`templates/`의 양식으로 결과물을 만들어. " : "") +
      "무엇을 할지는 이 대화의 맥락과 현재 저장소({repo}, 브랜치 {branch})의 최근 작업(git status·log·diff)에서 파악하고, 정해지지 않은 선택지는 작업 전에 AskUserQuestion으로 한 번만 물어봐. " +
      "생성·발송·수정 같은 쓰기 동작은 초안(대상·본문 전문)을 보여주고 확인받기 전에는 하지 마." +
      (has("records") ? " 반복될 만한 처리였으면 `{kb}/" + e.name + "/records/YYYYMMDD_주제.md` 기록을 제안해(날짜는 `date` 결과)." : "") +
      "\n\n마지막에 REPORT_START 로 시작해 [한 일] [변경 파일] [막힌 점] [다음 제안] 네 항목을 각 1~3줄로 쓰고 REPORT_END 로 끝내줘.";
    zones.push({ id: "kb-" + e.name, icon, name, auto: false, prompt, source: "kb" });
  }
  return zones;
}
ipcMain.handle("orca:kb-zones", (_e, p) => {
  const dir = kbResolve(p); if (!dir) return null;
  try { const d = JSON.parse(readFileSync(join(dir, "agentdesk", "zones.json"), "utf-8")); if (d && Array.isArray(d.zones)) return { zones: d.zones.map(z => ({ ...z, source: "kb" })), generated: false }; } catch {}
  return { zones: kbGenerateZones(dir), generated: true };
});
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
  try { if (existsSync(HOOK_SCRIPT) && readFileSync(HOOK_SCRIPT, "utf-8") !== HOOK_SH) { writeFileSync(HOOK_SCRIPT, HOOK_SH); if (!IS_WIN) chmodSync(HOOK_SCRIPT, 0o755); console.log("[hooks] script refreshed"); } } catch (e) { console.log("[hooks] refresh failed", e.message); }
  // exact detection already on: extend it to agent CLIs that appeared since (e.g. Gemini CLI installed later)
  try {
    const st = hooksAgents();
    if (Object.values(st).some(v => v === "on")) for (const [a, v] of Object.entries(st)) if (v === "off" || agentHooksPartial(a)) { installAgentHooks(a); console.log("[hooks] installed for", a); }
  } catch (e) { console.log("[hooks] extend failed", e.message); }
  startEventsWatch();
  createTray();
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
