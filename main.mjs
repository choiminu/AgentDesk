import { app, BrowserWindow, clipboard, ipcMain, screen, Tray, Menu, nativeImage, Notification, shell, dialog } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename, delimiter as PATH_DELIM } from "node:path";
import { readdirSync, readFileSync, writeFileSync, statSync, lstatSync, createReadStream, mkdirSync, existsSync, openSync, readSync, writeSync, closeSync, renameSync, watch as fsWatch, chmodSync, copyFileSync, cpSync, readlinkSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { readTeamConfig, startTeamServer, fetchPeer, postNote, postHello, remoteInput, remoteInterrupt, remoteLast, remoteScreen, ensureInstanceId, addPeerToConfig, removePeerFromConfig, upsertPeer, classifyMove, onHomeNetwork, withHomeSubnets, UUID_RE, validateNote, setTeamFields, newTeamToken, rotateTeamToken, encodeInvite, decodeInvite, writeTeamJson, isShared, sameSubnet, TEAM_CFG } from "./team/peer.mjs";
import { startDiscovery } from "./team/discovery.mjs";
import { isLocalNetworkDenied, localNetworkVerdict, pollVerdict, nextLocalNetwork, localProbeTargets, probeLan, defaultGateway, LOCAL_NETWORK_SETTINGS_URL, PRIVACY_SETTINGS_URL } from "./team/localnet.mjs";
import { createDelegationStore, createRemoteLog, createEventThrottle, remoteMessage, validateRemoteText, resolveDelegatedSession, screenAllowsInput, remoteInterruptAllowed, canDelegate, autoRevokeReasons, permissionOk, REMOTE_LOG } from "./team/remote.mjs";
import "./core/status.js";   // globalThis.AgentDeskStatus (responseTextFromScreen) for a delegated session's last answer
import "./core/mask.js";
import "./core/outbound.js";   // globalThis.AgentDeskOutbound: Jira comment / Slack reply bodies, masked and checked
import "./core/team.js";       // globalThis.AgentDeskTeam: safetySummary for the team snapshot's safety status
import "./core/timeline.js";   // globalThis.AgentDeskTimeline: the card's [타임라인] tab (details masked here)
import "./core/version.js";    // globalThis.AgentDeskVersion: release version comparison and installer choice for updates
import "./core/dock.js";      // globalThis.AgentDeskDock: dock mode window bounds (bottom-centre bar)
import { defaultTeamConfig, defaultName, lanAddress, nodeRunner, SHARE_ON, SHARE_OFF } from "./team/setup.mjs";
import { randomUUID, createHash } from "node:crypto";
import { openPermEndpoint, ensurePrivateDir, permHookScript as permHookSh, guardHookScript, PERM_TIMEOUT_DEFAULT, PERM_TOKEN, PERM_SOCK } from "./perm/server.mjs";
import { readJsonStrict, writeJsonAtomic, backupPrivate, permHookPresent, installPermHookAt, uninstallPermHookAt, guardHookPresent, installGuardHookAt, uninstallGuardHookAt } from "./perm/settings.mjs";
import { createGuardHandler, createGuardLog, writeGuardConfig, defaultGuardConfig, GUARD_MODES } from "./guard/guard.mjs";
import * as jiraOAuth from "./jira-oauth.mjs";
import { diffStat, diffFile, insideRepo, setGitPath } from "./diff/git.mjs";   // also loads core/diff.js (globalThis.AgentDeskDiff)

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
    const b = dockState ? dockState.panel : mainWindow.getBounds();   // docked: keep the panel's place for the next start
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
      sandbox: true,   // the preload only uses contextBridge / ipcRenderer / webUtils
    },
  });
  // the widget is one local page: no pop-up windows, no navigating away (a dropped file or a stray link included)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  if (!app.isPackaged) import("./scripts/csp-hash.mjs").then(m => { const r = m.checkWidgetCsp(join(__dirname, "widget.html")); if (!r.ok) console.error(`[csp] widget.html inline script hash is stale — the page will not run. Fix: node scripts/csp-hash.mjs --write`); }).catch(() => {});

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

app.on("before-quit", () => { app.isQuitting = true; stopPermServer(); if (slackChild) { try { slackChild.kill(); } catch {} } if (teamServer) { try { teamServer.close(); } catch {} } if (teamDiscovery) { try { teamDiscovery.stop(); } catch {} } });   // no orphan bridge that would post every reply twice
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
  // control characters dropped; masking would break the query, so a JQL that holds a secret pattern is refused instead
  const q = globalThis.AgentDeskOutbound.checkJql(opts.jql);
  if (!q.ok) return badArg(q.error);
  const jql = q.jql;
  const filter = JIRA_FILTERS.has(opts.filter) ? opts.filter : "assigned";
  if (jiraOAuth.connected()) return viaOAuth(() => jql ? jiraOAuth.search(jql, limit) : jiraOAuth.list(filter, limit));
  if (jql) return orcaTimed(30000, "jira", "search", jql, "--limit", String(limit));
  return orcaTimed(30000, "jira", "list", "--filter", filter, "--limit", String(limit));
});
ipcMain.handle("roca:jira-issue", (_e, key) => {
  if (!JIRA_KEY_RE.test(key || "")) return badArg("invalid Jira key");
  return jiraOAuth.connected() ? viaOAuth(() => jiraOAuth.issue(key)) : orcaTimed(30000, "jira", "issue", key);
});
ipcMain.handle("roca:jira-comment", async (_e, key, raw) => {
  if (!JIRA_KEY_RE.test(key || "")) return badArg("invalid Jira key");
  // masked here whatever the renderer sent, before the length cap; both the OAuth and the Orca CLI path get only this
  const m = globalThis.AgentDeskOutbound.prepareJiraComment(raw);
  if (!m.ok) return badArg(m.error);
  const body = m.body, withMasked = r => (r && typeof r === "object" && r.ok !== false && m.masked ? { ...r, masked: m.masked } : r);
  if (jiraOAuth.connected()) return viaOAuth(() => jiraOAuth.comment(key, body)).then(withMasked);
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-jira-"));
  const file = join(dir, "comment.txt");
  try {
    writeFileSync(file, body, { mode: 0o600 });
    return withMasked(await orcaTimed(30000, "jira", "comment", "add", key, "--body-file", file));
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

ipcMain.handle("orca:claude-sessions", (_e, filters) => listClaudeSessions(filters));

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
// joinWrapped (-J): a line the pane wrapped comes back as one line (the remote screen view, so a wrapped secret is masked whole)
async function tmuxCapture(pane, lines = 80, joinWrapped = false) {
  const out = await tmux("capture-pane", "-p", ...(joinWrapped ? ["-J"] : []), "-t", pane, "-S", `-${lines}`);
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

// shared by the IPC handlers below and team remote input (phase 3)
async function terminalInterrupt(handle) {
  if (isTmux(handle)) { try { await tmux("send-keys", "-t", paneOf(handle), "Escape"); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
  if (isTerm(handle)) return withTarget(handle, termInterrupt);
  return orca("terminal", "send", "--terminal", handle, "--interrupt");
}
ipcMain.handle("orca:terminal-interrupt", (_e, handle) => terminalInterrupt(handle));

ipcMain.handle("orca:terminal-send", (_e, handle, text, enter, waitSubmit) => terminalSend(handle, text, enter, waitSubmit));
function terminalSend(handle, text, enter, waitSubmit) {
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
}

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

ipcMain.handle("orca:terminal-read", (_e, handle, screen, cursor, limit) => terminalRead(handle, screen, cursor, limit));
async function terminalRead(handle, screen, cursor, limit, { joinWrapped = false } = {}) {
  if (isTmux(handle)) return tmuxCapture(paneOf(handle), 80, joinWrapped).catch(err => ({ ok: false, error: err.message }));
  if (isTerm(handle)) return withTarget(handle, termRead).catch(err => ({ ok: false, error: err.message }));
  const args = ["terminal", "read", "--terminal", handle];
  if (screen) args.push("--screen");
  if (cursor != null) args.push("--cursor", String(cursor));
  if (limit != null) args.push("--limit", String(limit));
  const res = await orca(...args);
  const tail = res?.result?.terminal?.tail;
  if (process.env.ROCA_DEBUG) console.log(`[terminal-read] screen=${!!screen} tail=${Array.isArray(tail) ? tail.length : 'none'}`);
  return res;
}

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
  if (!mainWindow || dockState) return;   // dock mode places the window itself (orca:dock)
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

// ── dock mode: the widget as a thin bar on the bottom edge of the work area (core/dock.js dockBounds) ──
// { on: true, contentWidth, height, extra, pop: { x, width }, remembered: { cx, y } } → bounds; the first call keeps the
//   panel's bounds. extra = room for the hover card / review queue (above the bar, or below it when the bar sits high:
//   bounds.dir); pop = the part of that room the card / queue covers: on Windows / Linux the window is cut to the bar
//   plus that band (setShape), so the rest is neither drawn (no black box: the window is not transparent there)
//   nor clickable.
// { hit: bool } → while docked, whether the pointer is over something clickable; elsewhere clicks pass through to the
//   windows behind (macOS / Windows: setIgnoreMouseEvents with forward, so the page still sees the pointer come back).
// { on: false } → the panel's bounds, size limits, resizability, vibrancy and mouse handling back (always, try/finally).
// A user drag of the bar is reported to the page (roca:dock-moved { cx, y }); moves made here are not. When a display
// is added / removed / rearranged, the last request is placed again (roca:dock-moved { dir, reflow: true }).
let dockState = null;   // { panel: bounds before docking, req: last request, last: last dockBounds result, setAt, moveT }
const dockHooked = new WeakSet();
let dockScreenHooked = false;
const dockNum = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : 0);
// the bar's own rectangle inside the current window (the room for the card / queue is above or below it)
function dockStripRect(cur, last) {
  return { x: cur.x, y: last.dir === "down" ? cur.y : cur.y + cur.height - last.stripHeight, width: cur.width, height: last.stripHeight };
}
function dockOnMove() {
  if (!dockState || !dockState.last || Date.now() - dockState.setAt < 400) return;
  clearTimeout(dockState.moveT);
  dockState.moveT = setTimeout(() => {
    if (!dockState || !dockState.last || !mainWindow || mainWindow.isDestroyed() || Date.now() - dockState.setAt < 400) return;
    const s = dockStripRect(mainWindow.getBounds(), dockState.last);
    mainWindow.webContents.send("roca:dock-moved", { cx: Math.round(s.x + s.width / 2), y: s.y });
  }, 300);
}
// Windows / Linux: draw (and hit-test) only the bar plus the card / queue band; [] = the whole window again
function dockShape(b, pop) {
  if (IS_MAC || typeof mainWindow.setShape !== "function") return;
  let rects = [];
  if (b && b.extra > 0 && pop && typeof pop === "object") {
    const x = Math.round(dockNum(pop.x, 0, b.width)), w = Math.round(dockNum(pop.width, 0, b.width - x));
    const bar = { x: 0, y: b.dir === "down" ? 0 : b.extra, width: b.width, height: b.stripHeight };
    rects = w > 0 ? [bar, { x, y: b.dir === "down" ? b.stripHeight : 0, width: w, height: b.extra }] : [bar];
  }
  try { mainWindow.setShape(rects); } catch {}
}
function dockApply(r) {
  const cur = mainWindow.getBounds(), last = dockState.last;
  // the display the bar is on now (the panel's display on the first call)
  const wa = screen.getDisplayMatching(last ? dockStripRect(cur, last) : cur).workArea;
  const rem = r.remembered && typeof r.remembered === "object" ? { cx: Number(r.remembered.cx), y: Number(r.remembered.y) } : null;
  const b = globalThis.AgentDeskDock.dockBounds({
    workArea: wa, contentWidth: dockNum(r.contentWidth, 0, 20000), height: dockNum(r.height, 0, 200), extra: dockNum(r.extra, 0, 2000), remembered: rem,
  });
  if (!b) return null;
  dockState.last = b; dockState.setAt = Date.now();
  // maxWidth 480 is the panel's limit; the bar may be as wide as the work area
  mainWindow.setMinimumSize(Math.min(280, b.width), Math.min(44, b.height));
  mainWindow.setMaximumSize(Math.max(480, wa.width), Math.max(b.height, wa.height));
  mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  dockShape(b, r.pop);
  return b;
}
function dockReflow() {
  if (!dockState || !dockState.req || !mainWindow || mainWindow.isDestroyed()) return;
  dockState.last = null;   // the old display may be gone: start from where the window is now
  const b = dockApply(dockState.req);
  if (b) mainWindow.webContents.send("roca:dock-moved", { dir: b.dir, reflow: true });
}
ipcMain.handle("orca:dock", (_e, req) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const r = req && typeof req === "object" ? req : {};
  if (typeof r.hit === "boolean") {
    if (dockState && !IS_LINUX) mainWindow.setIgnoreMouseEvents(!r.hit, { forward: true });
    return null;
  }
  if (resizeAnim) { clearInterval(resizeAnim); resizeAnim = null; }
  if (!r.on) {
    if (!dockState) return null;
    const p = dockState.panel;
    clearTimeout(dockState.moveT);
    dockState = null;
    const wa = screen.getDisplayMatching(p).workArea;
    const w = Math.min(p.width, wa.width), h = Math.min(p.height, wa.height);
    const x = Math.min(Math.max(p.x, wa.x), wa.x + wa.width - w), y = Math.min(Math.max(p.y, wa.y), wa.y + wa.height - h);
    try {
      mainWindow.setIgnoreMouseEvents(false);
      dockShape(null);
      if (IS_MAC) mainWindow.setVibrancy("under-window");
    } finally {
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(Math.min(280, w), Math.min(44, h));
      mainWindow.setMaximumSize(Math.max(480, w), Math.max(h, wa.height));
      mainWindow.setBounds({ x, y, width: w, height: h });
    }
    return { x, y, width: w, height: h };
  }
  if (!dockState) {
    dockState = { panel: mainWindow.getBounds(), req: null, last: null, setAt: 0, moveT: null };
    mainWindow.setResizable(false);
    if (IS_MAC) mainWindow.setVibrancy(null);   // the room above the bar stays see-through (the bar draws its own background)
    if (!dockHooked.has(mainWindow)) { dockHooked.add(mainWindow); mainWindow.on("move", dockOnMove); }
    if (!dockScreenHooked) { dockScreenHooked = true; for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, dockReflow); }
  }
  dockState.req = r;
  if (!(dockNum(r.extra, 0, 2000) > 0)) mainWindow.setIgnoreMouseEvents(false);   // no room around the bar: all of it is clickable
  return dockApply(r);
});

ipcMain.handle("orca:notify", (_e, title, body) => {
  try { new Notification({ title: String(title || ""), body: String(body || "") }).show(); return true; } catch { return false; }
});

// ── Clipboard (copy only: session id, team board, Jira key/link) ──
ipcMain.handle("orca:clipboard-write", (_e, text) => { clipboard.writeText(text); return true; });

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
// extended events (Claude Code 2.1.x docs); an older Claude Code may ignore or warn about unknown keys
const HOOK_EVENTS_EXT = ["StopFailure", "PermissionDenied", "TaskCreated", "TaskCompleted", "PreCompact", "CwdChanged"];
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
umask 077   # the log holds prompts' tool inputs: only this user may read it
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
  claude: { label: "Claude Code", dir: join(homedir(), ".claude"), settings: CLAUDE_SETTINGS, events: [...HOOK_EVENTS, ...HOOK_EVENTS_EXT],
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
  const s = readJsonStrict(cfg.settings);   // a broken settings file throws: it is never replaced by {}
  backupPrivate(cfg.settings, ROCA_DIR, `${a}-settings.backup-${Date.now()}.json`);
  if (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)) s.hooks = {};
  for (const ev of cfg.events) {
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev].filter(e => !isOurHook(e)) : [];
    arr.push(cfg.entry());
    s.hooks[ev] = arr;
  }
  writeJsonAtomic(cfg.settings, s);
}
function uninstallAgentHooks(a) {
  const cfg = AGENT_HOOKS[a]; if (!existsSync(cfg.settings)) return;
  const s = readJsonStrict(cfg.settings);
  if (!s.hooks) return;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev].filter(e => !isOurHook(e));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeJsonAtomic(cfg.settings, s);
}
function installHooks(agents) {
  ensurePrivateDir(ROCA_DIR);
  writeFileSync(HOOK_SCRIPT, HOOK_SH);
  if (!IS_WIN) chmodSync(HOOK_SCRIPT, 0o755);
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, "", { mode: 0o600 });
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
// session timeline: the newest 2,000 entries per session, fed from the same incremental reads (never a full re-read per request)
const timelineIndex = AgentDeskTimeline.createIndex({ max: AgentDeskTimeline.MAX_EVENTS, sessions: 100 });
function readNewEvents() {
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    const size = statSync(EVENTS_FILE).size;
    if (size < eventsOffset) { eventsOffset = 0; timelineIndex.clear(); }   // truncated/rotated: re-read from the start
    if (size === eventsOffset) return [];
    const fd = openSync(EVENTS_FILE, "r");
    const buf = Buffer.alloc(size - eventsOffset);
    readSync(fd, buf, 0, buf.length, eventsOffset);
    closeSync(fd);
    eventsOffset = size;
    const out = [];
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line.replace(/^\uFEFF/, "")); noteKnownSession(o); timelineIndex.add(o); out.push(o); } catch {}   // PowerShell may write a BOM
    }
    return out;
  } catch { return []; }
}
function pushEvents(evts) {
  if (permServer) for (const rec of evts) if (!rec.agent || rec.agent === "claude") permServer.staleFromEvent(rec.ev);
  if (evts.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:hook-events", evts);
}
function startEventsWatch() {
  if (eventsWatcher || eventsPollTimer) return;
  if (!existsSync(EVENTS_FILE)) return;
  try { eventsWatcher = fsWatch(EVENTS_FILE, () => pushEvents(readNewEvents())); } catch {}
  eventsPollTimer = setInterval(() => pushEvents(readNewEvents()), 1500);   // fs.watch can miss appends on macOS
}

// ── Permission requests answered from the widget (Claude Code only, opt-in) ──
// A second, synchronous PermissionRequest hook (~/.roca/perm-hook.sh) posts the hook input to perm/server.mjs over the
// Unix socket ~/.roca/perm/perm.sock and prints the decision only when it is signed with this run's token
// (~/.roca/perm/perm-token, 0600 in a 0700 directory, removed on quit). Without the socket or token, when nobody
// answers in time, or when anything fails, the hook prints nothing and Claude Code keeps its terminal prompt.
// Nothing is ever allowed without a button press, and no permission rule is ever saved.
const PERM_HOOK_SCRIPT = join(ROCA_DIR, "perm-hook.sh");
const PERM_DIR = join(ROCA_DIR, "perm");
const PERM_CFG_FILE = join(ROCA_DIR, "perm.json");
const PERM_TIMEOUTS = [60, 90, 180, 300];
const permTimeout = () => { const n = Number(readJsonFile(PERM_CFG_FILE).timeoutSec); return PERM_TIMEOUTS.includes(n) ? n : PERM_TIMEOUT_DEFAULT; };
function permHookInstalled() { return permHookPresent(CLAUDE_SETTINGS) && existsSync(PERM_HOOK_SCRIPT); }
// session ids seen in hook events (Claude Code only): the server answers only requests from these sessions
const knownSessions = new Set();
// every directory a hook session reported (any agent): the diff view only reads a hook session's cwd when it is here
const hookCwds = new Map();   // session_id → Set(cwd)
function noteKnownSession(rec) {
  const sid = rec && rec.ev && rec.ev.session_id;
  if (typeof sid === "string" && sid) for (const c of [rec.ev.cwd, rec.ev.new_cwd]) {
    if (typeof c !== "string" || !c) continue;
    if (hookCwds.size > 5000) hookCwds.clear();
    if (!hookCwds.has(sid)) hookCwds.set(sid, new Set());
    hookCwds.get(sid).add(c);
  }
  if (typeof sid !== "string" || !sid || (rec.agent && rec.agent !== "claude")) return;
  if (knownSessions.size > 5000) knownSessions.clear();
  knownSessions.add(sid);
}
function seedKnownSessions() {
  try {
    if (!existsSync(EVENTS_FILE)) return;
    for (const l of readFileSync(EVENTS_FILE, "utf-8").split("\n")) { if (l) { try { noteKnownSession(JSON.parse(l.replace(/^\uFEFF/, ""))); } catch {} } }
  } catch {}
}
let permServer = null, permStarting = null;
const toRenderer = (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); };
// the socket server is shared with the guardrail (POST /v1/guard): it runs while either hook is installed
function startPermServer() {
  if (permServer || permStarting || IS_WIN) return permStarting;
  seedKnownSessions();
  permStarting = openPermEndpoint({
    dir: PERM_DIR, timeoutSec: permTimeout(),
    // the async logging hook may not have flushed this session's first events yet: read the log once more
    isKnownSession: (sid) => { if (!knownSessions.has(sid)) pushEvents(readNewEvents()); return knownSessions.has(sid); },
    onRequest: (entry) => toRenderer("roca:perm-request", entry),
    onResolved: (id, why) => toRenderer("roca:perm-resolved", { id, why }),
    onGuard: (body, meta) => guardHandler.handle(body, meta),
    onGuardFail: () => guardHandler.failOutput(),
  }).then(srv => { permServer = srv; console.log("[perm] decision server on", srv.socketPath); },
          e => { console.log("[perm] server failed", e.message); })
    .finally(() => { permStarting = null; });
  return permStarting;
}
function stopPermServer() {
  if (permServer) { const s = permServer; permServer = null; s.close().catch(() => {}); }
  else { for (const f of [join(PERM_DIR, PERM_TOKEN), join(PERM_DIR, PERM_SOCK)]) { try { unlinkSync(f); } catch {} } }
}
function installPermHook() {
  if (IS_WIN) return { ok: false, error: "macOS / Linux only" };
  if (!agentPresent("claude")) return { ok: false, error: "Claude Code (~/.claude) not found" };
  const t = permTimeout();
  readJsonStrict(CLAUDE_SETTINGS);   // a broken settings.json stops here, before anything is written
  ensurePrivateDir(ROCA_DIR);
  writeFileSync(PERM_HOOK_SCRIPT, permHookSh(t), { mode: 0o700 }); chmodSync(PERM_HOOK_SCRIPT, 0o700);
  installPermHookAt({ settingsFile: CLAUDE_SETTINGS, command: PERM_HOOK_SCRIPT, timeoutSec: t, backupDir: ROCA_DIR });
  startPermServer();
  return { ok: true, timeoutSec: t };
}
function uninstallPermHook() {
  uninstallPermHookAt({ settingsFile: CLAUDE_SETTINGS });   // throws on a broken settings.json: nothing is touched
  try { unlinkSync(PERM_HOOK_SCRIPT); } catch {}
  if (!guardHookInstalled()) stopPermServer();
  return { ok: true };
}
ipcMain.handle("roca:perm-install", () => { try { return installPermHook(); } catch (e) { return { ok: false, error: e.message }; } finally { safetyHooksCache.at = 0; } });
ipcMain.handle("roca:perm-uninstall", () => { try { return uninstallPermHook(); } catch (e) { return { ok: false, error: e.message }; } finally { safetyHooksCache.at = 0; } });
ipcMain.handle("roca:perm-list", () => (permServer ? permServer.list() : []));
ipcMain.handle("roca:perm-decide", (_e, id, behavior, message) => {
  if (!permServer || typeof id !== "string" || !["allow", "deny", "pass"].includes(behavior)) return { ok: false };
  return { ok: permServer.decide(id, behavior, typeof message === "string" ? message : "") };
});
ipcMain.handle("roca:perm-config", (_e, timeoutSec) => {
  const n = Number(timeoutSec);
  if (!PERM_TIMEOUTS.includes(n)) return { ok: false, error: "bad timeout" };
  try {
    mkdirSync(ROCA_DIR, { recursive: true }); writeFileSync(PERM_CFG_FILE, JSON.stringify({ timeoutSec: n }) + "\n");
    if (permServer) permServer.setTimeoutSec(n);
    if (permHookInstalled()) installPermHook();   // the hook's own timeout and curl -m follow the setting
    return { ok: true, timeoutSec: n };
  } catch (e) { return { ok: false, error: e.message }; }
});
// ── Dangerous-command guardrail (Claude Code PreToolUse, opt-in, independent of the approval toggle above) ──
// ~/.roca/guard-hook.sh posts each Bash / Edit / Write / MultiEdit / NotebookEdit call to POST /v1/guard on the same
// socket and token; guard/guard.mjs matches it against ~/.roca/guard.json and answers {} / ask / deny at once.
// Widget not running, no token, any error → the hook prints nothing and the call goes on as usual (fail-open).
const GUARD_HOOK_SCRIPT = join(ROCA_DIR, "guard-hook.sh");
const GUARD_FILE = join(ROCA_DIR, "guard.json");
const guardLog = createGuardLog(join(ROCA_DIR, "guard-log.jsonl"));
const guardHandler = createGuardHandler({
  file: GUARD_FILE, log: guardLog,
  onHit: (entry) => toRenderer("roca:guard-hit", entry),
  onRuleDisabled: (info) => toRenderer("roca:guard-rule-disabled", info),
  onRuleSlow: (info) => toRenderer("roca:guard-rule-slow", info),
});
function guardHookInstalled() { return guardHookPresent(CLAUDE_SETTINGS) && existsSync(GUARD_HOOK_SCRIPT); }
function installGuardHook() {
  if (IS_WIN) return { ok: false, error: "macOS / Linux only" };
  if (!agentPresent("claude")) return { ok: false, error: "Claude Code (~/.claude) not found" };
  readJsonStrict(CLAUDE_SETTINGS);   // a broken settings.json stops here, before anything is written
  ensurePrivateDir(ROCA_DIR);
  guardHandler.config();             // creates ~/.roca/guard.json (0600) with the default rules when missing
  writeFileSync(GUARD_HOOK_SCRIPT, guardHookScript(), { mode: 0o700 }); chmodSync(GUARD_HOOK_SCRIPT, 0o700);
  installGuardHookAt({ settingsFile: CLAUDE_SETTINGS, command: GUARD_HOOK_SCRIPT, backupDir: ROCA_DIR });
  startPermServer();
  return { ok: true };
}
function uninstallGuardHook() {
  uninstallGuardHookAt({ settingsFile: CLAUDE_SETTINGS });   // throws on a broken settings.json: nothing is touched
  try { unlinkSync(GUARD_HOOK_SCRIPT); } catch {}
  if (!permHookInstalled()) stopPermServer();
  return { ok: true };
}
// team safety status (served to teammates in /v1/sessions, shown as teamStatus.safety): hook on/off, a hash of the
// enabled rules and today's block count — no rule body. The log and the hooks' presence in settings.json are read from
// disk at most once a minute; the hook install / uninstall handlers reset the hook cache (safetyHooksCache.at = 0).
let guardLogCache = { at: 0, entries: [] };
let safetyHooksCache = { at: 0, guard: false, perm: false };
function teamSafety() {
  const t = Date.now();
  if (t - guardLogCache.at > 60000) guardLogCache = { at: t, entries: guardLog.read(2000) };
  if (t - safetyHooksCache.at > 60000) safetyHooksCache = { at: t, guard: guardHookInstalled(), perm: permHookInstalled() };
  let guardCfg = null; try { guardCfg = guardHandler.config(); } catch {}
  return globalThis.AgentDeskTeam.safetySummary({ guardCfg, guardHookInstalled: safetyHooksCache.guard, permHookInstalled: safetyHooksCache.perm, guardLogEntries: guardLogCache.entries, now: t });
}
const guardView = () => ({ ...guardHandler.config(), file: GUARD_FILE, hook: guardHookInstalled(), available: !IS_WIN, defaults: defaultGuardConfig().rules });
ipcMain.handle("roca:guard-install", () => { try { return installGuardHook(); } catch (e) { return { ok: false, error: e.message }; } finally { safetyHooksCache.at = 0; } });
ipcMain.handle("roca:guard-uninstall", () => { try { return uninstallGuardHook(); } catch (e) { return { ok: false, error: e.message }; } finally { safetyHooksCache.at = 0; } });
ipcMain.handle("roca:guard-config", () => guardView());
// { mode?, rules?, allowRepos? } merged over the current file; invalid rules are kept in the file and reported
ipcMain.handle("roca:guard-save", (_e, patch) => {
  const p = patch && typeof patch === "object" ? patch : {};
  try {
    const cur = guardHandler.config();
    if (p.mode != null && !GUARD_MODES.includes(p.mode)) return { ok: false, error: "bad mode" };
    if (p.rules != null && !Array.isArray(p.rules)) return { ok: false, error: "bad rules" };
    ensurePrivateDir(ROCA_DIR);
    writeGuardConfig(GUARD_FILE, { mode: p.mode ?? cur.mode, rules: p.rules ?? cur.rules, allowRepos: Array.isArray(p.allowRepos) ? p.allowRepos : cur.allowRepos });
    guardHandler.reload();
    return { ok: true, ...guardView() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:guard-test", (_e, tool, text, mode) => {
  const tl = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) ? tool : "Bash";
  const s = String(text == null ? "" : text).slice(0, 20000);
  try { return { ok: true, ...guardHandler.test(tl, tl === "Bash" ? { command: s } : tl === "NotebookEdit" ? { notebook_path: s } : { file_path: s }, mode) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:guard-log", (_e, n) => guardLog.read(Math.min(Number(n) || 500, 2000)));
// new-version check against GitHub Releases, at most once a day (cached in userData); the renderer shows a badge
const UPDATE_API = "https://api.github.com/repos/choiminu/AgentDesk/releases/latest";
const UPDATE_CACHE = join(app.getPath("userData"), "update-check.json");
const UPDATE_MAX_BYTES = 200 * 1024 * 1024, UPDATE_DL_TIMEOUT = 8 * 60 * 1000, UPDATE_DL_MAX = 10;
const { isNewer, pickAsset, isAllowedDownloadUrl, isAllowedRedirectUrl, safeAssetFileName, releaseInfo, downloadPlan } = globalThis.AgentDeskVersion;
const fetchLatestRelease = async () => {
  const res = await fetch(UPDATE_API, { headers: { "User-Agent": `AgentDesk/${app.getVersion()}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const saveUpdateCache = info => { try { writeFileSync(UPDATE_CACHE, JSON.stringify(info)); } catch {} };
// the renderer learns whether this machine has an installer in the release (assetName) without ever seeing a URL
const updateView = (info, current) => ({ ...info, current, newer: isNewer(info.latest, current), assetName: Array.isArray(info.assets) ? (pickAsset(info.assets, process.platform, process.arch) || {}).name || null : undefined });
ipcMain.handle("roca:update-check", async (_e, force) => {
  const current = app.getVersion();
  let cache = null; try { cache = JSON.parse(readFileSync(UPDATE_CACHE, "utf-8")); } catch {}
  if (!force && cache && Date.now() - cache.at < 24 * 3600 * 1000) return updateView(cache, current);
  try {
    const info = releaseInfo(await fetchLatestRelease(), Date.now());
    saveUpdateCache(info);
    return updateView(info, current);
  } catch (e) { return { at: Date.now(), current, latest: cache?.latest || null, url: cache?.url || null, newer: cache ? isNewer(cache.latest, current) : false, error: e.message }; }
});
// [받기]: download this machine's installer from the latest release into ~/Downloads, verify its sha256 against the
// release's digest, mark it as downloaded from the internet, and open it only after the user confirms in a dialog.
// The URL comes from the release JSON here, never from the renderer; every redirect hop must stay on GitHub's hosts.
let updateDownloading = false, updateDownloadCount = 0;
async function sha256OfFile(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
// the OS treats the file like a browser download: Gatekeeper (quarantine xattr) / SmartScreen (Mark of the Web)
async function markDownloaded(path) {
  try {
    if (process.platform === "darwin") await exec("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0083;${Math.floor(Date.now() / 1000).toString(16)};AgentDesk;`, path], { timeout: 5000 });
    else if (process.platform === "win32") writeFileSync(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://github.com/\r\n");
  } catch {}
}
async function downloadUpdateAsset(asset, sha256, onProgress) {
  let url = String(asset.browser_download_url || "");
  if (!isAllowedDownloadUrl(url)) throw new Error("download URL is not a GitHub release URL");
  if (Number(asset.size) > UPDATE_MAX_BYTES) throw new Error("installer is larger than 200MB");
  const dir = app.getPath("downloads"), name = safeAssetFileName(asset.name);
  // the same installer is already in ~/Downloads (a regular file, not a link) with the release's digest → reuse it
  const existing = join(dir, name);
  if (sha256) { try { if (lstatSync(existing).isFile() && await sha256OfFile(existing) === sha256) return { path: existing, verified: true, reused: true }; } catch {} }
  if (updateDownloadCount >= UPDATE_DL_MAX) throw new Error(`download limit reached (${UPDATE_DL_MAX} per session)`);
  updateDownloadCount++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout (8 min)")), UPDATE_DL_TIMEOUT);
  let fd = null, tmp = null;
  try {
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "User-Agent": `AgentDesk/${app.getVersion()}`, Accept: "application/octet-stream" } });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location"); try { await res.body?.cancel(); } catch {}
      if (!next || hop >= 5) throw new Error("too many redirects");
      url = new URL(next, url).href;
      if (!isAllowedRedirectUrl(url)) throw new Error(`redirect to an unexpected host: ${new URL(url).host}`);
    }
    if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || Number(asset.size) || 0;
    if (total > UPDATE_MAX_BYTES) throw new Error("installer is larger than 200MB");
    tmp = join(dir, `.${name}.${randomUUID().slice(0, 8)}.part`);
    fd = openSync(tmp, "wx", 0o644);   // wx: fails if the path exists (never follows a planted symlink)
    const hash = createHash("sha256");
    let received = 0, lastPct = -1;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > UPDATE_MAX_BYTES) throw new Error("installer is larger than 200MB");
      const written = writeSync(fd, value);
      if (written !== value.length) throw new Error(`partial write (${written}/${value.length} bytes)`);
      hash.update(value);
      const pct = total ? Math.min(99, Math.floor(received * 100 / total)) : -1;
      if (pct !== lastPct) { lastPct = pct; onProgress({ pct, received, total }); }
    }
    closeSync(fd); fd = null;
    if (total && received !== total) throw new Error(`incomplete download (${received}/${total} bytes)`);
    if (sha256 && hash.digest("hex") !== sha256) throw new Error("sha256 mismatch with the release digest");
    const ext = extname(name), stem = name.slice(0, name.length - ext.length);
    let dest = existing;
    for (let n = 2; existsSync(dest); n++) dest = join(dir, `${stem}-${n}${ext}`);
    renameSync(tmp, dest); tmp = null;
    if (/\.appimage$/i.test(dest)) { try { chmodSync(dest, 0o755); } catch {} }
    onProgress({ pct: 100, received, total });
    return { path: dest, verified: !!sha256 };
  } catch (e) {
    ac.abort(e);   // closes the socket on a write failure (ENOSPC), a digest mismatch or the timeout
    throw ac.signal.reason instanceof Error && ac.signal.reason.message.startsWith("timeout") ? ac.signal.reason : e;
  } finally {
    clearTimeout(timer);
    if (fd !== null) { try { closeSync(fd); } catch {} }
    if (tmp) { try { unlinkSync(tmp); } catch {} }
  }
}
ipcMain.handle("roca:update-download", async () => {
  if (updateDownloading) return { ok: false, error: "busy" };
  updateDownloading = true;
  let releaseUrl = globalThis.AgentDeskVersion.RELEASES_PAGE;
  try {
    const j = await fetchLatestRelease();
    const info = releaseInfo(j, Date.now()); releaseUrl = info.url;
    saveUpdateCache(info);
    const plan = downloadPlan(j, app.getVersion(), process.platform, process.arch);
    if (plan.upToDate) return { ok: false, upToDate: true, latest: plan.latest };
    if (plan.noAsset) { await shell.openExternal(releaseUrl); return { ok: false, noAsset: true, url: releaseUrl }; }
    const { path, verified, reused } = await downloadUpdateAsset(plan.asset, plan.sha256, p => toRenderer("roca:update-progress", p));
    await markDownloaded(path);
    let size = 0; try { size = statSync(path).size; } catch {}
    const opts = { type: "question", buttons: ["열기", "폴더에서 보기", "취소"], defaultId: 1, cancelId: 2, noLink: true,
      message: `AgentDesk ${plan.latest} 설치 파일을 내려받았습니다`,
      detail: `${basename(path)} (${(size / 1048576).toFixed(1)} MB)${verified ? "\nSHA-256 확인됨" : "\n릴리스에 SHA-256 값이 없어 무결성을 확인하지 못했습니다"}` };
    const { response } = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
    let action = "cancel", openError;
    if (response === 0) { action = "open"; openError = await shell.openPath(path) || undefined; }
    else if (response === 1) { action = "reveal"; shell.showItemInFolder(path); }
    return { ok: true, path, action, verified, reused: !!reused, ...(openError ? { openError } : {}) };
  } catch (e) {
    toRenderer("roca:update-progress", { pct: -1, error: true });
    return { ok: false, error: e.message, url: releaseUrl };
  } finally { updateDownloading = false; }
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
  const node = nodeRunner(process.execPath).cmd;   // no Node.js on this PC → the app binary in Node mode (ELECTRON_RUN_AS_NODE below)
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
  const node = nodeRunner(process.execPath).cmd;   // no Node.js on this PC → the app binary in Node mode (ELECTRON_RUN_AS_NODE below)
  const child = spawn(node, [join(dirname(RECALL_CLI), "slack-bridge.mjs")], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: EXEC_PATH, ELECTRON_RUN_AS_NODE: "1" } });
  slackChild = child; slackStatus.running = true; slackStatus.lastError = "";
  let err = ""; child.stderr.on("data", d => { err = (err + d.toString()).slice(-400); });
  child.on("exit", (code) => { slackChild = null; slackStatus.running = false; if (code) slackStatus.lastError = err.trim().split("\n").pop() || `exit ${code}`; slackRestartAt = Date.now() + 60000; });
}
setInterval(startSlackBridge, 30000); setTimeout(startSlackBridge, 8000);
const inboxSeen = new Set();
// task id → { channel, thread } as the bridge wrote it: a reply goes to that thread only, never to one the renderer names
const inboxRoutes = new Map(), INBOX_ROUTES_MAX = 500;
function pumpInbox() {
  try {
    mkdirSync(INBOX_REPLIES, { recursive: true });
    for (const f of readdirSync(INBOX_DIR).filter(f => f.endsWith(".json"))) {
      const p = join(INBOX_DIR, f); if (inboxSeen.has(p)) continue; inboxSeen.add(p);
      let task; try { task = JSON.parse(readFileSync(p, "utf-8")); } catch { continue; }
      const route = globalThis.AgentDeskOutbound.routeFromTask(task);
      if (route && typeof task.id === "string") {
        inboxRoutes.set(task.id, route);
        while (inboxRoutes.size > INBOX_ROUTES_MAX) inboxRoutes.delete(inboxRoutes.keys().next().value);
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:inbox-task", task);
      try { unlinkSync(p); } catch {}
    }
  } catch {}
}
setInterval(pumpInbox, 3000);
// Slack thread reply (core/outbound.js prepareInboxReply): known fields only, channel / thread from the task the bridge
// handed over (the renderer's are ignored; an unknown task id is refused), every text field masked before it is cut
ipcMain.handle("roca:inbox-reply", (_e, reply) => {
  const id = reply && typeof reply === "object" ? reply.id : undefined;
  const p = globalThis.AgentDeskOutbound.prepareInboxReply(reply, typeof id === "string" ? inboxRoutes.get(id) : undefined);
  if (!p.ok) return { ok: false, error: p.error };
  try { mkdirSync(INBOX_REPLIES, { recursive: true }); writeFileSync(join(INBOX_REPLIES, `${p.reply.id}-${Date.now()}.json`), JSON.stringify(p.reply)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:inbox-status", () => ({ ...slackStatus, configured: existsSync(SLACK_CFG) }));
ipcMain.handle("roca:inbox-restart", () => { if (slackChild) { try { slackChild.kill(); } catch {} } slackRestartAt = 0; setTimeout(startSlackBridge, 500); return { ok: true }; });
// session notes written by recall/ (MongoDB) for a checkout: spawn the CLI, which knows the worktree/repo rules; [] when unavailable
const RECALL_CLI = [join(__dirname, "recall", "cli.mjs"), join(homedir(), "project", "agentdesk-internal", "recall", "cli.mjs"), join(homedir(), "orca-widget", "recall", "cli.mjs")].find(p => existsSync(p)) || null;
// ── team sharing: publish my sessions on the office network, poll teammates', find them by UDP beacon, take notes — see team/*.mjs ──
let teamCfg = null, teamServer = null, teamServerKey = "", teamStatus = { configured: false, listening: false, error: "", name: "", port: 0, instanceId: "", peers: {}, discovered: [], discovery: false, shared: false, pending: [], localNetwork: "unknown" };
let teamSnapshot = { at: 0, sessions: [] };
let teamDiscovery = null, teamDiscoveryKey = "";
// first run: write a team.json of our own (name = login name, no token, no peers, 127.0.0.1 only, no beacon) so the
// invite flow works without hand-editing. Nothing is visible on the network until the user creates or joins a team.
// Only once per install — deleting team.json later turns team sharing off and keeps it off.
const TEAM_AUTOCREATED = join(app.getPath("userData"), "team-autocreated");
const teamWriteDefault = () => writeTeamJson(TEAM_CFG, defaultTeamConfig({ name: defaultName(), instanceId: randomUUID() }));
function teamFirstRun() {
  if (existsSync(TEAM_AUTOCREATED)) return;
  try {
    if (!existsSync(TEAM_CFG)) teamWriteDefault();
    writeFileSync(TEAM_AUTOCREATED, String(Date.now()));
  } catch {}
}
const teamFound = new Map();      // instanceId → { name, host, id, at } heard through the beacon
const teamPeerState = new Map();  // peer name → { etag, theirAt, fails, nextAt, ... } (connection quality + backoff)
// signed hellos wait here until the user says [추가] / [무시]: a new teammate, or a known one at a new address
const teamPendingHellos = new Map();   // `${host}|${instanceId}` → { key, name, host, instanceId, kind: 'new'|'move', existing, from, at }
const teamHelloIgnored = new Set();    // keys the user ignored this run (not asked again until restart)
const TEAM_NOTES = join(homedir(), ".agentdesk", "team-notes.jsonl");
let teamNotes = [];               // newest last, at most 100: { id, at, to, toName, from, text, state: 'new'|'sent'|'ignored' }
try { teamNotes = readFileSync(TEAM_NOTES, "utf-8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(n => n && n.id).slice(-100); } catch {}
// ~/.agentdesk is private to this user (0700) and the notes file 0600, also when it already existed
function teamPrivateDir() { const d = dirname(TEAM_NOTES); mkdirSync(d, { recursive: true, mode: 0o700 }); try { chmodSync(d, 0o700); } catch {} }
function teamNotesWrite(data, append) { teamPrivateDir(); writeFileSync(TEAM_NOTES, data, { mode: 0o600, ...(append ? { flag: "a" } : {}) }); try { chmodSync(TEAM_NOTES, 0o600); } catch {} }
function teamNotesSave() { try { teamNotesWrite(teamNotes.map(n => JSON.stringify(n)).join("\n") + (teamNotes.length ? "\n" : "")); } catch {} }
function teamOnNote(note) {
  const n = { ...note, state: "new" };
  teamNotes.push(n);
  if (teamNotes.length > 100) { teamNotes = teamNotes.slice(-100); teamNotesSave(); }
  else { try { teamNotesWrite(JSON.stringify(n) + "\n", true); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:team-note", n);
}
ipcMain.on("roca:team-publish", (_e, sessions) => {
  teamSnapshot = { at: Date.now(), sessions: Array.isArray(sessions) ? sessions : [] };
  teamAutoRevoke();   // a delegated session that ended (or left the list) is no longer delegated
});
// ── phase 3: per-session delegation (team/remote.mjs). In memory only: a restart, the session ending, the teammate
//    leaving my list, a new team token or "stop sharing" ends it. Every create / revoke / input / interrupt / block is
//    logged to ~/.agentdesk/team-remote.jsonl and shown to me right away. ──
const teamDelegations = createDelegationStore();
const teamRemoteLog = createRemoteLog();
const teamGrants = new Map();   // peer name → [{ sessionId, grant, name, repo, branch }] delegated TO me (never sent to the page)
let teamDelegToken = null;
function teamRemoteEvent(entry) {
  const e = teamRemoteLog.append(entry);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:team-remote", e);
  return e;
}
function teamRevoke(list, reason) { for (const d of list || []) teamRemoteEvent({ kind: "revoke", sessionId: d.sessionId, sessionName: d.name, peer: d.peerName, instanceId: d.instanceId, reason: d.reason || reason }); }
// session gone, teammate removed / sharing an address / answering as another instance / unreachable 3× and 120 s
function teamAutoRevoke() {
  if (!teamDelegations.size) return;
  const ended = autoRevokeReasons(teamDelegations.list(), { sessions: teamSnapshot.sessions || [], peers: teamCfg ? teamCfg.peers : [], stateOf: name => teamPeerState.get(name) || null, localNetworkDenied: teamStatus.localNetwork === "denied" });
  if (!ended.length) return;
  const keys = new Set(ended.map(d => `${d.sessionId}|${d.instanceId}`));
  teamDelegations.removeWhere(d => keys.has(`${d.sessionId}|${d.instanceId}`));
  teamRevoke(ended);
}
const teamEventThrottle = createEventThrottle();
let teamBlockNotifyAt = 0;
const teamRemoteHandlers = {
  // the guardrail's rule file (built-ins always, plus the user's rules) instead of the fixed table
  guard: (text) => guardHandler.remote(text),
  async input({ delegation, text }) {
    // the latest snapshot, by full local id: exactly one session, else refuse
    const session = resolveDelegatedSession(teamSnapshot.sessions, delegation.localId);
    const h = session && typeof session.handle === "string" ? session.handle : "";
    if (!h || !permissionOk(session)) return { ok: false, busy: true };
    // the published status can be a moment old: look at the screen once more, so the Enter never lands on a
    // permission / choice prompt (it would pick the highlighted option), in a running turn or on the owner's draft.
    // A screen that cannot be read counts as "not ready" (fail closed).
    let tail = null;
    try { const res = await terminalRead(h, true); tail = res && res.result && res.result.terminal && res.result.terminal.tail; } catch { tail = null; }
    if (!screenAllowsInput(tail)) return { ok: false, busy: true };
    const r = await terminalSend(h, remoteMessage(delegation.peerName, text), true, 15);
    return r && r.ok !== false ? { ok: true, accepted: !!(r.result && r.result.send && r.result.send.accepted) } : { ok: false, error: (r && r.error) || "send failed" };
  },
  async interrupt({ delegation }) {
    const session = resolveDelegatedSession(teamSnapshot.sessions, delegation.localId);
    const h = session && typeof session.handle === "string" ? session.handle : "";
    if (!h) return { ok: false, error: "no terminal" };
    // a Terminal.app tab is interrupted by bringing it to the front and pressing Esc — that key could land in another app
    if (!remoteInterruptAllowed(h)) return { ok: false, unsupported: true };
    const r = await terminalInterrupt(h);
    return r && r.ok !== false ? { ok: true } : { ok: false, error: (r && r.error) || "interrupt failed" };
  },
  // the last answer only: read from the screen (as the inbox / Jira report do), else the transcript's last message
  async last({ session }) {
    if (!session) return { text: "", at: 0 };
    let text = "";
    const h = typeof session.handle === "string" ? session.handle : "";
    if (h) { try { const res = await terminalRead(h, true); const tail = res && res.result && res.result.terminal && res.result.terminal.tail; if (Array.isArray(tail)) text = AgentDeskStatus.responseTextFromScreen(tail) || ""; } catch {} }
    return { text: text || String(session.lastMsg || ""), at: Number(session.time) || 0 };
  },
  // the remote terminal view: the screen as-is (the server masks and caps it); unreadable → null (answered as busy)
  async screen({ session }) {
    const h = session && typeof session.handle === "string" ? session.handle : "";
    if (!h) return null;
    try { const res = await terminalRead(h, true, null, null, { joinWrapped: true }); const tail = res && res.result && res.result.terminal && res.result.terminal.tail; return Array.isArray(tail) ? { lines: tail } : null; } catch { return null; }
  },
  // repeated rate / busy / blocked events: one per session and result a minute; a desktop alert at most every 30 s
  event(e) {
    const ev = teamEventThrottle.pass(e); if (!ev) return null;
    const entry = teamRemoteEvent(ev);
    if (ev.result === "blocked" && Date.now() - teamBlockNotifyAt > 30000) {
      teamBlockNotifyAt = Date.now();
      try { new Notification({ title: "원격 입력 차단", body: `${ev.peer}의 원격 입력을 차단했습니다: ${ev.ruleLabel || ev.rule}` }).show(); } catch {}
    }
    return entry;
  },
};
function teamStopDiscovery() { if (teamDiscovery) { try { teamDiscovery.stop(); } catch {} teamDiscovery = null; } teamDiscoveryKey = ""; teamStatus.discovery = false; }
function teamReload() {
  let cfg = readTeamConfig();
  teamStatus.configured = !!cfg; teamStatus.error = cfg && cfg.error ? cfg.error : "";
  if (!cfg || cfg.error) { teamCfg = null; teamStatus.shared = false; teamRevoke(teamDelegations.clear(), "team sharing off"); teamGrants.clear(); teamStopDiscovery(); if (teamServer) { try { teamServer.close(); } catch {} teamServer = null; teamStatus.listening = false; } return; }
  if (!cfg.instanceId) { try { cfg = { ...cfg, instanceId: ensureInstanceId() }; } catch {} }
  teamCfg = cfg; teamStatus.name = cfg.name; teamStatus.port = cfg.port; teamStatus.instanceId = cfg.instanceId || ""; teamStatus.hasToken = !!cfg.token;
  // delegations end with a new team token, and with the teammate leaving my list; grants from a removed teammate go too
  if (teamDelegToken !== null && teamDelegToken !== cfg.token) { teamRevoke(teamDelegations.clear(), "token changed"); teamGrants.clear(); }
  teamDelegToken = cfg.token;
  teamAutoRevoke();   // teammate removed from team.json, or now sharing an address with another entry
  for (const k of [...teamGrants.keys()]) if (!cfg.peers.some(p => p.name === k)) teamGrants.delete(k);
  // away from the office network(s) remembered at create / join: no beacon, server back on 127.0.0.1, nobody polled —
  // until an interface is on one of them again (checked every 30 s)
  const home = onHomeNetwork(cfg.homeSubnets);
  teamStatus.paused = isShared(cfg) && !home; teamStatus.shared = isShared(cfg) && home;
  teamStatus.bind = teamStatus.shared ? cfg.bind : "127.0.0.1"; teamStatus.homeSubnets = cfg.homeSubnets || null;
  for (const k of [...teamPeerState.keys()]) if (!cfg.peers.some(p => p.name === k)) teamPeerState.delete(k);
  // the page's peer list follows team.json right away (a removed teammate disappears; sharing off → nobody is polled)
  teamStatus.peers = Object.fromEntries(cfg.peers.map(p => [p.name, teamStatus.shared && teamStatus.peers[p.name] ? teamStatus.peers[p.name] : { name: p.name, host: p.host, ok: false, error: teamStatus.shared ? "" : teamStatus.paused ? "paused" : "sharing off", sessions: [], fails: 0 }]));
  // beacon: only while sharing, and unless team.json says "discovery": false; restarted when the advertised name/port changes
  const dKey = !teamStatus.shared || cfg.discovery === false ? "" : `${cfg.name}:${cfg.port}:${cfg.instanceId}`;
  if (dKey !== teamDiscoveryKey) {
    teamStopDiscovery(); teamFound.clear();
    if (dKey) {
      try {
        teamDiscovery = startDiscovery({ name: cfg.name, port: cfg.port, id: cfg.instanceId, onPeer: p => teamFound.set(p.id, p), onError: () => teamStopDiscovery() });
        teamDiscoveryKey = dKey; teamStatus.discovery = true;
      } catch { teamStopDiscovery(); }
    }
  }
  const key = `${teamStatus.bind}:${cfg.port}`;
  if (teamServer && teamServerKey === key) return;
  if (teamServer) { try { teamServer.close(); } catch {} teamServer = null; }
  // the server reads teamCfg on every request through this live view, so a token / name / peer edit applies without a restart
  const live = { get name() { return teamCfg ? teamCfg.name : cfg.name; }, get token() { return teamCfg ? teamCfg.token : cfg.token; }, get instanceId() { return teamCfg ? teamCfg.instanceId : cfg.instanceId; }, get peers() { return teamCfg ? teamCfg.peers : cfg.peers; } };
  const srv = startTeamServer(live, () => teamSnapshot, { onNote: teamOnNote, onHello: teamOnHello, delegations: teamDelegations, remote: teamRemoteHandlers, safety: teamSafety });
  srv.once("error", (e) => { teamStatus.listening = false; teamStatus.error = `listen ${key}: ${e.code || e.message}`; teamServer = null; });
  srv.listen(cfg.port, teamStatus.bind, () => { teamStatus.listening = true; teamStatus.error = ""; });
  teamServer = srv; teamServerKey = key;
}
// a teammate who joined with my invite code (or added me from discovery) says hello with a valid signature. A new
// teammate, or a known instance at a new address, waits for the user's [추가] / [무시]; only filling in the instance id
// of an address I already have is applied directly.
function teamOnHello(peer) {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  const r = upsertPeer(teamCfg.peers, peer);
  if (r.change === "none") return { ok: true };
  if (r.change === "updated") { addPeerToConfig(TEAM_CFG, peer); teamReload(); return { ok: true }; }
  const key = `${peer.host}|${peer.instanceId || ""}`;
  if (teamHelloIgnored.has(key) || teamPendingHellos.has(key) || teamMoveChecks.has(key)) return { ok: true, pending: true };
  const item = { key, name: peer.name, host: peer.host, instanceId: peer.instanceId || "", kind: r.change === "moved" ? "move" : "new", existing: r.change === "moved" ? r.name : "", from: r.from || "", at: Date.now() };
  if (item.kind === "new") { teamQueueHello(item); return { ok: true, pending: true }; }
  // "I moved": if the old address still answers a signed ping as that instance, this hello is someone else claiming
  // the seat → refused (log only). Only a silent old address becomes a change request.
  teamMoveChecks.add(key);
  classifyMove({ oldHost: item.from, instanceId: item.instanceId }, teamCfg.token)
    .then(v => { if (v === "reject") console.log(`[team] hello from ${item.host} claims @${item.existing} (${item.from} still answers) — refused`); else teamQueueHello({ ...item, oldSilent: true }); })
    .catch(() => {}).finally(() => teamMoveChecks.delete(key));
  return { ok: true, pending: true };
}
const teamMoveChecks = new Set();   // move hellos whose old address is being checked
function teamQueueHello(item) {
  if (!teamCfg || teamPendingHellos.has(item.key)) return;
  if (teamPendingHellos.size >= 20) teamPendingHellos.delete(teamPendingHellos.keys().next().value);
  teamPendingHellos.set(item.key, item);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("roca:team-hello", item);
}
const teamHelloSent = new Set();   // peers greeted this run (so they learn my current IP)
function teamSayHello(p) {
  if (!teamCfg || !teamCfg.token || !teamStatus.shared || teamHelloSent.has(p.name) || !sameSubnet(p.host)) return;
  teamHelloSent.add(p.name);
  postHello(p, teamCfg.token, { name: teamCfg.name, port: teamCfg.port, instanceId: teamCfg.instanceId }).then(r => { if (!r.ok) teamHelloSent.delete(p.name); });
}
// 3 s polling with a conditional GET (304 when nothing changed); after 3 failures in a row a peer is polled every 15 s.
// Only while sharing, and only teammates on my own network (/24): at home or in a café nobody is asked.
let teamPolling = false;
async function teamPoll() {
  if (!teamCfg || !teamCfg.token || !teamStatus.shared || teamPolling) return;   // not in a team / sharing off / away from the office
  teamPolling = true;
  try {
    const now = Date.now();
    const offnet = new Set(teamCfg.peers.filter(p => !sameSubnet(p.host)).map(p => p.name));
    // a peer that answered as another instance than the one I registered stays stopped until its entry changes
    const stopped = p => { const st = teamPeerState.get(p.name); return !!(st && st.mismatch && st.host === p.host && st.expectId === (p.instanceId || "")); };
    const due = teamCfg.peers.filter(p => { if (offnet.has(p.name) || stopped(p)) return false; const st = teamPeerState.get(p.name); return !st || now >= (st.nextAt || 0) || st.host !== p.host; });
    // a teammate I delegated to is fetched in full (no ETag / since) at least once a minute: a 304 carries no instance
    // id, so the identity check below would never run for it otherwise
    const delegated = new Set(teamDelegations.list().map(d => d.instanceId));
    const results = await Promise.all(due.map(p => {
      const st = teamPeerState.get(p.name); const same = st && st.host === p.host;
      const full = !same || (p.instanceId && delegated.has(p.instanceId) && now - (st.fullAt || 0) > 60000);
      return fetchPeer(p, teamCfg.token, full ? {} : { etag: st.etag, since: st.theirAt }).then(r => ({ r, p }));
    }));
    for (const { r, p } of results) {
      const prev = teamPeerState.get(p.name) || {};
      const st = { ...(prev.host === p.host ? prev : {}), name: p.name, host: p.host, checkedAt: Date.now(), offnet: false };
      if (r.ok && !r.notModified && p.instanceId && r.instanceId && r.instanceId !== p.instanceId) {
        // the beacon / invite / hello said instance A lives here, the signed reply says B: do not show B as A
        Object.assign(st, { ok: false, mismatch: true, expectId: p.instanceId, error: "identity mismatch", sessions: [], delegatedToMe: [], safety: undefined, etag: "", theirAt: 0, fails: (prev.fails || 0) + 1 });
        teamGrants.delete(p.name);
        console.log(`[team] ${p.name} @ ${p.host}: answered as another instance — polling stopped`);
      } else if (r.ok) {
        st.ok = true; st.mismatch = false; st.error = ""; st.fails = 0; st.lastOk = r.at; st.at = r.at; st.rtt = r.rtt; st.nextAt = Date.now() + 3000 - 200;
        if (r.etag) st.etag = r.etag;
        teamSayHello(p);
        if (!r.notModified) {
          st.fullAt = Date.now();
          st.sessions = r.sessions; st.theirAt = r.theirAt; st.remoteName = r.remoteName; st.instanceId = r.instanceId;
          st.safety = r.safety;   // undefined from a teammate on an older version
          // grants stay in the main process; the page only learns which sessions it may act on
          const dl = r.delegations || [];
          if (dl.length) teamGrants.set(p.name, dl); else teamGrants.delete(p.name);
          st.delegatedToMe = dl.map(d => ({ sessionId: d.sessionId, name: d.name, repo: d.repo, branch: d.branch }));
        }
      } else {
        st.ok = false; st.error = r.error; st.fails = (prev.fails || 0) + 1; st.rtt = r.rtt ?? null; st.etag = ""; st.theirAt = 0;
        st.localNetDenied = isLocalNetworkDenied(r.error, p.host);
        st.nextAt = Date.now() + (st.fails >= 3 ? 15000 : 3000) - 200;
        // keep the last good snapshot for a while so a blip does not empty the list
        if (!(st.lastOk && Date.now() - st.lastOk < 60000)) { st.sessions = []; st.delegatedToMe = []; st.safety = undefined; teamGrants.delete(p.name); }
      }
      if (st.ok) st.localNetDenied = false;
      st.backoff = !st.ok && st.fails >= 3;
      teamPeerState.set(p.name, st);
    }
    // a teammate answered → the permission is there. All failing the denial way → confirm with a probe (an
    // EHOSTUNREACH can also be a teammate's PC that is off), which then decides.
    const v = pollVerdict(results);   // loopback teammates (this PC) are left out: they say nothing about the permission
    if (v === "ok") teamLocalNetSet("ok"); else if (v === "denied") teamLocalNetProbe();
    for (const p of teamCfg.peers) if (offnet.has(p.name)) teamPeerState.set(p.name, { name: p.name, host: p.host, ok: false, offnet: true, error: "other network", sessions: [], fails: 0, checkedAt: now });
    const peers = {};
    for (const p of teamCfg.peers) { const st = teamPeerState.get(p.name); peers[p.name] = st ? { ...st, sessions: st.sessions || [] } : { name: p.name, host: p.host, ok: false, error: "", sessions: [], fails: 0 }; }
    teamStatus.peers = peers;
    teamAutoRevoke();   // identity mismatch, or unreachable for 3 polls and 120 s
  } finally { teamPolling = false; }
}
// macOS Local Network permission (team/localnet.mjs): "denied" shows a banner with a button to the Settings pane;
// while denied a probe runs every 5 s and on window focus, and the first connection that gets through resumes polling
function teamLocalNetSet(state) {
  const prev = teamStatus.localNetwork;
  teamStatus.localNetwork = nextLocalNetwork(prev, state);
  if (prev === "denied" && teamStatus.localNetwork === "ok") {
    // the failures were mine, not the teammates': poll everyone now instead of after the 15 s backoff
    for (const st of teamPeerState.values()) if (!st.ok) st.nextAt = 0;
    setTimeout(teamPoll, 0);
  }
}
let teamLocalNetProbing = false;
async function teamLocalNetProbe() {
  if (process.platform !== "darwin" || teamLocalNetProbing || !teamCfg || !teamStatus.shared) return;
  teamLocalNetProbing = true;
  try {
    const targets = localProbeTargets(teamCfg.peers, await defaultGateway());
    teamLocalNetSet(localNetworkVerdict(await Promise.all(targets.map(h => probeLan(h)))));
  } catch {} finally { teamLocalNetProbing = false; }
}
setInterval(() => { if (teamStatus.localNetwork === "denied") teamLocalNetProbe(); }, 5000);
app.on("browser-window-focus", () => { if (teamStatus.localNetwork === "denied") teamLocalNetProbe(); });
ipcMain.handle("roca:open-local-network-settings", async () => {
  if (process.platform !== "darwin") return { ok: false, error: "macOS only" };
  try { await shell.openExternal(LOCAL_NETWORK_SETTINGS_URL); return { ok: true }; }
  catch { try { await shell.openExternal(PRIVACY_SETTINGS_URL); return { ok: true, fallback: true }; } catch (e) { return { ok: false, error: e.message }; } }
});
function teamDiscoveredList() {
  if (!teamCfg || !teamDiscovery) return [];
  const hosts = new Set(teamCfg.peers.map(p => p.host)), ids = new Set([...teamPeerState.values(), ...teamCfg.peers].map(s => s.instanceId).filter(Boolean));
  for (const [id, p] of teamFound) if (Date.now() - p.at > 20000) teamFound.delete(id);
  return [...teamFound.values()].filter(p => p.id !== teamCfg.instanceId && !hosts.has(p.host) && !ids.has(p.id));
}
setTimeout(() => { teamFirstRun(); teamReload(); teamPoll(); }, 3000);
setInterval(teamReload, 30000);
setInterval(teamPoll, 1000);   // each peer keeps its own 3 s / 15 s schedule (nextAt)
ipcMain.handle("roca:team-status", () => ({ ...teamStatus, safety: (() => { try { return teamSafety(); } catch { return null; } })(), ip: lanAddress(), discovered: teamDiscoveredList(), pending: [...teamPendingHellos.values()], notesNew: teamNotes.filter(n => n.state === "new").length, delegations: teamDelegations.list() }));
// "turn on": the same token-less, local-only team.json a first run writes (create or join a team afterwards)
ipcMain.handle("roca:team-setup", () => {
  try {
    if (existsSync(TEAM_CFG)) { teamReload(); return { ok: true, created: false, file: TEAM_CFG }; }
    teamWriteDefault();
    teamReload(); return { ok: true, created: true, file: TEAM_CFG };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:team-rename", (_e, name) => {
  const n = String(name || "").trim().replace(/[^\w.\-가-힣]/g, "").slice(0, 40); if (!n || !teamCfg) return { ok: false, error: "bad name" };
  try { setTeamFields(TEAM_CFG, { name: n }); teamReload(); teamHelloSent.clear(); return { ok: true, name: n }; } catch (e) { return { ok: false, error: e.message }; }
});
// invite code → clipboard only (it carries the token: never returned to the page, logged or stored anywhere else).
// Creating the team (or re-inviting after "stop sharing") makes this PC visible on the network: the page must have
// shown the warning and pass { confirmed: true }.
ipcMain.handle("roca:team-invite-create", (_e, opts) => {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  const ip = lanAddress(); if (!ip) return { ok: false, error: "no office-network address" };
  const goingPublic = !isShared(teamCfg);
  if (!goingPublic && teamStatus.paused) return { ok: false, error: "not on the office network (Settings → add this network)" };
  if (goingPublic && !(opts && opts.confirmed === true)) return { ok: false, needConfirm: true, goingPublic: true };
  try {
    const fields = { ...(teamCfg.token ? {} : { token: newTeamToken() }), ...(goingPublic ? { ...SHARE_ON, homeSubnets: withHomeSubnets(teamCfg.homeSubnets) } : {}) };
    if (Object.keys(fields).length) { setTeamFields(TEAM_CFG, fields); teamReload(); }
    if (goingPublic) teamLocalNetProbe();   // one LAN connection now, so macOS asks for Local Network access at this moment
    clipboard.writeText(encodeInvite({ token: teamCfg.token, inviter: { name: teamCfg.name, host: `${ip}:${teamCfg.port}`, instanceId: teamCfg.instanceId } }));
    return { ok: true, host: `${ip}:${teamCfg.port}`, name: teamCfg.name };
  } catch (e) { return { ok: false, error: e.message }; }
});
// join: save the token + the inviter as a peer, check the connection, then say hello so the inviter can add me back.
// Leaving another team or going public needs { confirmed: true } after the page has shown what will happen.
ipcMain.handle("roca:team-invite-join", async (_e, code, opts) => {
  const inv = decodeInvite(code); if (inv.error) return { ok: false, error: inv.error };
  const otherToken = !!(teamCfg && teamCfg.token && teamCfg.token !== inv.token);
  // the inviter is already one of my teammates → the same team with a reissued token (keep the list); otherwise I leave my team
  const renew = otherToken && teamCfg.peers.some(p => (inv.inviter.instanceId && p.instanceId === inv.inviter.instanceId) || p.host === inv.inviter.host);
  const leaving = otherToken && !renew ? teamCfg.peers.map(p => p.name) : null;
  const goingPublic = !teamCfg || !isShared(teamCfg);
  if ((otherToken || goingPublic) && !(opts && opts.confirmed === true)) return { ok: false, needConfirm: true, leaving, renew, goingPublic, inviter: inv.inviter.name };
  try {
    if (!existsSync(TEAM_CFG)) teamWriteDefault();
    // another team's teammates are not mine any more: their entries go with the old token
    setTeamFields(TEAM_CFG, { token: inv.token, ...SHARE_ON, homeSubnets: withHomeSubnets(teamCfg && !leaving ? teamCfg.homeSubnets : []), ...(leaving ? { peers: [] } : {}) });
    if (renew) { teamPeerState.clear(); teamHelloSent.clear(); }
    if (leaving) { teamPeerState.clear(); teamPendingHellos.clear(); teamHelloSent.clear(); }
    const r = addPeerToConfig(TEAM_CFG, inv.inviter); if (!r.ok) return r;
    teamReload(); if (!teamCfg) return { ok: false, error: teamStatus.error || "team.json" };
    // joined (token + inviter saved): the page refreshes the Team tab. No `added` flag: the join dialog already toasts
    // the result, and "@inviter joined the team" would name the wrong person.
    toRenderer("roca:team-joined", { name: r.name, host: inv.inviter.host });
    const peer = { name: r.name, host: inv.inviter.host };
    if (!sameSubnet(peer.host)) return { ok: true, connected: false, name: r.name, error: "other network" };
    // this first connection is also what makes macOS ask for Local Network access
    const f = await fetchPeer(peer, teamCfg.token);
    if (!f.ok && isLocalNetworkDenied(f.error, peer.host)) { teamLocalNetProbe(); return { ok: true, connected: false, name: r.name, error: f.error, localNetworkDenied: true }; }
    if (f.ok) teamLocalNetSet("ok");
    if (!f.ok) return { ok: true, connected: false, name: r.name, error: f.error };
    teamHelloSent.delete(peer.name); teamSayHello(peer); setTimeout(teamPoll, 200);
    return { ok: true, connected: true, name: r.name };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:team-open-config", () => { shell.showItemInFolder(TEAM_CFG); return true; });
// add a discovered teammate to team.json peers. Nothing is sent to them here: the token never leaves this PC and no
// hello goes out — polling (signed) shows whether they are in the same team; they add me through their own confirmation.
ipcMain.handle("roca:team-add-peer", (_e, peer) => {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  try {
    const p = peer && typeof peer === "object" ? peer : {};
    // the beacon's instance id is kept: the first signed reply must come from that instance (else "identity mismatch")
    const id = typeof p.id === "string" && UUID_RE.test(p.id) ? p.id.toLowerCase() : "";
    if (id && teamCfg.peers.some(x => x.instanceId === id)) return { ok: false, error: "already listed" };
    const r = addPeerToConfig(TEAM_CFG, { name: String(p.name || ""), host: String(p.host || ""), ...(id ? { instanceId: id } : {}) });
    if (r.ok) { teamReload(); setTimeout(teamPoll, 100); }
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
// [추가] / [무시] on a pending hello
ipcMain.handle("roca:team-hello-decide", (_e, key, accept) => {
  const p = teamPendingHellos.get(String(key)); if (!p) return { ok: false, error: "no such request" };
  teamPendingHellos.delete(p.key);
  if (accept !== true) { teamHelloIgnored.add(p.key); return { ok: true, ignored: true }; }
  try {
    // an instance that moved to a new address: whatever was delegated to it ends (it asks again from the new seat)
    if (p.kind === "move" && p.instanceId) teamRevoke(teamDelegations.removeWhere(d => d.instanceId === p.instanceId), "teammate moved");
    const r = addPeerToConfig(TEAM_CFG, { name: p.name, host: p.host, instanceId: p.instanceId });
    if (r.ok) { teamReload(); teamHelloSent.delete(r.name); setTimeout(teamPoll, 100); }
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
// remove a teammate from my list (to lock them out for good, reissue the token as well)
ipcMain.handle("roca:team-remove-peer", (_e, name) => {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  try {
    const n = String(name || ""), r = removePeerFromConfig(TEAM_CFG, n);
    if (r.ok) { teamPeerState.delete(n); teamHelloSent.delete(n); teamReload(); }
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
// "add this network as an office network": sharing resumes here too
ipcMain.handle("roca:team-home-add", () => {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  try { const homeSubnets = withHomeSubnets(teamCfg.homeSubnets); setTeamFields(TEAM_CFG, { homeSubnets }); teamReload(); return { ok: true, homeSubnets }; } catch (e) { return { ok: false, error: e.message }; }
});
// "stop sharing": back to 127.0.0.1 and no beacon (the token and peers stay; creating an invite code turns it on again)
ipcMain.handle("roca:team-share-off", () => {
  if (!teamCfg) return { ok: false, error: "team sharing is off" };
  try { setTeamFields(TEAM_CFG, SHARE_OFF); teamPeerState.clear(); teamRevoke(teamDelegations.clear(), "sharing off"); teamGrants.clear(); teamReload(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
// new team token: every teammate's signature stops matching; they join again with a new invite code
ipcMain.handle("roca:team-token-rotate", (_e, opts) => {
  if (!teamCfg || !teamCfg.token) return { ok: false, error: "not in a team" };
  if (!(opts && opts.confirmed === true)) return { ok: false, needConfirm: true };
  try { rotateTeamToken(TEAM_CFG); teamPeerState.clear(); teamPendingHellos.clear(); teamHelloSent.clear(); teamReload(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("roca:team-notes", () => teamNotes.slice().reverse());
ipcMain.handle("roca:team-note-update", (_e, id, state) => {
  const n = teamNotes.find(x => x.id === id); if (!n || !["new", "sent", "ignored"].includes(state)) return { ok: false };
  n.state = state; n.doneAt = Date.now(); teamNotesSave(); return { ok: true };
});
ipcMain.handle("roca:team-note-send", async (_e, msg) => {
  if (!teamCfg || !teamStatus.shared) return { ok: false, error: teamStatus.paused ? "not on the office network" : "team sharing is off" };
  const peer = teamCfg.peers.find(p => p.name === (msg && msg.peer)); if (!peer) return { ok: false, error: "unknown peer" };
  if (!sameSubnet(peer.host)) return { ok: false, error: "other network" };
  const v = validateNote({ to: msg.to, toName: msg.toName, from: teamCfg.name, text: msg.text }); if (v.error) return { ok: false, error: v.error };
  // "from" is ignored by the receiver (it uses my registered name there); the port tells two PCs on one IP apart
  return postNote(peer, teamCfg.token, { ...v.note, port: teamCfg.port });
});
// ── phase 3 IPC: delegate / revoke my sessions; act on sessions delegated to me ──
ipcMain.handle("roca:team-delegate", (_e, req) => {
  if (!teamCfg || !teamCfg.token || !teamStatus.shared) return { ok: false, error: teamStatus.paused ? "not on the office network" : "team sharing is off" };
  const r = req && typeof req === "object" ? req : {};
  const peer = teamCfg.peers.find(p => p.instanceId && p.instanceId === String(r.instanceId || "")) || null;
  // the session by its full local id (exactly one), a connected teammate alone at its address, a Claude Code session
  // that does not run with permission checks off
  const s = resolveDelegatedSession(teamSnapshot.sessions, String(r.sessionId || ""));
  const why = canDelegate({ peer, peers: teamCfg.peers, state: peer ? teamPeerState.get(peer.name) : null, session: s });
  if (why) return { ok: false, error: why };
  try {
    const d = teamDelegations.add({ localId: s.id, instanceId: peer.instanceId, peerName: peer.name, name: s.name || "", repo: s.repo ? String(s.repo).split("/").filter(Boolean).pop() : "", branch: s.branch || "" });
    teamRemoteEvent({ kind: "delegate", sessionId: d.sessionId, sessionName: d.name, peer: peer.name, instanceId: peer.instanceId });
    return { ok: true, delegation: d };
  } catch (e) { return { ok: false, error: e.message }; }
});
// { sessionId?, instanceId? }: one pair, every teammate of one session, or (empty) everything
ipcMain.handle("roca:team-revoke", (_e, req) => {
  const r = req && typeof req === "object" ? req : {};
  const lid = r.sessionId ? String(r.sessionId) : "", iid = r.instanceId ? String(r.instanceId) : "";
  const gone = teamDelegations.removeWhere(d => (!lid || d.localId === lid) && (!iid || d.instanceId === iid));
  teamRevoke(gone, "revoked by owner");
  return { ok: true, revoked: gone.length };
});
// [연장] on the owner's card: another 2 hours
ipcMain.handle("roca:team-delegate-extend", (_e, req) => {
  const r = req && typeof req === "object" ? req : {};
  const d = teamDelegations.extend(String(r.sessionId || ""), String(r.instanceId || ""));
  if (!d) return { ok: false, error: "not delegated" };
  teamRemoteEvent({ kind: "extend", sessionId: d.sessionId, sessionName: d.name, peer: d.peerName, instanceId: d.instanceId });
  return { ok: true, expiresAt: d.expiresAt };
});
ipcMain.handle("roca:team-remote-log", (_e, n) => teamRemoteLog.recent(Math.min(500, Math.max(1, Number(n) || 200))));
ipcMain.handle("roca:team-remote-open-log", () => { shell.showItemInFolder(REMOTE_LOG); return true; });
function teamGrantFor(peerName, sessionId) {
  if (!teamCfg || !teamCfg.token || !teamStatus.shared) return { error: teamStatus.paused ? "not on the office network" : "team sharing is off" };
  const peer = teamCfg.peers.find(p => p.name === String(peerName || "")); if (!peer) return { error: "unknown peer" };
  if (!sameSubnet(peer.host)) return { error: "other network" };
  const g = (teamGrants.get(peer.name) || []).find(x => x.sessionId === String(sessionId || ""));
  return g ? { peer, grant: g.grant, sessionId: g.sessionId } : { error: "not delegated" };
}
ipcMain.handle("roca:team-remote-input", async (_e, msg) => {
  const m = msg && typeof msg === "object" ? msg : {};
  const v = validateRemoteText(m.text); if (v.error) return { ok: false, error: v.error };
  const g = teamGrantFor(m.peer, m.sessionId); if (g.error) return { ok: false, error: g.error };
  return remoteInput(g.peer, teamCfg.token, g.sessionId, g.grant, v.text);
});
ipcMain.handle("roca:team-remote-interrupt", async (_e, msg) => {
  const m = msg && typeof msg === "object" ? msg : {};
  const g = teamGrantFor(m.peer, m.sessionId); if (g.error) return { ok: false, error: g.error };
  return remoteInterrupt(g.peer, teamCfg.token, g.sessionId, g.grant);
});
ipcMain.handle("roca:team-remote-last", async (_e, msg) => {
  const m = msg && typeof msg === "object" ? msg : {};
  const g = teamGrantFor(m.peer, m.sessionId); if (g.error) return { ok: false, error: g.error };
  return remoteLast(g.peer, teamCfg.token, g.sessionId, g.grant);
});
ipcMain.handle("roca:team-remote-screen", async (_e, msg) => {
  const m = msg && typeof msg === "object" ? msg : {};
  const g = teamGrantFor(m.peer, m.sessionId); if (g.error) return { ok: false, error: g.error };
  return remoteScreen(g.peer, teamCfg.token, g.sessionId, g.grant);
});
ipcMain.handle("roca:recall-notes", async (_e, cwd, limit) => {
  if (!RECALL_CLI || !cwd || !existsSync(cwd)) return [];
  const node = nodeRunner(process.execPath).cmd;   // no Node.js on this PC → the app binary in Node mode (ELECTRON_RUN_AS_NODE below)
  const run = async (extra) => { const { stdout } = await exec(node, [RECALL_CLI, "list", "--json", "--limit", String(limit || 3), ...extra], { cwd, timeout: 5000, env: { ...process.env, PATH: EXEC_PATH, ELECTRON_RUN_AS_NODE: "1" } }); const arr = JSON.parse(stdout.trim().split("\n").pop() || "[]"); return Array.isArray(arr) ? arr : []; };
  try {
    // notes from this very checkout first; other worktrees of the same repo only when it has none
    const own = await run(["--worktree", cwd.split("/").filter(Boolean).pop()]);
    return own.length ? own : await run([]);
  } catch { return []; }
});
// ── worktree diff view + review comments (diff/git.mjs, core/diff.js). The renderer names a session id only: the directory
//    comes from what this process learned itself (Orca `worktree ps`, hook events), file paths must be in the last stat. ──
setGitPath(EXEC_PATH);
let diffPsCache = { at: 0, list: [] }, diffSeedAt = 0;
async function orcaWorktreeList() {
  if (Date.now() - diffPsCache.at < 10000) return diffPsCache.list;
  const r = await orca("worktree", "ps");
  const list = r && r.ok !== false && r.result && Array.isArray(r.result.worktrees) ? r.result.worktrees : [];
  diffPsCache = { at: Date.now(), list };
  return list;
}
async function diffSessionCwd(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id || id.length > 4096) return "";
  const m = id.match(/^hook:([^:]+)::(.+)$/);
  if (m) {
    // the event log may hold it from before this run (re-read at most every 30 s: the id comes from the renderer)
    if (!hookCwds.has(m[1]) && Date.now() - diffSeedAt > 30000) { diffSeedAt = Date.now(); seedKnownSessions(); }
    const seen = hookCwds.get(m[1]);
    return seen && seen.has(m[2]) ? m[2] : "";
  }
  const w = (await orcaWorktreeList()).find(x => x && x.worktreeId === id);
  return w ? String(w.path || String(w.worktreeId).split("::").pop() || "") : "";
}
const diffCache = new Map();   // session id → { scope (requested), top, fullBase, paths: Map(path → entry), at }
const diffStatSeq = AgentDeskDiff.createSeq();   // per session: the newest stat request wins
const diffFails = new Map();    // session id → { n, until }: failed stats back off 60 s, then 5 min
// what the renderer sees of a failure: no absolute path, no git stderr (that goes to the log only)
function diffErr(where, e) {
  console.error(`[diff] ${where}: ${e && e.message ? e.message : e}`);
  return e && (e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") ? "시간 초과" : "git 실행 실패";
}
// session timeline (card [타임라인] tab): built from the in-memory index only; details were masked when indexed.
// sessionId: a hook session id, or the widget's "hook:<sid>::<cwd>" card id
ipcMain.handle("roca:timeline", (_e, req = {}) => {
  try {
    const raw = req && typeof req.sessionId === "string" ? req.sessionId : "";
    const sid = raw.startsWith("hook:") ? raw.slice(5).split("::")[0] : raw;
    if (!sid || sid.length > 200 || /[\u0000-\u001f]/.test(sid)) return { ok: false, error: "invalid session" };
    pushEvents(readNewEvents());   // whatever the hooks appended since the last poll
    const got = timelineIndex.get(sid);
    if (!got) return { ok: true, events: [], span: { start: 0, end: 0 }, truncated: false, noEarlier: true, subs: [], waits: [], stats: null };
    const since = Number(req.sinceMs) || 0;
    const entries = since > 0 ? got.entries.filter(x => x.at >= since) : got.entries;
    const limit = Math.max(1, Math.min(AgentDeskTimeline.MAX_EVENTS, Number(req.limit) || AgentDeskTimeline.MAX_EVENTS));
    return { ok: true, ...AgentDeskTimeline.buildModel(entries, { limit, truncated: got.truncated || entries.length < got.entries.length }) };
  } catch (e) { console.error("[timeline]", e && e.message); return { ok: false, error: "timeline failed" }; }
});
ipcMain.handle("roca:diff-stat", async (_e, req = {}) => {
  const sessionId = req && typeof req.sessionId === "string" ? req.sessionId : "", scope = req && req.scope === "branch" ? "branch" : "working";
  const seq = diffStatSeq.next(sessionId);
  const fail = diffFails.get(sessionId);
  if (fail && Date.now() < fail.until) return { ok: false, error: "git 실행 실패", backoff: true, retryAt: fail.until };
  try {
    const cwd = await diffSessionCwd(sessionId);
    if (!cwd) return { ok: true, empty: true, reason: "unknown-session", files: [], untracked: [], total: { add: 0, del: 0, files: 0 } };
    const r = await diffStat(cwd, scope);
    diffFails.delete(sessionId);
    if (!diffStatSeq.isLatest(sessionId, seq)) return { ok: false, stale: true };   // a newer request (other scope) is on its way
    if (r.empty) { diffCache.delete(sessionId); return r; }
    if (diffCache.size > 200) diffCache.clear();
    diffCache.set(sessionId, { scope, top: r.top, fullBase: r.fullBase, paths: r.paths, at: Date.now() });
    const { top, paths, fullBase, ...out } = r;   // the absolute path stays here
    return { ...out, requested: scope };
  } catch (e) {
    const n = ((diffFails.get(sessionId) || {}).n || 0) + 1;
    if (diffFails.size > 500) diffFails.clear();
    diffFails.set(sessionId, { n, until: Date.now() + (n >= 2 ? 300000 : 60000) });
    return { ok: false, error: diffErr("stat", e) };
  }
});
ipcMain.handle("roca:diff-file", async (_e, req = {}) => {
  try {
    const c = diffCache.get(req && req.sessionId);
    if (!c) return { ok: false, stale: true, error: "no diff-stat for this session" };
    // the cached list belongs to the other scope (the toggle raced): the renderer asks for the stat again
    if ((req.scope === "branch" ? "branch" : "working") !== c.scope) return { ok: false, stale: true, error: "scope changed" };
    if (!AgentDeskDiff.pathAllowed(req.path, c.paths)) return { ok: false, error: "path not in the last diff-stat" };
    return await diffFile(c.top, c.fullBase, c.paths.get(req.path));
  } catch (e) { return { ok: false, error: diffErr("file", e) }; }
});
ipcMain.handle("roca:diff-open-file", (_e, req = {}) => {
  const c = diffCache.get(req && req.sessionId);
  if (!c || !AgentDeskDiff.pathAllowed(req.path, c.paths)) return { ok: false, error: "path not in the last diff-stat" };
  const real = insideRepo(c.top, req.path);
  if (!real) return { ok: false, error: "not found inside the repository" };
  shell.showItemInFolder(real);
  return { ok: true };
});
ipcMain.handle("roca:diff-comment-send", async (_e, req = {}) => {
  try {
    // the same function (same filter, same order) as the renderer's preview; paths only have to be plain relative
    // paths — no file is read, a comment on a file that left the list since is still sent
    const msg = AgentDeskDiff.commentMessage(req.comments, req.summary, req.lang === "en" ? "en" : "ko");
    if (!msg.count) return { ok: false, error: "no comments", sent: [], dropped: msg.dropped };
    const session = resolveDelegatedSession(teamSnapshot.sessions, req.sessionId);
    const h = session && typeof session.handle === "string" ? session.handle : "";
    if (!h) return { ok: false, error: "no terminal for this session", sent: [], dropped: msg.dropped };
    // fail closed: an unreadable screen, a choice / permission prompt (Enter would pick an option) or a draft at the
    // ❯ prompt (the text would be merged into it) → not sent. A running turn is fine: Claude Code queues the message.
    let tail = null;
    try { const res = await terminalRead(h, true); tail = res && res.result && res.result.terminal && res.result.terminal.tail; } catch { tail = null; }
    if (!screenAllowsInput(tail, { anyTurn: true })) return { ok: false, busy: true, error: "busy", sent: [], dropped: msg.dropped };
    const r = await terminalSend(h, msg.text, true, 15);
    if (!r || r.ok === false) { console.error(`[diff] send: ${(r && r.error) || "send failed"}`); return { ok: false, error: "전송 실패", sent: [], dropped: msg.dropped }; }
    return { ok: true, count: msg.count, sent: msg.sent, dropped: msg.dropped, accepted: !!(r.result && r.result.send && r.result.send.accepted) };
  } catch (e) { console.error(`[diff] send: ${e.message}`); return { ok: false, error: "전송 실패", sent: [], dropped: [] }; }
});
ipcMain.handle("roca:open-external", (_e, url) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url); });

ipcMain.handle("orca:version", async () => {
  await orcaReady;
  try { const { stdout } = await exec(orcaBin, ["--version"], { timeout: 8000, env: { ...process.env, PATH: EXEC_PATH } }); return stdout.trim(); }
  catch { return null; }
});
ipcMain.handle("orca:hooks-status", () => ({ installed: hooksInstalled(), agents: hooksAgents(), script: HOOK_SCRIPT, events: EVENTS_FILE, permHook: permHookInstalled(), permTimeout: permTimeout(), permAvailable: !IS_WIN, guardHook: guardHookInstalled(), guardAvailable: !IS_WIN }));
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
    timelineIndex.clear();   // the whole file is read here: rebuild the timeline index from it (no duplicates)
    for (const l of lines) { try { const o = JSON.parse(l.replace(/^\uFEFF/, "")); timelineIndex.add(o); if (o.ts >= cutoff) { noteKnownSession(o); out.push(o); } } catch {} }
    return out;
  } catch { return []; }
});

app.on("ready", () => {
  // ~/.roca holds the event log (tool inputs), settings backups and the approval token: this user only
  if (existsSync(ROCA_DIR)) { ensurePrivateDir(ROCA_DIR); for (const f of [EVENTS_FILE, ...readdirSync(ROCA_DIR).filter(n => /settings\.backup-\d+\.json$/.test(n)).map(n => join(ROCA_DIR, n))]) { try { chmodSync(f, 0o600); } catch {} } }
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
  // widget permission approval is on: keep its hook script current and open the decision server
  try { if (permHookInstalled()) { const sh = permHookSh(permTimeout()); if (readFileSync(PERM_HOOK_SCRIPT, "utf-8") !== sh) { writeFileSync(PERM_HOOK_SCRIPT, sh); chmodSync(PERM_HOOK_SCRIPT, 0o700); } startPermServer(); } } catch (e) { console.log("[perm] start failed", e.message); }
  // guardrail is on: same — keep its hook script current and open the (shared) socket server
  try { if (guardHookInstalled()) { const sh = guardHookScript(); if (readFileSync(GUARD_HOOK_SCRIPT, "utf-8") !== sh) { writeFileSync(GUARD_HOOK_SCRIPT, sh); chmodSync(GUARD_HOOK_SCRIPT, 0o700); } startPermServer(); } } catch (e) { console.log("[guard] start failed", e.message); }
  createTray();
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
