#!/usr/bin/env node
// Development only (macOS): give the Electron binary under node_modules the NSLocalNetworkUsageDescription key.
//
// macOS 15+ shows the "local network" permission prompt — and lists the app under System Settings → Privacy &
// Security → Local Network — only for apps whose Info.plist carries that key. The stock Electron.app has none, so
// `npm start` is refused silently (EHOSTUNREACH to every teammate) and never appears in the list. The packaged
// AgentDesk.app gets the key from package.json (build.mac.extendInfo); this script does the same for the dev binary
// and re-applies the ad-hoc signature the modified bundle needs. Runs from `npm run postinstall`; safe to re-run.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "node_modules", "electron", "dist", "Electron.app");
const plist = join(app, "Contents", "Info.plist");
if (!existsSync(plist)) process.exit(0);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const text = pkg?.build?.mac?.extendInfo?.NSLocalNetworkUsageDescription;
if (!text) { console.log("[dev-localnet] package.json has no NSLocalNetworkUsageDescription; nothing to do"); process.exit(0); }

const pb = (...args) => execFileSync("/usr/libexec/PlistBuddy", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let current = "";
try { current = pb("-c", "Print :NSLocalNetworkUsageDescription", plist); } catch {}
if (current === text) { console.log("[dev-localnet] Electron.app already has the local-network key"); process.exit(0); }
try {
  pb("-c", current ? `Set :NSLocalNetworkUsageDescription ${text}` : `Add :NSLocalNetworkUsageDescription string ${text}`, plist);
  // the bundle changed → its ad-hoc signature is stale; re-sign the whole bundle ad hoc (no identity needed)
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: ["ignore", "ignore", "pipe"] });
  console.log("[dev-localnet] added NSLocalNetworkUsageDescription to Electron.app and re-signed it (ad hoc). Restart `npm start`; macOS will ask for local-network access once.");
} catch (e) {
  console.warn("[dev-localnet] could not patch Electron.app:", e.message, "— team sharing in `npm start` may be refused by macOS (the packaged app is unaffected)");
}
