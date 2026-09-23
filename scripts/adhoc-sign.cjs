// electron-builder afterPack hook (macOS only): ad-hoc sign the whole bundle so Gatekeeper treats it as an
// unidentified-developer app ("Open Anyway" works) instead of a damaged one. Without a Developer ID this is the
// best free option; a real identity in CSC_LINK/CSC_NAME makes electron-builder sign instead and this becomes a no-op.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${app}`);
};
