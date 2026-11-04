# Skillbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new 스킬북 page in AgentDesk that shows, as an open pixel-art book, every skill, plugin and MCP server installed for Claude Code, Codex and Gemini (plus `~/.agents/skills`), how much each is used, and lets the user turn them off/on, remove and restore them.

**Architecture:** Pure parsing and counting in `core/skillbook.js` (classic script + module, like `core/insight.js`). File-system work lives in a new `skillbook/` folder of main-process ES modules: `scan.mjs` (inventory), `usage.mjs` (persistent counter, one-time transcript backfill, hook feed), `actions.mjs` (reversible changes). `main.mjs` exposes two IPC calls; `widget.html` draws the book.

**Tech Stack:** Electron, Node ≥ 22 built-ins only (no new dependencies), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-04-skillbook-design.md` (mockups: `docs/superpowers/specs/skillbook-mockups/`)

## Global Constraints

- No new npm dependencies. TOML for `~/.codex/config.toml` is handled by a minimal section reader/remover in `core/skillbook.js`, not a library.
- **No secret values leave main**: for MCP servers the renderer receives name, agent, scope, repo, transport (`stdio` | `http` | `sse`), the command's basename and the *names* of env keys / headers — never values, args, URLs with query strings or full commands.
- Every write to a config file: re-read it right before writing, back up with `backupPrivate(file, ~/.roca/skillbook-backup, <base>.<Date.now()>)` (`perm/settings.mjs`), change only the one entry, write atomically (`writeJsonAtomic` for JSON; tmp + `renameSync` for TOML), keep unknown keys and order.
- Removed / turned-off things are restorable: `~/.roca/skillbook-removed.json` (entries kept 30 days) and `~/.roca/skillbook-parked.json` (turned-off MCP entries, kept until turned on). Skill folders go to the OS trash (`shell.trashItem`), turned-off skills move to a sibling `skills-disabled/` folder.
- Every destructive action asks for confirmation in the renderer before the IPC call.
- Korean UI strings get English entries in the widget `I18N` map; after editing the inline script run `node scripts/csp-hash.mjs --write`.
- Public repo: no company identifiers in tracked files (test fixtures use made-up names).
- Commits only when the owner says so. Before Task 1 the owner decides what happens to the uncommitted AI 활용 카드 / 픽셀 이펙트 work; this plan starts on a branch `skillbook` from that state.

## Review Focus

1. An MCP entry whose `env`, `args`, `headers` or URL hold a token → the IPC payload contains none of those strings (Task 2 test `scan never returns secret values`; Task 5 test `skillbook IPC payload has no secrets`).
2. A missing, empty or malformed config (bad JSON in `~/.claude.json`, no `~/.codex`, half-written TOML) → that source shows as unreadable, every other source still shows, nothing is written (Task 2 test `a broken source does not hide the others`).
3. The config changed between the scan and the click (Claude Code rewrote `~/.claude.json`) → the action re-reads, acts on the current file, and fails with `gone` if the entry is no longer there, never writing back stale content (Task 4 test `acting on an entry that disappeared fails without writing`).
4. Hundreds of MB of transcripts, or the app quitting mid-backfill → backfill streams line by line off the main thread's hot path, the cutoff time is fixed when it starts, and the "done" mark is written only at the end so a restart redoes it without double counting (Task 3 tests `backfill counts up to the cutoff only` and `an unfinished backfill is redone from scratch`).
5. The same skill name in several places (user, plugin `pixelfx:pixelfx`, shared, project) → each is its own item with its own id; usage is keyed by the name the agent records, so items with the same recorded name show the same count (Task 1 test `usage key for plugin and plain skills`).

---

### Task 1: Pure core — SKILL.md, TOML MCP sections, usage records, mastery

**Files:**
- Create: `core/skillbook.js`
- Test: `test/skillbook-core.test.mjs`

**Interfaces:**
- Produces (global `AgentDeskSkillbook` and `module.exports`):
  - `parseSkillMd(text: string) → { name: string|null, description: string, triggers: string[] }` — YAML front matter `name` / `description` (single line or `>`/`|` block); `triggers`: quoted phrases (`'…'`, `"…"`, `‘…’`, `“…”`) found in the description, at most 6, each ≤ 40 chars.
  - `tomlMcpServers(text: string) → [{ name: string, keys: string[], transport: 'stdio'|'http' }]` — sections `[mcp_servers.<name>]` (name may be quoted); `transport` is `http` when the section has `url`.
  - `tomlRemoveSection(text: string, name: string) → { text: string, removed: string|null }` — removes the section header and its lines up to the next `[` header; `removed` is the exact text taken out (for restore).
  - `usageFromRecord(rec) → [{ key: string, kind: 'skill'|'mcp', agent: string, at: number(ms), repo: string }]` — from a hook record `{ ts, agent?, ev }`: `PreToolUse` with `tool_name: 'Skill'` → key `tool_input.skill`; `PreToolUse` with `tool_name` `mcp__<server>__<tool>` → key `<server>`, kind `mcp`; `UserPromptSubmit` whose `prompt` matches `^/([\w:.-]+)` → key that name. `agent` = `rec.agent || 'claude'`; `repo` = basename of `ev.cwd`.
  - `usageFromTranscriptLine(line: string, agent = 'claude') → same shape` — a Claude Code transcript JSON line: `message.content[]` items `{ type: 'tool_use', name, input }` (same rules as above), user text starting with `/name` or containing `<command-name>/name</command-name>`; `at` from `timestamp`.
  - `mastery(n: number) → 0|1|2|3` — 0 for 0 uses, 1 for 1–4, 2 for 5–19, 3 for ≥ 20 (uses in the last 30 days).
  - `weekCount(byDay: Record<'YYYY-MM-DD', number>, now: number) → number` — the last 7 local days including today.

- [ ] **Step 1: Write the failing tests** in `test/skillbook-core.test.mjs` (`await import('../core/skillbook.js'); const S = globalThis.AgentDeskSkillbook;`):
  - `parseSkillMd reads front matter`: `S.parseSkillMd('---\nname: demo\ndescription: Does X. Use when someone says "do x" or \'run demo\'.\n---\nbody')` → `{ name: 'demo', description: 'Does X. Use when someone says "do x" or \'run demo\'.', triggers: ['do x', 'run demo'] }`; no front matter → `{ name: null, description: '', triggers: [] }`.
  - `toml sections`: for `'[mcp_servers.db]\ncommand = "x"\nenv = { K = "v" }\n\n[mcp_servers."remote one"]\nurl = "https://h/p"\n[profile]\na=1\n'`, `tomlMcpServers` → `[{ name: 'db', keys: ['command', 'env'], transport: 'stdio' }, { name: 'remote one', keys: ['url'], transport: 'http' }]`; `tomlRemoveSection(text, 'db').text` no longer contains `mcp_servers.db` but still contains `[profile]` and `remote one`; `.removed` starts with `[mcp_servers.db]`.
  - `usage key for plugin and plain skills`: a `PreToolUse` Skill record with `tool_input.skill: 'pixelfx:pixelfx'` → key `'pixelfx:pixelfx'`; with `'how'` → `'how'`; `mcp__mysql-test__mysql_query` → `{ key: 'mysql-test', kind: 'mcp' }`; prompt `'/agent-picker do it'` → key `'agent-picker'`; `PostToolUse` → `[]`.
  - `transcript lines`: an assistant line with a `tool_use` named `Skill` (`input.skill: 'orca-cli'`, `timestamp: '2026-11-01T10:00:00Z'`) → one usage with `at === Date.parse('2026-11-01T10:00:00Z')`; a user line with `<command-name>/teach</command-name>` → key `'teach'`; a garbage line → `[]`.
  - `mastery and week`: `mastery(0) === 0`, `mastery(4) === 1`, `mastery(5) === 2`, `mastery(20) === 3`; `weekCount({ [today]: 2, [6 days ago]: 1, [7 days ago]: 9 }, now) === 3`.

- [ ] **Step 2: Run** `node --test test/skillbook-core.test.mjs` — expected FAIL (`Cannot find module` / undefined).
- [ ] **Step 3: Implement `core/skillbook.js`** with the header comment style of `core/insight.js` (one line per export) and the same IIFE + `globalThis` + `module.exports` wrapper. No I/O.
- [ ] **Step 4: Run** `node --test test/skillbook-core.test.mjs` — expected PASS.
- [ ] **Step 5: Commit** `core/skillbook.js test/skillbook-core.test.mjs` — `feat(skillbook): core parsers and usage records`.

### Task 2: Inventory scan

**Files:**
- Create: `skillbook/scan.mjs`
- Test: `test/skillbook-scan.test.mjs`

**Interfaces:**
- Consumes: `parseSkillMd`, `tomlMcpServers` (Task 1, via `createRequire` or `import '../core/skillbook.js'`).
- Produces: `scanInventory({ home: string, repos: string[] }) → { items: Item[], sources: [{ id: string, label: string, ok: boolean, error?: string }] }` where
  `Item = { id, kind: 'skill'|'plugin'|'mcp', name, agents: ('claude'|'codex'|'gemini')[], source: 'user'|'plugin'|'shared'|'project'|'extension', repo?: string, path?: string, description: string, triggers: string[], on: boolean, usageKey: string, mcp?: { transport, command?: string /* basename only */, envKeys: string[], scope: 'user'|'project' }, plugin?: { marketplace: string, version?: string } }`.
  `id` = `${kind}:${source}:${agent-or-shared}:${repo||''}:${name}` (stable across scans). `usageKey`: skill → its recorded name (plugin skills `plugin:skill`), MCP → server name.
- Sources read (spec "Constraints"): `~/.claude/skills/*/SKILL.md` (+ `~/.claude/skills-disabled/*` as `on: false`), `~/.claude/plugins/installed_plugins.json` with `enabledPlugins` from `~/.claude/settings.json`, plugin skills under each installed plugin's `skills/*/SKILL.md`, `~/.claude.json` `mcpServers` and `projects[repo].mcpServers` (only for `repos`), `<repo>/.mcp.json`, `<repo>/.claude/skills`, `~/.agents/skills` (+ `skills-disabled`, agents: all three), `~/.codex/config.toml` MCP, `~/.codex/skills` if it exists, `~/.gemini/settings.json` `mcpServers`, `~/.gemini/extensions/*` (`gemini-extension.json` name/description), plus parked MCP entries from `~/.roca/skillbook-parked.json` as `on: false`.

- [ ] **Step 1: Write the failing tests** — build a temp home with `mkdtempSync` holding one of each source (made-up names), then:
  - `finds every kind`: items include a user skill, a plugin skill, a shared skill with `agents: ['claude','codex','gemini']`, a project skill with `repo`, user and project MCP servers, a Codex MCP from TOML and a Gemini MCP; a plugin missing from `enabledPlugins` has `on: false`.
  - `scan never returns secret values`: MCP fixtures contain `env: { API_TOKEN: 'sk-SECRET1' }`, `args: ['--key', 'sk-SECRET2']`, `headers: { Authorization: 'Bearer sk-SECRET3' }`, `url: 'https://h/mcp?token=sk-SECRET4'`; `JSON.stringify(scanInventory(...))` contains none of `sk-SECRET`, and `envKeys` equals `['API_TOKEN']`.
  - `a broken source does not hide the others`: `~/.claude.json` is `'{not json'` and `~/.codex` is missing → its source has `ok: false`, skills still listed, no file mtime changed.
  - `only listed repos`: a `projects` entry for a repo not in `repos` contributes nothing.
- [ ] **Step 2: Run** `node --test test/skillbook-scan.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement `scanInventory`** in `skillbook/scan.mjs` — synchronous reads with try/catch per source; never follow symlinks out of the scanned roots for SKILL.md reads larger than 64 KB (read the first 64 KB).
- [ ] **Step 4: Run** the test file — expected PASS.
- [ ] **Step 5: Commit** `skillbook/scan.mjs test/skillbook-scan.test.mjs` — `feat(skillbook): inventory scan across agents`.

### Task 3: Usage store, backfill and hook feed

**Files:**
- Create: `skillbook/usage.mjs`
- Test: `test/skillbook-usage.test.mjs`

**Interfaces:**
- Consumes: `usageFromRecord`, `usageFromTranscriptLine`, `mastery`, `weekCount` (Task 1).
- Produces: `createUsageStore({ file: string, now?: () => number })` → `{ load(): void, add(u): void, addRecord(rec): void, save(): void, get(key): { total, byDay, lastAt, lastRepo, byAgent } | null, cutoff(): number|null, backfillDone(): boolean }` and `backfill(store, { roots: string[], cutoff: number, onProgress? }) → Promise<{ files: number, uses: number }>`.
  - File format `~/.roca/skillbook-usage.json`: `{ v: 1, cutoff: ms|null, backfilled: boolean, keys: { [key]: { total, byDay: {YYYY-MM-DD: n} /* last 60 days */, lastAt, lastRepo, byAgent: {agent: n} } } }`, written atomically, mode 0600.
  - `addRecord(rec)` counts only records with `ts*1000 > cutoff` (before the backfill has a cutoff, it counts everything — backfill then sets the cutoff to its start time and only counts transcript uses `≤ cutoff`).
  - `backfill` reads `roots` (`~/.claude/projects`) `*.jsonl` files line by line with `readline` over `createReadStream`, awaiting between files; it starts from a fresh `keys` copy so a redo never double counts, merges on success and sets `backfilled: true` last.
- [ ] **Step 1: Write the failing tests** with a temp dir and two transcript files:
  - `backfill counts up to the cutoff only`: uses at cutoff−1 h and cutoff+1 h → only the first is counted; then `addRecord` for a hook record at cutoff+1 h counts it once.
  - `an unfinished backfill is redone from scratch`: a store file with `backfilled: false` and some counts → `backfill` again yields the same totals as a single clean run.
  - `byDay keeps 60 days and week counts`: adds at now and now−61 d → `byDay` has only today; `weekCount` of it is 1.
  - `get unknown key`: `null`.
- [ ] **Step 2: Run** `node --test test/skillbook-usage.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** `skillbook/usage.mjs` as specified.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `skillbook/usage.mjs test/skillbook-usage.test.mjs` — `feat(skillbook): usage store and transcript backfill`.

### Task 4: Reversible actions

**Files:**
- Create: `skillbook/actions.mjs`
- Test: `test/skillbook-actions.test.mjs`

**Interfaces:**
- Consumes: `scanInventory` item shape (Task 2), `tomlRemoveSection` (Task 1), `readJsonStrict`, `writeJsonAtomic`, `backupPrivate` (`perm/settings.mjs`).
- Produces: `actOn({ home, item, action, trash, run }) → Promise<{ ok: true } | { ok: false, error: 'gone'|'unsupported'|'failed', detail?: string }>` where `action ∈ 'off'|'on'|'remove'|'restore'`, `trash(path) → Promise<void>` (main passes `shell.trashItem`), `run(cmd, args) → Promise<{ code, stdout, stderr }>` (main passes an `execFile` wrapper). Also `listRemoved({ home, now }) → [{ id, kind, name, removedAt, how }]` (entries older than 30 days dropped on read).
  - Skills: `off` moves the folder to the sibling `skills-disabled/<name>`; `on` moves it back; `remove` → `trash(path)` and a removed entry `{ how: 'trash', path }` (restore = tell the user to restore from the OS trash: returns `{ ok: false, error: 'unsupported', detail: 'trash' }`).
  - Plugins: `off`/`on` → `run('claude', ['plugin', 'disable'|'enable', '<name>@<marketplace>'])`; `remove` → `run('claude', ['plugin', 'uninstall', …])` + removed entry `{ how: 'plugin', name, marketplace }`; `restore` → `run('claude', ['plugin', 'install', '<name>@<marketplace>'])`.
  - MCP (JSON sources `~/.claude.json` user/project, `<repo>/.mcp.json`, `~/.gemini/settings.json`; TOML `~/.codex/config.toml`): `off` takes the entry out (backup first) into `skillbook-parked.json`; `on` writes it back; `remove` takes it out into `skillbook-removed.json`; `restore` writes it back. The entry text/object is stored verbatim in those `~/.roca` files (mode 0600) — they hold secrets and are never sent to the renderer.
- [ ] **Step 1: Write the failing tests** (temp home, fake `trash`/`run` that record calls):
  - `skill off and on`: folder moves to `skills-disabled` and back; content unchanged.
  - `mcp off parks and on restores byte-for-byte`: JSON user-scope server and a Codex TOML section; after `off` the file lacks it, a backup exists in `~/.roca/skillbook-backup`, unrelated keys/sections are identical; after `on` the parsed config deep-equals the original (TOML: text equal).
  - `acting on an entry that disappeared fails without writing`: delete the entry from the file after scanning, `actOn(... 'off')` → `{ ok: false, error: 'gone' }` and file mtime unchanged.
  - `plugin actions call the CLI`: `off` → `run` called with `['plugin','disable','demo@market']`; `remove` then `restore` → `uninstall` then `install`.
  - `removed list expires`: an entry dated 31 days ago is not returned by `listRemoved`.
- [ ] **Step 2: Run** `node --test test/skillbook-actions.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** `skillbook/actions.mjs`.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `skillbook/actions.mjs test/skillbook-actions.test.mjs` — `feat(skillbook): reversible off / remove / restore`.

### Task 5: Main-process wiring

**Files:**
- Modify: `main.mjs` (imports near the other `perm/` / `statusline/` imports; feed in `readNewEvents` next to `timelineIndex.add(o)` around line 1229; new IPC after `roca:insight` around line 2367; start the backfill after the window loads)
- Modify: `preload.cjs` (after `insight:` around line 78)
- Modify: `package.json` (`build.files`: add `"skillbook/**/*"`)
- Test: `test/skillbook-ipc.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - IPC `roca:skillbook` → `{ ok: true, items: (Item & { uses: { week: number, month: number, total: number, mastery: 0|1|2|3, counted: boolean, lastAt?: number, lastRepo?: string, byAgent?: object } })[], sources, removed, backfill: 'running'|'done' }`. `counted` is false for items whose agents are only `codex`/`gemini` (renderer shows "사용 기록 없음"). `repos` = cwd basenames' full paths of sessions seen in the last 30 days (`knownSessions` / hook records) plus open sessions.
  - IPC `roca:skillbook-act` `({ id: string, action })` → `actOn` result; the item is looked up by `id` in a fresh `scanInventory` (never trusted from the renderer). One more action, `reveal`, handled here (not in `actOn`): `shell.showItemInFolder(item.path)` for items that have a `path` — there is no generic open-path IPC and none is added.
  - Preload: `skillbook: () => ipcRenderer.invoke("roca:skillbook")`, `skillbookAct: (req) => ipcRenderer.invoke("roca:skillbook-act", req)`.
  - Usage store at `~/.roca/skillbook-usage.json`; `addRecord` called for every new hook record; `backfill` runs once (when `!backfillDone()`) over `~/.claude/projects` without blocking startup.
- [ ] **Step 1: Write the failing test** `skillbook IPC payload has no secrets` — import the payload builder (export a pure `skillbookPayload({ inventory, store, removed, now })` from `skillbook/usage.mjs` or a small `skillbook/payload.mjs`) with the secret fixtures of Task 2 and assert `JSON.stringify(payload)` has no `sk-SECRET`; `counted` false for a Codex-only MCP; `mastery` and `month` from the 30-day sum. Add a source check: `main.mjs` registers `roca:skillbook` and `roca:skillbook-act`, `preload.cjs` exposes `skillbook` and `skillbookAct`, `package.json` lists `skillbook/**/*`.
- [ ] **Step 2: Run** `node --test test/skillbook-ipc.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** the payload builder and the wiring. `roca:skillbook-act` validates `id` (string ≤ 300, no control chars) and `action` (`off`, `on`, `remove`, `restore` or `reveal`).
- [ ] **Step 4: Run** the test, then `node --check main.mjs preload.cjs` — expected PASS / no output.
- [ ] **Step 5: Commit** `main.mjs preload.cjs package.json skillbook/ test/skillbook-ipc.test.mjs` — `feat(skillbook): IPC and usage feed`.

### Task 6: The book page

**Files:**
- Modify: `widget.html` — nav button after `data-page="jira"` (line ~1845): `<button class="page-nav-btn" data-page="skillbook">스킬북</button>`; page `<div class="page" id="page-skillbook">` next to `page-jira`; `PAGE_SIZES.skillbook = { w: 640, h: 560 }`; `showPage` calls `skillbookLoad()` for it; CSS and render code; `I18N` entries.
- Modify: `README.md`, `README.ko.md` (one feature bullet each, same structure, plus the settings/data files it writes in `~/.roca`).
- Test: `test/skillbook-ui.test.mjs`

**Interfaces:**
- Consumes: `window.orca.skillbook()`, `window.orca.skillbookAct({ id, action })` (Task 5).
- Produces (renderer): `skillbookLoad()`, `skillbookRender()`, state `sbState = { agent: 'all'|'claude'|'codex'|'gemini', tab: 'skill'|'plugin'|'mcp'|'usage', period: 7|30|0, picked: Set<string>, sel: string|null, data }`.
- Look and copy (from `skillbook-mockups/skillbook-layout.html` option A and `skillbook-mcp.html`): leather book with two parchment pages, Galmuri9 font, tabs `스킬 N` / `플러그인 N` / `🧰 도구 주머니 N`, agent filter `전체 · Claude · Codex · Gemini` above the tabs; index rows: icon, name, stars `★`–`★★★` or `미사용` (counted, 0) or `사용 기록 없음` (not counted); MCP rows a green/grey dot and the repo name for project scope; right page: big icon, name, stars + `이번 주 N회`, `하는 일`, `이렇게 말하면 켜짐` (trigger chips), `출처`, `최근`, `쓸 수 있는 에이전트`, buttons `켜짐/꺼짐` (toggle), `폴더 열기` (items with a path: `skillbookAct({ id, action: 'reveal' })`), `삭제`/`제거`. Below the index: `최근 제거 N` (collapsible) with `되살리기`. **📊 사용 기록 tab** (`skillbook-mockups/skillbook-usage-page.html`, option B): fourth tab; left page lists countable items of the current agent filter across all kinds, sorted by count, with a 10-cell gauge (cells = round(10 × n / max), class by mastery) and `N회`, period switch `7일 · 30일 · 전체` (default 30일; 7/30 from `byDay`, 전체 from `total`); right page `💤 안 쓰는 것` + count ribbon, rows with 0 in the period (dimmed, selectable), buttons `고른 것 끄기` / `휴지통으로` — one confirm for the batch, then `skillbookAct` per item in sequence, a summary toast with failures; uncountable items left out with the note `Codex·Gemini 전용 항목은 사용 기록을 셀 수 없어 빠졌습니다`. Empty agent: `아직 설치된 것이 없습니다` (the Shop link comes with project 2). Never-used rows are visibly dimmer. While `backfill === 'running'`: a small line `사용 기록을 읽는 중…`.
- Destructive buttons use the widget's existing confirm pattern (in-page confirm row, not `window.confirm`).
- [ ] **Step 1: Write the failing tests** (source checks like `test/office-fx.test.mjs`): the nav button and `#page-skillbook` exist; `PAGE_SIZES` has `skillbook`; `showPage` loads it; the four filter values and three tabs appear in the render code; the 📊 사용 기록 tab exists with the three periods and both bulk buttons, and the bulk remove goes through one confirm; `skillbookAct` is only called after a confirm for `remove`; every new Korean string has an I18N entry (`node scripts/i18n-check.mjs` passes).
- [ ] **Step 2: Run** `node --test test/skillbook-ui.test.mjs` — expected FAIL.
- [ ] **Step 3: Implement** the page; run `node scripts/csp-hash.mjs --write`.
- [ ] **Step 4: Run** `node --test test/skillbook-ui.test.mjs && node scripts/i18n-check.mjs && npm test` — expected all pass.
- [ ] **Step 5: See it in the real app**: quit the running AgentDesk, start Electron with `--remote-debugging-port` (as `scripts/shots.mjs` does, `ROCA_START_PAGE="skillbook"`), capture the page with real data; check: no secret text visible, never-used rows dimmed, the MCP tab shows dots, turning a test skill off/on in a temp copy works. Restart AgentDesk normally afterwards.
- [ ] **Step 6: Commit** `widget.html README.md README.ko.md test/skillbook-ui.test.mjs` — `feat(skillbook): the book page`.
