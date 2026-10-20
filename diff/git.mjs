// AgentDesk: read-only git diff of a session's worktree for the "변경" (changes) tab of a session card.
// The renderer never hands a path to git: main.mjs resolves the session id to a directory it learned itself (Orca
// `worktree ps`, hook events), and file paths are only accepted when the last diff-stat of that session listed them.
// git runs without a shell (argument arrays), with optional locks off (an agent may be committing at the same time),
// no external diff / textconv drivers and no fsmonitor command.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { homedir } from "node:os";
import "../core/mask.js";
import "../core/team.js";
import "../core/diff.js";
const { mask, maskLines } = globalThis.AgentDeskMask;
const { parseUnified, parseNumstat, parseNameStatus, parsePorcelain, safeRelPath } = globalThis.AgentDeskDiff;

export const FILES_MAX = 500;
export const FILE_BYTES_MAX = 300 * 1024;
export const FILE_LINES_MAX = 2000;
const STAT_BYTES_MAX = 8 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
let execPath = process.env.PATH || "";
// a Finder-launched app has a bare PATH: main.mjs passes its extended one (the process PATH plus /usr/local/bin,
// /opt/homebrew/bin and ~/.local/bin appended), so a git found only in those folders still runs
export function setGitPath(p) { if (p) execPath = String(p); }

// at most GIT_MAX git processes at a time across all sessions; the rest wait in a queue
export const GIT_MAX = 4;
let gitActive = 0, gitPeak = 0;
const gitQueue = [];
export const gitConcurrency = () => ({ max: GIT_MAX, active: gitActive, peak: gitPeak, queued: gitQueue.length });
function gitSlot() {
  if (gitActive < GIT_MAX) { gitActive++; gitPeak = Math.max(gitPeak, gitActive); return Promise.resolve(); }
  return new Promise(r => gitQueue.push(r));
}
function gitRelease() {
  const next = gitQueue.shift();
  if (next) { gitPeak = Math.max(gitPeak, gitActive); next(); } else gitActive--;
}
// → { stdout, cut } ; exit code 1 with output is a normal answer for `diff --no-index`; a full buffer is "cut".
// GIT_LITERAL_PATHSPECS: a file named "*.js" or ":(glob)x" is that file, never a pattern.
async function git(cwd, args, { maxBuffer = STAT_BYTES_MAX, okCodes = [0] } = {}) {
  await gitSlot();
  try {
    return await new Promise((resolve, reject) => {
      execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", cwd, ...args], {
        timeout: 10000, maxBuffer, encoding: "utf8", windowsHide: true,
        env: { ...process.env, PATH: execPath, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      }, (err, stdout) => {
        if (!err) return resolve({ stdout, cut: false });
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ stdout: String(stdout || ""), cut: true });
        if (okCodes.includes(err.code)) return resolve({ stdout: String(stdout || ""), cut: false });
        reject(err);
      });
    });
  } finally { gitRelease(); }
}
const gitText = async (cwd, args) => { try { return (await git(cwd, args)).stdout.trim(); } catch { return ""; } };

// the repository root (realpath) of a directory, or "" when it is not a git work tree
export async function repoRoot(cwd) {
  let real;
  try { real = realpathSync(cwd); } catch { return ""; }
  const top = await gitText(real, ["rev-parse", "--show-toplevel"]);
  if (!top) return "";
  try { return realpathSync(top); } catch { return ""; }
}
// `rel` inside `top` after resolving symbolic links, else "" (a link pointing outside the repository is refused)
export function insideRepo(top, rel) {
  const p = safeRelPath(rel); if (!p || !top) return "";
  let real;
  try { real = realpathSync(join(top, p)); } catch { return ""; }
  return real === top || real.startsWith(top.endsWith(sep) ? top : top + sep) ? real : "";
}

async function defaultBase(top) {
  const head = await gitText(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  for (const ref of [head, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    if (await gitText(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
      const mb = await gitText(top, ["merge-base", "HEAD", ref]);
      if (mb) return { base: mb, baseRef: ref };
    }
  }
  return null;
}
// the commit the scope diffs against: HEAD (working tree), the merge-base with the default branch (whole branch)
async function resolveBase(top, scope) {
  const head = await gitText(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (scope === "branch") { const b = await defaultBase(top); if (b) return { ...b, scope: "branch" }; }
  return head ? { base: head, baseRef: "HEAD", scope: "working" } : { base: EMPTY_TREE, baseRef: "(empty)", scope: "working" };
}

// → { repoRoot (basename), branch, base, baseRef, scope, files, untracked, total, truncated, top (main only), paths (main only) }
// `opts.home`: the home folder (tests); a repository whose root IS the home folder (dotfiles) is not listed — it
// would show every untracked file under ~
export async function diffStat(cwd, scope, opts = {}) {
  const top = await repoRoot(cwd);
  const none = reason => ({ ok: true, empty: true, reason, files: [], untracked: [], total: { add: 0, del: 0, files: 0 }, truncated: false });
  if (!top) return none("not-git");
  let home = "";
  try { home = realpathSync(opts.home || homedir()); } catch {}
  if (home && top === home) return none("home");
  const b = await resolveBase(top, scope === "branch" ? "branch" : "working");
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];
  const [num, names, por, branch] = await Promise.all([
    git(top, ["diff", ...common, "--numstat", "-z", b.base, "--"]),
    git(top, ["diff", ...common, "--name-status", "-z", b.base, "--"]),
    git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
    gitText(top, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const status = new Map(parseNameStatus(names.stdout).map(e => [e.path, e]));
  let files = parseNumstat(num.stdout).map(f => {
    const st = status.get(f.path);
    return { path: f.path, oldPath: f.oldPath || (st && st.oldPath) || "", add: f.add, del: f.del, binary: f.binary, status: (st && st.status) || "M" };
  });
  let untracked = parsePorcelain(por.stdout).filter(e => e.x === "?").map(e => e.path);
  let truncated = num.cut || names.cut || por.cut;
  if (files.length > FILES_MAX) { files = files.slice(0, FILES_MAX); truncated = true; }
  if (untracked.length > FILES_MAX) { untracked = untracked.slice(0, FILES_MAX); truncated = true; }
  const total = { add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0), files: files.length + untracked.length };
  const paths = new Map(files.map(f => [f.path, f]));
  for (const u of untracked) if (!paths.has(u)) paths.set(u, { path: u, oldPath: "", status: "?", untracked: true });
  return { ok: true, repoRoot: basename(top), branch: branch === "HEAD" ? "" : branch, base: b.base.slice(0, 12), baseRef: b.baseRef, scope: b.scope, files, untracked, total, truncated, top, paths, fullBase: b.base };
}

// one file's hunks; `entry` comes from the cached stat (never from the renderer)
export async function diffFile(top, fullBase, entry) {
  const p = safeRelPath(entry && entry.path);
  if (!top || !p) return { ok: false, error: "bad path" };
  let res;
  if (entry.untracked) {
    if (!insideRepo(top, p)) return { ok: false, error: "outside repository" };
    res = await git(top, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--unified=3", "--", "/dev/null", p], { maxBuffer: FILE_BYTES_MAX, okCodes: [1] });
  } else {
    const paths = entry.oldPath && safeRelPath(entry.oldPath) ? [entry.oldPath, p] : [p];
    res = await git(top, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3", fullBase, "--", ...paths], { maxBuffer: FILE_BYTES_MAX });
  }
  const parsed = parseUnified(res.stdout, { maxLines: FILE_LINES_MAX });
  // masked in file order (a private key spans lines), then cut: a cut never leaves half a secret unmasked
  const all = parsed.hunks.flatMap(h => h.lines);
  const masked = maskLines(all.map(l => l.s));
  all.forEach((l, i) => { l.s = masked[i].length > 2000 ? masked[i].slice(0, 2000) + "…" : masked[i]; });
  for (const h of parsed.hunks) h.header = mask(h.header);
  return { ok: true, path: p, oldPath: entry.oldPath || "", status: entry.status || "M", hunks: parsed.hunks, binary: parsed.binary || !!entry.binary, truncated: parsed.truncated || res.cut };
}
