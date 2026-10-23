#!/usr/bin/env node
// README screenshots from demo data only (no real session names): launches the app in demo mode (hash part "demo":
// widget.html DEMO_MODE — fake sessions, team and usage, no Orca, no briefing) with the Chrome DevTools port, adds a demo
// choice bubble in dock mode, captures each page with Page.captureScreenshot and composites the (transparent) window onto
// a dark gradient. Output: docs/screenshots/*.png
//
//   node scripts/shots.mjs            # all pages
//   node scripts/shots.mjs dock       # one page: dashboard | office | dock | team
//   node scripts/shots.mjs gif        # docs/screenshots/dock.gif: a question arrives → the bubble grows → one click answers
//
// The running app must be closed first (single instance). Needs node >= 22 (global WebSocket, fetch).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./make-icon.mjs";
import { encodeGif, downscale } from "./gif.mjs";

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
function composite(png, margin = 28, flat = false) {   // flat: one colour (a GIF's 256 colours band on a gradient)
  const { w, h, px } = decodePng(png);
  const W = w + 2 * margin, H = h + 2 * margin, out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = flat ? 0.5 : (x / W + y / H) / 2, i = (y * W + x) * 4;
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


// the dock story as frames: the bar, a question arrives (bubble), the pointer grows it, one option is chosen, sent
async function pageGif() {
  const c = await cdp();
  await sleep(1500);
  await c.evalJs(`if (dockOn) dockLeave(); dockCfg.start = false; true`);
  await c.evalJs(`fetchData(); teamPageTick(); true`);
  await sleep(600);
  await c.evalJs(`sessions.find(s => s.id === 'd2').needsInput = false; dockCfg.hoverTerm = true; dockEnter(); true`);
  await sleep(1500);
  const frames = [], delays = [];
  const grab = async (ms, n = 1) => { const png = await c.shot(); for (let i = 0; i < n; i++) { frames.push(png); delays.push(ms); } };
  await grab(1400);                                                        // the bar, everyone working
  await c.evalJs(`sessions.find(s => s.id === 'd2').needsInput = true; sessions.find(s => s.id === 'd2').askSince = Date.now(); dockDraw(); true`);
  await sleep(900); await grab(1600);                                      // ci-fix asks: the bubble
  await c.evalJs(`{ const a = dockAsk.get('me:d2'); if (a) { a.big = true; a.dirty = true; dockAskRender(); dockAskPlace(); dockBoundsSync(); } } true`);
  await sleep(900); await grab(1600);                                      // pointer on the tile: the bubble grows
  await c.evalJs(`{ const a = dockAsk.get('me:d2'); if (a && a.el) { const b = a.el.querySelector('[data-opt="1"]'); if (b) b.classList.add('cur'); } } true`);
  await sleep(300); await grab(700);                                       // option 1 highlighted
  await c.evalJs(`{ const a = dockAsk.get('me:d2'); if (a) { a.sent = '1. ubuntu-22.04 (Recommended)'; a.sentAt = Date.now(); a.dirty = true; dockAskRender(); dockAskPlace(); dockBoundsSync(); } } true`);
  await sleep(500); await grab(1500);                                      // sent
  await c.evalJs(`dockAskDrop('me:d2'); sessions.find(s => s.id === 'd2').needsInput = false; sessions.find(s => s.id === 'd2').status = 'running'; sessions.find(s => s.id === 'd2').tool = 'Bash'; dockDraw(); dockAskPlace(); dockBoundsSync(); true`);
  await sleep(900); await grab(1800);                                      // back to work
  c.close();
  // the window grows for the bubble: pad every frame to the largest size (bottom-aligned, the bar stays put)
  const decoded = frames.map(f => decodePng(f));
  const W = Math.max(...decoded.map(d => d.w)), H = Math.max(...decoded.map(d => d.h));
  const padded = decoded.map(d => {
    const px = Buffer.alloc(W * H * 4); const dy = H - d.h;
    for (let y = 0; y < d.h; y++) d.px.copy(px, ((y + dy) * W) * 4, y * d.w * 4, (y + 1) * d.w * 4);
    return { w: W, h: H, px };
  });
  const bg = padded.map(f => { const b = decodePng(composite(encodePng(f.w, f.h, f.px), 20, true)); return downscale({ w: b.w, h: b.h, px: b.px }, 2); });
  writeFileSync(join(OUT, "dock.gif"), encodeGif(bg, { delays }));
  console.log(`[shot] dock.gif (${bg[0].w}x${bg[0].h}, ${frames.length} frames)`);
}

const wantA = !only || ["dashboard", "team", "dock"].includes(only), wantB = !only || only === "office", wantGif = !only || only === "gif";
if (wantA) { const p = launch("dashboard,en,skip-onboarding,demo"); try { await pageA(p); } finally { p.kill(); await sleep(800); } }
if (wantB) { const p = launch("office-demo,en,skip-onboarding,demo"); try { await pageB(); } finally { p.kill(); await sleep(800); } }
if (wantGif) { const p = launch("dashboard,en,skip-onboarding,demo"); try { await pageGif(); } finally { p.kill(); await sleep(800); } }
console.log("[shot] done");
