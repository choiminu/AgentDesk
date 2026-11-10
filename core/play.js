// AgentDesk core: the dock's play layer, pure helpers over the hook event log. No DOM, no Electron, no I/O.
// Loaded as a classic <script> (global AgentDeskPlay) or required from tests.
//
//   kindOf(tool, toolInput)        → 'code' | 'docs' | 'read' | 'web' | 'shell' | 'agents' | 'skill' | 'mcp' | 'think'
//   feed(map, rec)                 → fold one hook record ({ ts, ev }) into map (sid → play state), returns the state or null
//   failCount(text)                → how many tests a runner's output says failed (0 when it names none)
//   isTestCmd(command)             → a shell command that runs a test suite
//   jobOf(counts)                  → { id, level, total } | null   what the session mostly does, once it has done enough
//   fatigue(ctxPct, compacting)    → '' | 'sweat' | 'coffee'
//   clashes(map, now, windowMs)    → [{ path, sids: [a, b] }]   live sessions that changed the same file inside the window
//   replaySteps(trail, max)        → [{ k, fail, n }]   the trail folded (runs of one kind) and thinned to at most max steps
//   noteOf(ps)                     → { sid, cwd, agent, text, edits, tools, tests, at } | null   what an ended session leaves
//
// A play state: { sid, cwd, agent, counts, total, trail, boss, files, compacting, revivedAt, prompt, ended, endedAt, tests }
//   boss: null | { hp, max, at, downAt }   hp = failing tests of the last failed run; downAt set when a run passed after it
(function (root) {
'use strict';

const DOC_RE = /\.(md|mdx|markdown|txt|rst|adoc)(\b|$)|(^|\/)(docs?|doc|wiki|documentation|obsidian|notes?)\/|README|CHANGELOG|CONTRIBUTING|LICENSE/i;
const KINDS = ['code', 'docs', 'read', 'web', 'shell', 'agents', 'skill', 'mcp'];
const TRAIL_MAX = 400, FILES_MAX = 60;

function kindOf(tool, toolInput) {
  const t = tool ? String(tool) : '', base = t.split(/[\s:(]/)[0];
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(base)) return DOC_RE.test(`${toolInput || ''} ${t}`) ? 'docs' : 'code';
  if (/^(Read|Grep|Glob|LS|NotebookRead|Search|Explore)$/.test(base)) return 'read';
  if (/^(WebFetch|WebSearch)$/.test(base)) return 'web';
  if (/^(Bash|Shell|Run|BashOutput|KillShell)$/.test(base)) return 'shell';
  if (/^(Task|Agent)$/.test(base)) return 'agents';
  if (base === 'Skill') return 'skill';
  if (/^mcp__/.test(base)) return 'mcp';
  return 'think';
}

// a command that runs tests: the usual runners, as a word of the command (not a path fragment such as "test/")
const TEST_RE = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test)\b|node\s+--test\b|(python3?\s+-m\s+)?pytest\b|python3?\s+-m\s+unittest\b|go\s+test\b|cargo\s+(test|nextest)\b|(\.\/)?(gradlew|gradle|mvnw|mvn)\s+[^;&|]*\btest\b|dotnet\s+test\b|rspec\b|phpunit\b|make\s+(test|check)\b|deno\s+test\b|swift\s+test\b)/;
// quoted text is left out first: a commit message or a script argument that only mentions a runner is not a test run
const isTestCmd = c => typeof c === 'string' && c.length < 4000 && TEST_RE.test(c.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' '));

// failing tests named by the output: the largest count any known summary line gives (the tail is where summaries are)
function failCount(text) {
  const s = String(text == null ? '' : text).slice(-6000);
  let n = 0;
  const take = v => { const k = Number(v); if (Number.isFinite(k) && k > n) n = Math.min(999, k); };
  for (const re of [
    /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/gi,          // node --test / TAP
    /(\d+)\s+fail(?:ed|ing|ures?)\b/gi,              // jest, vitest, pytest, mocha, rspec
    /\bfail(?:ed|ures)?\s*[:=]\s*(\d+)/gi,           // "Failures: 2", "failed=2"
    /\bTests run:\s*\d+,\s*Failures:\s*(\d+)/gi,     // maven / gradle
  ]) for (const m of s.matchAll(re)) take(m[1]);
  if (!n) { const m = s.match(/^(--- FAIL|FAIL)\b.*$/gm); if (m) take(m.length); }   // go test, jest file lines
  return n;
}

const clip = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function absPath(file, cwd) {
  const f = String(file || '').replace(/\\/g, '/').trim(); if (!f) return '';
  if (f.startsWith('/') || /^[A-Za-z]:\//.test(f)) return f;
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return c ? `${c}/${f.replace(/^\.\//, '')}` : '';
}

function feed(map, rec) {
  const ev = rec && rec.ev; if (!ev || typeof ev !== 'object') return null;
  const sid = typeof ev.session_id === 'string' ? ev.session_id : ''; if (!sid) return null;
  const ts = (Number(rec.ts) || 0) * 1000;
  let ps = map.get(sid);
  if (!ps) { ps = { sid, cwd: '', agent: 'claude', counts: {}, total: 0, trail: [], boss: null, files: [], compacting: false, revivedAt: 0, prompt: '', ended: false, endedAt: 0, tests: { pass: 0, fail: 0 }, last: 0 }; map.set(sid, ps); }
  if (typeof ev.cwd === 'string' && ev.cwd) ps.cwd = ev.cwd;
  if (rec.agent) ps.agent = String(rec.agent);
  ps.last = Math.max(ps.last, ts);
  const sub = !!ev.agent_id, tool = typeof ev.tool_name === 'string' ? ev.tool_name : '', input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const name = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', PreCompress: 'PostCompact' }[ev.hook_event_name] || ev.hook_event_name;
  switch (name) {
    case 'SessionStart': ps.ended = false; break;
    case 'UserPromptSubmit':
      ps.ended = false;
      if (typeof ev.prompt === 'string' && !/^\s*<(command-name|local-command|system-reminder)/.test(ev.prompt)) { const p = clip(ev.prompt, 90); if (p) ps.prompt = p; }
      break;
    case 'PreToolUse': {
      if (sub) break;
      const k = kindOf(tool, input.file_path || input.path || input.notebook_path || '');
      if (k !== 'think') { ps.counts[k] = (ps.counts[k] || 0) + 1; ps.total++; }
      ps.trail.push({ k, f: 0 }); if (ps.trail.length > TRAIL_MAX) ps.trail.splice(0, ps.trail.length - TRAIL_MAX);
      break;
    }
    case 'PostToolUse': {
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        const p = absPath(input.file_path || input.notebook_path, ps.cwd);
        if (p) { ps.files = ps.files.filter(x => x.path !== p); ps.files.push({ path: p, at: ts }); if (ps.files.length > FILES_MAX) ps.files.shift(); }
      }
      if (!sub && tool === 'Bash' && isTestCmd(input.command)) {
        const r = ev.tool_response, out = r && typeof r === 'object' ? `${r.stdout || ''}\n${r.stderr || ''}` : String(r || '');
        const n = failCount(out);
        if (n) bossHit(ps, n, ts); else { ps.tests.pass++; if (ps.boss && !ps.boss.downAt) { ps.boss.hp = 0; ps.boss.downAt = ts; } }
      }
      break;
    }
    case 'PostToolUseFailure':
      if (sub) break;
      if (ps.trail.length) ps.trail[ps.trail.length - 1].f = 1;
      if (tool === 'Bash' && isTestCmd(input.command) && !ev.is_interrupt) bossHit(ps, failCount(ev.error) || 1, ts);
      break;
    case 'PreCompact': ps.compacting = true; break;
    case 'PostCompact': ps.revivedAt = ts; ps.compacting = false; break;
    case 'Stop': case 'Interrupt': case 'StopFailure': ps.compacting = false; break;
    case 'SessionEnd': ps.ended = true; ps.endedAt = ts; ps.compacting = false; break;
  }
  return ps;
}
function bossHit(ps, n, ts) {
  ps.tests.fail++;
  const live = ps.boss && !ps.boss.downAt;
  ps.boss = { hp: n, max: live ? Math.max(ps.boss.max, n) : n, at: live ? ps.boss.at : ts, downAt: 0 };
}

// what a session mostly does: a kind holding 40 % of at least 12 tool calls; the level doubles with the work done
const JOBS = { shell: 'hacker', read: 'scholar', code: 'smith', docs: 'scribe', web: 'explorer', agents: 'commander', skill: 'mage', mcp: 'operator' };
const JOB_MIN = 12;
function jobOf(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  let total = 0, top = '', best = 0;
  for (const k of KINDS) { const n = Math.max(0, Number(c[k]) || 0); total += n; if (n > best) { best = n; top = k; } }
  if (total < JOB_MIN || best / total < 0.4) return null;
  return { id: JOBS[top], kind: top, level: Math.min(9, 1 + Math.floor(Math.log2(total / JOB_MIN))), total };
}

function fatigue(ctxPct, compacting) {
  if (compacting) return 'coffee';
  const c = Number(ctxPct);
  return ctxPct != null && Number.isFinite(c) && c >= 70 ? 'sweat' : '';
}

function clashes(map, now, windowMs) {
  const byPath = new Map();
  for (const ps of map.values()) {
    if (ps.ended) continue;
    for (const f of ps.files) if (now - f.at <= windowMs && now - f.at >= 0) { const l = byPath.get(f.path) || []; l.push({ sid: ps.sid, at: f.at }); byPath.set(f.path, l); }
  }
  const out = [], seen = new Set();
  for (const [path, l] of byPath) {
    if (l.length < 2) continue;
    l.sort((a, b) => b.at - a.at);
    const sids = [l[0].sid, l[1].sid].sort(), key = sids.join('|');
    if (seen.has(key)) continue;   // one clash per pair: its most recently touched file comes first below
    seen.add(key); out.push({ path, sids, at: l[0].at });
  }
  return out.sort((a, b) => b.at - a.at);
}

function replaySteps(trail, max) {
  const m = Math.max(1, Number(max) || 40), runs = [];
  for (const x of Array.isArray(trail) ? trail : []) {
    const last = runs[runs.length - 1];
    if (last && last.k === x.k && !x.f && !last.fail) last.n++;
    else runs.push({ k: x.k, fail: !!x.f, n: 1 });
  }
  if (runs.length <= m) return runs;
  const out = [];   // thin evenly, never dropping a failed step
  for (let i = 0; i < runs.length; i++) if (runs[i].fail || Math.floor(i * m / runs.length) !== Math.floor((i - 1) * m / runs.length)) out.push(runs[i]);
  return out.slice(-m * 2);
}

function noteOf(ps) {
  if (!ps || !ps.sid || !ps.cwd || !ps.total) return null;
  return { sid: ps.sid, cwd: ps.cwd, agent: ps.agent || 'claude', text: ps.prompt || '', edits: new Set(ps.files.map(f => f.path)).size, tools: ps.total, tests: { pass: ps.tests.pass, fail: ps.tests.fail }, at: ps.endedAt || ps.last };
}

const AgentDeskPlay = { kindOf, feed, failCount, isTestCmd, jobOf, fatigue, clashes, replaySteps, noteOf, KINDS, JOBS, JOB_MIN };
root.AgentDeskPlay = AgentDeskPlay;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentDeskPlay;
})(typeof globalThis !== 'undefined' ? globalThis : this);
