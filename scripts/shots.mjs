#!/usr/bin/env node
// README screenshots from demo data only (no real session names): launches the app in demo mode (hash part "demo":
// widget.html DEMO_MODE — fake sessions, team and usage, no Orca, no briefing) with the Chrome DevTools port, adds a demo
// choice bubble in dock mode, captures each page with Page.captureScreenshot and composites the (transparent) window onto
// a dark gradient. Output: docs/screenshots/*.png
//
//   node scripts/shots.mjs            # all pages
//   node scripts/shots.mjs dock       # one page: dashboard | office | dock | team
//
// The running app must be closed first (single instance). Needs node >= 22 (global WebSocket, fetch).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./make-icon.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");
const PORT = 9444;
const only = process.argv[2] || "";
mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function launch(hash) {
  const env = { ...process.env, NODE_ENV: "development", ROCA_START_PAGE: hash };
  const p = spawn(join(ROOT, "node_modules", ".bin", "electron"), [".", `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", d => process.stdout.write(`[app] ${d}`));
  p.stderr.on("data", d => process.stderr.write(`[app] ${d}`));
  return p;
}
async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find(x => x.url.includes("widget.html"));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let seq = 0; const pending = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
        const evalJs = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + " " + JSON.stringify(r.result.exceptionDetails.exception)); return r.result && r.result.result ? r.result.result.value : undefined; };
        const shot = async () => { await evalJs(`$('toasts').innerHTML = ''; true`); return Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).result.data, "base64"); };
        return { send, evalJs, shot, close: () => ws.close() };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("no devtools page");
}
// the window image over a dark gradient, with a margin
function composite(png, margin = 28) {
  const { w, h, px } = decodePng(png);
  const W = w + 2 * margin, H = h + 2 * margin, out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = (x / W + y / H) / 2, i = (y * W + x) * 4;
    out[i] = Math.round(24 + 10 * (1 - t)); out[i + 1] = Math.round(27 + 10 * (1 - t)); out[i + 2] = Math.round(36 + 14 * (1 - t)); out[i + 3] = 255;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, a = px[s + 3] / 255; if (!a) continue;
    const d = ((y + margin) * W + x + margin) * 4;
    for (let k = 0; k < 3; k++) out[d + k] = Math.round(px[s + k] * a + out[d + k] * (1 - a));
  }
  return encodePng(W, H, out);
}
const save = (name, png) => { writeFileSync(join(OUT, name), composite(png)); console.log(`[shot] ${name}`); };

async function pageA(p) {
  const c = await cdp();
  await sleep(1500);
  await c.evalJs(`if (dockOn) dockLeave(); dockCfg.start = false; true`);
  await c.evalJs(`fetchData(); teamPageTick(); true`);
  await sleep(600);
  if (!only || only === "dashboard") {
    await c.evalJs(`showPage('dashboard'); window.orca.resizeWindow(640, 720, true); renderDashboard(); true`);
    await sleep(1200); await c.evalJs(`renderDashboard(); true`); await sleep(400);
    save("dashboard.png", await c.shot());
  }
  if (!only || only === "team") {
    await c.evalJs(`showPage('team'); window.orca.resizeWindow(640, 720, true); teamRender(true); true`);
    await sleep(1200); await c.evalJs(`teamRender(true); true`); await sleep(400);
    save("team.png", await c.shot());
  }
  if (!only || only === "dock") {
    await c.evalJs(`dockCfg.hoverTerm = true; dockCfg.anim = true; dockEnter(); true`);
    await sleep(1500);
    await sleep(1800);
    save("dock.png", await c.shot());
    await c.evalJs(`dockLeave(); true`);
  }
  c.close();
}
async function pageB() {
  const c = await cdp();
  await sleep(1500);
  await c.evalJs(`window.orca.resizeWindow(1000, 640, true); true`);
  await sleep(14000);   // the demo office: characters walk to their desks, the whiteboard fills
  save("office.png", await c.shot());
  c.close();
}

const wantA = !only || ["dashboard", "team", "dock"].includes(only), wantB = !only || only === "office";
if (wantA) { const p = launch("dashboard,en,skip-onboarding,demo"); try { await pageA(p); } finally { p.kill(); await sleep(800); } }
if (wantB) { const p = launch("office-demo,en,skip-onboarding,demo"); try { await pageB(); } finally { p.kill(); await sleep(800); } }
console.log("[shot] done");
