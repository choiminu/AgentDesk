#!/usr/bin/env node
// Mirror this checkout's committed tree into the company knowledge repository (fin-management/agentdesk) and push it.
//
//   node scripts/sync-fin-management.mjs            # copy HEAD, commit as "<HEAD subject>", push
//   node scripts/sync-fin-management.mjs --no-push  # commit only
//
// What it does: `git archive HEAD` (tracked files only, so node_modules / dist / .omc never travel) → replace
// <repo>/agentdesk/ (deletions included, .github/ left out: GitLab does not run those workflows) → `git pull --ff-only`
// in the target → `git add agentdesk` only (other people's untracked files stay untouched) → commit with the same
// subject as HEAD, prefixed "feat(agentdesk):" → push. Nothing happens when the copy is already identical.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_REPO = process.env.AGENTDESK_MIRROR_REPO || join(homedir(), "fin-management");
const TARGET_DIR = join(TARGET_REPO, "agentdesk");
const push = !process.argv.includes("--no-push");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const sh = (cwd, cmd, args) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit" }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`); };

if (!existsSync(join(TARGET_REPO, ".git"))) { console.error(`[sync] target repository not found: ${TARGET_REPO}`); process.exit(1); }
if (git(SRC, "status", "--porcelain", "--untracked-files=no")) { console.error("[sync] commit or stash your changes first: the mirror copies HEAD, not the working tree"); process.exit(1); }

const head = git(SRC, "rev-parse", "--short", "HEAD"), subject = git(SRC, "log", "-1", "--format=%s");
const version = JSON.parse(execFileSync("git", ["show", "HEAD:package.json"], { cwd: SRC, encoding: "utf-8" })).version;

// 1. export HEAD to a scratch directory
const tmp = mkdtempSync(join(tmpdir(), "agentdesk-mirror-"));
try {
  const tar = spawnSync("sh", ["-c", `git -C "${SRC}" archive HEAD | tar -x -C "${tmp}"`], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("git archive failed");
  rmSync(join(tmp, ".github"), { recursive: true, force: true });

  // 2. bring the target up to date, then replace the directory wholesale (deletions included)
  sh(TARGET_REPO, "git", ["pull", "--ff-only", "--quiet"]);
  rmSync(TARGET_DIR, { recursive: true, force: true });
  cpSync(tmp, TARGET_DIR, { recursive: true });

  // 3. commit only our directory and push
  sh(TARGET_REPO, "git", ["add", "--all", "agentdesk"]);
  if (!git(TARGET_REPO, "status", "--porcelain", "--", "agentdesk")) { console.log(`[sync] ${TARGET_DIR} already matches ${head}; nothing to commit`); process.exit(0); }
  const msg = `feat(agentdesk): ${subject}\n\nAgentDesk ${version} (GitHub choiminu/AgentDesk @ ${head}) 사본 갱신\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`;
  sh(TARGET_REPO, "git", ["commit", "--quiet", "-m", msg]);
  console.log(`[sync] committed ${git(TARGET_REPO, "rev-parse", "--short", "HEAD")} in ${TARGET_REPO}`);
  if (push) { sh(TARGET_REPO, "git", ["push", "--quiet"]); console.log("[sync] pushed"); }
} finally { rmSync(tmp, { recursive: true, force: true }); }
