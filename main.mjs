import { app, BrowserWindow, clipboard, ipcMain, screen, Tray, Menu, nativeImage, Notification, shell } from "electron";
import { execFile, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
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
  const h = saved?.height ?? WIN_H;

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
    if (level >= 2) console.log(`[renderer] ${msg}`);
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

const ORCA_BIN = ["/usr/local/bin/orca", "/opt/homebrew/bin/orca", "orca"];

async function findOrca() {
  for (const bin of ORCA_BIN) {
    try {
      await exec("test", ["-x", bin]);
      return bin;
    } catch {}
  }
  return "orca";
}

let orcaBin = "orca";
findOrca().then(b => { orcaBin = b; });

async function orca(...args) {
  try {
    const { stdout } = await exec(orcaBin, [...args, "--json"], {
      timeout: 15000,
      env: { ...process.env, PATH: `${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin` },
    });
    return JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: err.message };
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

ipcMain.handle("orca:terminal-switch", async (_e, handle) => {
  const result = await orca("terminal", "switch", "--terminal", handle);
  exec("/usr/bin/osascript", ["-e", 'tell application "Orca" to activate'], { timeout: 3000 }).catch(() => {});
  return result;
});

ipcMain.handle("orca:terminal-interrupt", (_e, handle) =>
  orca("terminal", "send", "--terminal", handle, "--interrupt")
);

ipcMain.handle("orca:terminal-send", (_e, handle, text, enter, waitSubmit) => {
  const args = ["terminal", "send", "--terminal", handle, "--text", text];
  if (enter) args.push("--enter");
  if (waitSubmit) args.push("--wait-submit", String(waitSubmit));
  const timeoutMs = waitSubmit ? (waitSubmit * 1000 + 10000) : 15000;
  return exec(orcaBin, [...args, "--json"], {
    timeout: timeoutMs,
    env: { ...process.env, PATH: `${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin` },
  }).then(({ stdout }) => JSON.parse(stdout)).catch(err => ({ ok: false, error: err.message }));
});

ipcMain.handle("orca:terminal-wait", (_e, handle, condition, timeoutMs) => {
  const args = ["terminal", "wait", "--terminal", handle, "--for", condition];
  if (timeoutMs) args.push("--timeout-ms", String(timeoutMs));
  return exec(orcaBin, [...args, "--json"], {
    timeout: (timeoutMs || 180000) + 5000,
    env: { ...process.env, PATH: `${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin` },
  }).then(({ stdout }) => JSON.parse(stdout)).catch(err => ({ ok: false, error: err.message }));
});

ipcMain.handle("orca:terminal-read", async (_e, handle, screen, cursor, limit) => {
  const args = ["terminal", "read", "--terminal", handle];
  if (screen) args.push("--screen");
  if (cursor != null) args.push("--cursor", String(cursor));
  if (limit != null) args.push("--limit", String(limit));
  const res = await orca(...args);
  const tail = res?.result?.terminal?.tail;
  console.log(`[terminal-read] screen=${!!screen} tail=${Array.isArray(tail) ? tail.length : 'none'} keys=${JSON.stringify(Object.keys(res?.result || {}))}`);
  return res;
});

ipcMain.handle("orca:terminal-close", (_e, handle) =>
  orca("terminal", "close", "--terminal", handle)
);

ipcMain.on("orca:session-counts", (_e, counts) => {
  const { running, waiting } = counts;
  if (tray) {
    const parts = [];
    if (running > 0) parts.push(`▶${running}`);
    if (waiting > 0) parts.push(`?${waiting}`);
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

app.on("ready", () => {
  createWindow();
  createTray();
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
