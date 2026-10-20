// Dangerous-command guardrail (PreToolUse): the rule file, the hit log and the handler behind POST /v1/guard on the
// permission socket (perm/server.mjs). Matching itself is core/guard.js (pure); this file does the I/O.
//   ~/.roca/guard.json       (0600) { mode: "off"|"warn"|"block", rules: [...], allowRepos: [] } — created from
//                            core/guard.js defaultRules() when missing; a broken file is never overwritten silently
//   ~/.roca/guard-log.jsonl  (0600) one line per hit, the last 2,000 kept
// The hook is a seatbelt, fail-open: any error here answers {} and the tool call goes on through Claude Code's own
// permission flow. User regexes run in a vm context with a 20 ms limit, so a catastrophic pattern cannot hang the app;
// a rule that hits the limit is disabled in the file and reported.
import vm from "node:vm";
import { existsSync, readFileSync, statSync, appendFileSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../perm/server.mjs";
import "../core/mask.js";    // globalThis.AgentDeskMask (summaries)
import "../core/guard.js";   // globalThis.AgentDeskGuard
const G = globalThis.AgentDeskGuard;

export const GUARD_MODES = ["off", "warn", "block"];
export const GUARD_MODE_DEFAULT = "warn";
export const GUARD_LOG_MAX = 2000;
export const GUARD_RULES_MAX = 200;
export const SLOW_STRIKES = 2;        // a user rule is disabled after timing out on this many different inputs

export function defaultGuardConfig() {
  return { mode: GUARD_MODE_DEFAULT, rules: G.defaultRules(), allowRepos: [] };
}
// a JSON object from disk → a clean config (unknown keys dropped, rules kept as written so the UI can show errors)
export function normalizeGuardConfig(o) {
  const c = o && typeof o === "object" && !Array.isArray(o) ? o : {};
  return {
    mode: GUARD_MODES.includes(c.mode) ? c.mode : GUARD_MODE_DEFAULT,
    rules: Array.isArray(c.rules) ? c.rules.slice(0, GUARD_RULES_MAX).filter(r => r && typeof r === "object" && !Array.isArray(r)).map((r, i) => {
      const x = { id: G.ruleId(r, i), label: String(r.label || "").slice(0, 120), pattern: String(r.pattern || ""),
        tools: Array.isArray(r.tools) ? r.tools.filter(t => typeof t === "string").slice(0, 10) : ["Bash"], enabled: r.enabled !== false, severity: r.severity === "block" ? "block" : "warn" };
      if (r.builtin === true) x.builtin = true;
      if (typeof r.disabledReason === "string") x.disabledReason = r.disabledReason.slice(0, 200);
      if (typeof r.slowNote === "string") x.slowNote = r.slowNote.slice(0, 200);
      return x;
    }) : G.defaultRules(),
    allowRepos: Array.isArray(c.allowRepos) ? c.allowRepos.filter(p => typeof p === "string" && p.trim()).slice(0, 50) : [],
  };
}
// → { cfg, compiled, errors, fileError }. Missing file → defaults written (0600). Unreadable / not JSON → `fallback`
// (the last config that loaded) or, without one, the default rules in block mode (fail-safe: block mode only adds
// questions and refusals), and fileError set; the file is left alone until the user chooses to overwrite it.
export function readGuardConfig(file, fallback) {
  let cfg, fileError = "";
  if (!existsSync(file)) { cfg = defaultGuardConfig(); try { writePrivate(file, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) { fileError = e.message; } }
  else {
    try { const o = JSON.parse(readFileSync(file, "utf-8")); if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("JSON 객체가 아닙니다"); cfg = normalizeGuardConfig(o); }
    catch (e) { cfg = fallback ? normalizeGuardConfig(fallback) : { ...defaultGuardConfig(), mode: "block" }; fileError = `guard.json을 읽을 수 없습니다: ${e.message}`; }
  }
  const { rules, errors } = G.compileRules(cfg.rules);
  return { cfg, compiled: rules, errors, fileError };
}
export function writeGuardConfig(file, cfg) {
  const c = normalizeGuardConfig(cfg);
  writePrivate(file, JSON.stringify(c, null, 2) + "\n");
  return c;
}

// user rules run here: a vm timeout interrupts even a catastrophic backtracking regex (it throws → `slow`)
const VM_CTX = vm.createContext(Object.create(null));
const VM_SCRIPT = new vm.Script("(function () { for (var i = 0; i < forms.length; i++) { if (re.test(forms[i])) return true; } return false; })()");
export function vmRunner(timeoutMs = G.SLOW_MS) {
  return (rule, forms) => {
    VM_CTX.re = rule.re; VM_CTX.forms = forms;
    try { return VM_SCRIPT.runInContext(VM_CTX, { timeout: timeoutMs }) === true; }
    finally { VM_CTX.re = null; VM_CTX.forms = null; }
  };
}

// append-only JSONL, 0600, cut back to the last `max` lines once it grows 20 % past it
export function createGuardLog(file, max = GUARD_LOG_MAX) {
  let lines = null;
  const count = () => { if (lines == null) { try { lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).length; } catch { lines = 0; } } return lines; };
  return {
    file,
    append(entry) {
      try {
        count();
        appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
        try { chmodSync(file, 0o600); } catch {}
        lines++;
        if (lines > Math.ceil(max * 1.2)) {
          const keep = readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-max);
          writePrivate(file, keep.join("\n") + "\n"); lines = keep.length;
        }
      } catch {}
    },
    read(n = 500) {
      try { return readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-Math.max(1, Math.min(n, max))).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
      catch { return []; }
    },
  };
}

const expandHome = p => (p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p);
const inRepo = (cwd, repos) => typeof cwd === "string" && cwd && repos.some(r => { const d = expandHome(r).replace(/\/+$/, ""); return d && (cwd === d || cwd.startsWith(d + "/")); });
const ASK_TIMEOUT = "평가 시간 초과";
const ASK_LONG = "명령이 너무 길어 끝까지 검사하지 못했습니다";
const ASK_SLOW = "차단 규칙의 정규식이 시간 안에 끝나지 않았습니다";
const ASK_ERROR = "가드 판정 중 오류";
const ASK_NOPATH = "입력이 너무 커 대상 경로를 확인하지 못했습니다";

// opts: { file, log (createGuardLog), now(), onHit(entry), onRuleDisabled({ id, label, reason }),
//         onRuleSlow({ id, label }), runner, deadline (ms) }
// → { handle(body, { settle }) → hook output, test(tool, input, mode), remote(text), config(), reload() }
// meta.settle(fn): the server calls fn(true) once the answer was written out to the hook, fn(false) when the hook had
// already gone (curl gave up) — the hit is logged then, as its decision or as "late-pass". Without settle it is logged
// at once.
// Every answer is {} or a PreToolUse ask / deny (G.outputAllowed); anything else becomes {}.
export function createGuardHandler(opts = {}) {
  const file = opts.file;
  const runner = opts.runner || vmRunner();
  const now = opts.now || Date.now;
  let cache = null, cacheKey = "", lastGood = null;
  const strikes = new Map();   // user rule id → Set of input keys it timed out on (memory only)
  function load() {
    let key = "missing"; try { const st = statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch {}
    if (!cache || key !== cacheKey) {
      cache = readGuardConfig(file, lastGood);
      if (!cache.fileError) lastGood = cache.cfg;
      try { const st = statSync(file); cacheKey = `${st.mtimeMs}:${st.size}`; } catch { cacheKey = key; }
    }
    return cache;
  }
  const log = (e) => { try { opts.log && opts.log.append(e); } catch {} };
  // a timed-out user rule is disabled only once it timed out on two different inputs (one pathological command is
  // not enough to switch a rule off for good)
  function noteSlow(ids, subject) {
    const off = [];
    for (const id of ids) {
      const set = strikes.get(id) || new Set();
      set.add(`${subject.length}:${subject.slice(0, 64)}:${subject.slice(-64)}`); strikes.set(id, set);
      if (set.size >= SLOW_STRIKES) off.push(id);
    }
    if (!off.length) return;
    const cur = load(); if (cur.fileError) return;   // never rewrite a file we could not read
    // a block-level rule is never switched off by us (that would silently drop a protection): it is marked slow and
    // the user decides; a warn-level rule is disabled
    const isBlock = id => (cur.cfg.rules.find(x => x.id === id) || {}).severity === "block";
    const note = `느린 정규식 (${G.SLOW_MS}ms 초과 ${SLOW_STRIKES}회)`;
    const cfg = { ...cur.cfg, rules: cur.cfg.rules.map(r => !off.includes(r.id) || r.builtin ? r
      : isBlock(r.id) ? { ...r, slowNote: `${note} — 차단 규칙이라 켜 둡니다. 정규식을 고치거나 직접 끄세요` }
      : { ...r, enabled: false, disabledReason: `${note} — 자동 비활성화` }) };
    try { writeGuardConfig(file, cfg); } catch {}
    cache = null;
    for (const id of off) {
      strikes.delete(id);
      const r = cur.cfg.rules.find(x => x.id === id) || { id, label: id };
      if (isBlock(id)) {
        log({ at: now(), type: "rule-slow", rule: id, label: r.label, reason: "slow" });
        try { opts.onRuleSlow && opts.onRuleSlow({ id, label: r.label }); } catch {}
      } else {
        log({ at: now(), type: "rule-disabled", rule: id, label: r.label, reason: "slow" });
        try { opts.onRuleDisabled && opts.onRuleDisabled({ id, label: r.label, reason: "slow" }); } catch {}
      }
    }
  }
  // → { decision: null|"ask"|"deny", output, rule: {id,label,severity}|null, summary, res }
  function judge(tool, input, mode, compiled, truncated) {
    const res = G.evaluate(tool, input, compiled, { run: runner, ...(opts.deadline != null ? { deadline: opts.deadline } : {}) });
    if (res.slow.length) noteSlow(res.slow, res.subject);
    if (mode === "off") return { decision: null, output: {}, rule: null, summary: "", res };
    const ask = (id, label, why) => ({ decision: "ask", output: G.askOutput(`${why}: ${G.summarizeHit(null, res.subject)}`), rule: { id, label, severity: "warn" }, summary: G.summarizeHit(null, res.subject), res });
    if (res.timedOut) return ask("timeout", ASK_TIMEOUT, ASK_TIMEOUT);
    // a body cut at 2 MB whose target path was not in the part read (e.g. content before file_path, no jq)
    const hasPath = input && typeof input === "object" && (input.file_path || input.notebook_path);
    if (truncated && (G.FILE_TOOLS.includes(tool) || !tool) && !hasPath) return ask("no-path", ASK_NOPATH, ASK_NOPATH);
    if (res.hit) { const summary = G.summarizeHit(res.hit, res.subject); return { ...G.decide(mode, res, summary), rule: res.hit, summary, res }; }
    const slowBlock = res.slow.map(id => compiled.find(r => r.id === id)).find(r => r && r.severity === "block");
    if (slowBlock) return ask(slowBlock.id, slowBlock.label, ASK_SLOW);
    // part of the command was not seen by some rule (a user rule's 8,000-char window, over 256 KB, or a 2 MB body cut)
    if (tool === "Bash" && (res.cut || truncated)) return ask("too-long", ASK_LONG, ASK_LONG);
    return { decision: null, output: {}, rule: null, summary: "", res };
  }
  function handle(body, meta) {
    const b = body && typeof body === "object" ? body : {};
    const { cfg, compiled } = load();
    let tool = String(b.tool_name || "");
    // a cut body may have lost tool_name (it came after a huge content): judge by what was found
    if (!tool && b.__truncated === true && b.tool_input && typeof b.tool_input === "object") {
      const ti = b.tool_input;
      tool = typeof ti.command === "string" ? "Bash" : ti.notebook_path ? "NotebookEdit" : ti.file_path ? "Write" : "";
    }
    if (cfg.mode === "off") return {};
    // allowRepos only relaxes the file-path rules; Bash commands are checked everywhere
    if (G.FILE_TOOLS.includes(tool) && inRepo(b.cwd, cfg.allowRepos)) return {};
    const r = judge(tool, b.tool_input, cfg.mode, compiled, b.__truncated === true);
    if (!r.decision) return {};
    const entry = { at: now(), session_id: typeof b.session_id === "string" ? b.session_id.slice(0, 200) : "", tool: tool.slice(0, 64),
      rule: r.rule.id, label: r.rule.label, severity: r.rule.severity, decision: r.decision, summary: r.summary,
      cwd: typeof b.cwd === "string" ? b.cwd.slice(0, 500) : "", mode: cfg.mode };
    const record = (delivered) => {
      if (!delivered) entry.decision = "late-pass";   // the hook had given up: the call went through unchecked
      log(entry);
      try { opts.onHit && opts.onHit(entry); } catch {}
    };
    if (meta && typeof meta.settle === "function") meta.settle(record); else record(true);
    return G.outputAllowed(r.output) ? r.output : {};
  }
  // what to answer when judging itself failed: a question in block mode, otherwise nothing
  function failOutput() {
    let mode = "block"; try { mode = load().cfg.mode; } catch {}
    return mode === "block" ? G.askOutput(ASK_ERROR) : {};
  }
  return {
    handle(body, meta) { try { return handle(body, meta); } catch { return failOutput(); } },
    failOutput,
    // the settings page's "would this be caught?" box: nothing is logged; `mode` may be given to preview another mode
    test(tool, input, mode) {
      const { cfg, compiled } = load();
      const m = GUARD_MODES.includes(mode) ? mode : cfg.mode;
      const r = judge(String(tool || "Bash"), input, m, compiled, false);
      return { hit: r.rule, severity: r.rule ? r.rule.severity : null, decision: r.decision, summary: r.summary, mode: m, slow: r.res.slow, timedOut: r.res.timedOut, cut: r.res.cut };
    },
    // remote input from a teammate: every built-in command rule always (disabling one for agents does not open remote
    // input), plus the user's enabled rules; any hit blocks, whatever the mode; a timed-out check blocks too
    remote(text) {
      const { compiled } = load();
      const builtins = G.compileRules(G.defaultRules()).rules;
      const user = compiled.filter(r => !r.builtin);
      const res = G.evaluate("Bash", { command: String(text == null ? "" : text) }, [...builtins, ...user], { firstHit: true, run: runner });
      if (res.slow.length) noteSlow(res.slow, res.subject);
      if (res.timedOut) return { blocked: true, rule: "timeout", label: ASK_TIMEOUT };
      return res.hit ? { blocked: true, rule: res.hit.id, label: res.hit.label } : { blocked: false };
    },
    config() { const c = load(); return { ...c.cfg, errors: c.errors, fileError: c.fileError }; },
    reload() { cache = null; },
  };
}
