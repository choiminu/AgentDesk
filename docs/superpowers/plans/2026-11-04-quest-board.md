# Quest Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jira tickets shown as quests on the Jira page and in a dock panel, assignable to one of my idle sessions or a new worktree, with a 자동 button where a headless "front desk" proposes the assignee and the owner confirms; assigned agents get a quest marker in the office.

**Architecture:** Pure logic in `core/quest.js` (grouping, difficulty, party eligibility, proposal validation, prompt building). Main gets `quest/state.mjs` (`~/.roca/quests.json`) and `quest/desk.mjs` (the headless call). The renderer reuses the existing Jira module (`jiraLoad`, `jiraIssues`, `jiraWorktreeModal(key)`, `jiraSessionModal(key)`, `jiraCapture`) and the dock-panel pattern of the Skillbook (📖).

**Tech Stack:** Electron, Node ≥ 22, `claude -p` headless (as `recall/lib.mjs` does), `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-quest-board-design.md` (its "Settled after review" section is binding)

## Global Constraints

- Party = my live interactive sessions (`sessions` where `connected && handles.get(s.id) && !s.isSub`, not teammates'); selectable only when status is input-waiting or done; working / permission-waiting ones are listed disabled with `작업 중`.
- Quest groups: AgentDesk state wins (`assigned` → 진행 중, `reportAt` → 보고 대기); otherwise Jira `statusCategory.key`: `new` → 새 퀘스트, `indeterminate` → 진행 중, `done` → 완료.
- Difficulty from Jira priority name: Highest ★★★, High ★★★, Medium ★★, Low ★, Lowest ★, none → no mark, any other name → ★★.
- State file `~/.roca/quests.json` (mode 0600, atomic writes): `{ v: 1, quests: { [ticketKey]: { kind: 'session'|'worktree', sessionId?, repo?, at, reportAt? } } }`; entries for tickets done in Jira more than 30 days ago are pruned.
- Front desk: `claude -p --model ${AGENTDESK_QUEST_MODEL || 'haiku'} --output-format json --json-schema <schema> --system-prompt <...> --disable-slash-commands --disallowedTools Bash Edit Write Read Glob Grep WebFetch WebSearch Agent Task`, input via stdin, timeout 90 s, cancellable; all text sent (ticket, session names, repos, branches, summaries) goes through the existing outbound masking (`core/mask.js`); answer schema `{ choice: { kind: 'session', id } | { kind: 'worktree', repo }, reason }`; the answer is accepted only if `id` is in the eligible party list or `repo` is in the known repo list; proposals cached per ticket 10 minutes; nothing dispatches without the owner's click.
- Dispatch uses the existing modals: session → `jiraSessionModal(key)` preselecting the session; worktree → `jiraWorktreeModal(key)` preselecting the repo. Recording the assignment happens when the modal's send succeeds.
- Jira fields: the board fetch (`BOARD_FIELDS` in `jira-oauth.mjs`) already has `priority` and `duedate`; nothing new to fetch. Orca-CLI fallback shows whatever fields it has.
- UI copy in Korean with `I18N` English entries; user text via `esc()`; `node scripts/csp-hash.mjs --write` after editing the inline script.
- Office marker only for assigned sessions that have a desk; shown until `reportAt` or the session ends.

## Review Focus

1. The model returns a session id or repo that isn't in the lists, junk JSON, or times out → "직접 고르세요" with the normal picker, no dispatch (Task 2 tests).
2. Jira disconnected / board never loaded when the dock panel opens → the same sign-in / loading message as the Jira page, no crash (Task 4 test).
3. A quest assigned to a session that has since ended → the card shows the assignment as `종료됨`, the marker disappears, the quest can be reassigned (Task 1 test `ended session frees the quest`).
4. Ticket text with secrets or company identifiers → masked before the headless call (Task 2 test `desk input is masked`).
5. Two quickly repeated 자동 clicks → one call in flight, the second shows the pending state (Task 2 test `one desk call per ticket at a time`).

---

### Task 1: Core quest logic (pure)

**Files:** Create `core/quest.js`; Test `test/quest-core.test.mjs`

**Interfaces:**
- Produces (`globalThis.AgentDeskQuest` + `module.exports`, IIFE like `core/skillbook.js`):
  - `difficulty(priorityName) → 0|1|2|3`
  - `groupOf(issue, state, liveIds: Set) → 'new'|'doing'|'report'|'done'` (`state` = this ticket's entry or undefined; an entry whose `sessionId` is not in `liveIds` and has no `reportAt` counts as unassigned and is marked `ended: true` by `questView`)
  - `questView(issues, stateFile, liveIds) → [{ key, title, difficulty, group, status, due?, assignee?, quest?: { kind, sessionId?, repo?, at, reportAt?, ended? } }]`
  - `partyOf(sessions, handles) → [{ id, name, repo, branch, status, eligible: boolean, doing: string, skills: string[] }]` (`doing` = the dashboard's one-line summary field; `skills` from the session's recent Skill uses — input passed in, not computed here)
  - `deskPrompt(issue, party, repos) → string` and `DESK_SCHEMA` (JSON schema string)
  - `acceptProposal(answer, party, repos) → { kind:'session', id } | { kind:'worktree', repo } | null`
- [ ] **Step 1: Failing tests** for each function with the Global Constraints values: difficulty table; grouping incl. state-wins and `ended session frees the quest`; party eligibility (input/done eligible, running/permission not, teammates and subagents excluded); `acceptProposal` rejects unknown ids/repos and junk.
- [ ] **Step 2: Run** `node --test test/quest-core.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `core/quest.js`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(quest): 퀘스트 핵심 로직 — 그룹·난이도·파티·제안 검증`.

### Task 2: Quest state and front desk (main)

**Files:** Create `quest/state.mjs`, `quest/desk.mjs`; Modify `main.mjs` (IPC), `preload.cjs`, `package.json` (`build.files` + `"quest/**/*"`); Test `test/quest-main.test.mjs`

**Interfaces:**
- Consumes: `core/quest.js` (`deskPrompt`, `DESK_SCHEMA`, `acceptProposal`), `core/mask.js`.
- Produces:
  - `createQuestState({ file, now }) → { load(), get(key), set(key, entry), report(key, at), drop(key), all(), prune(doneKeys) }` (atomic 0600 writes).
  - `askDesk({ issue, party, repos, run, signal }) → Promise<{ ok: true, choice, reason } | { ok: false, error: 'timeout'|'invalid'|'failed'|'cancelled' }>` — `run(input) → Promise<{ code, stdout }>` injected (main spawns `claude` with the args from Global Constraints, stdin = masked prompt); one call per ticket at a time; 10-minute cache per ticket.
  - IPC (preload names): `roca:quest-state` → `all()` (`questState`); `roca:quest-assign` `({ key, kind, sessionId?, repo? })` → `{ ok }` (`questAssign`); `roca:quest-report` `({ key })` (`questReport`); `roca:quest-desk` `({ key, issue, party, repos })` → `askDesk` result (`questDesk`); `roca:quest-desk-cancel` `({ key })` (`questDeskCancel`). Inputs validated (key `^[A-Z][A-Z0-9_]*-\d+$`, ids/repos strings ≤ 300 without control characters).
- [ ] **Step 1: Failing tests**: state round trip, mode 0600, prune; `desk input is masked` (a fake `run` receives no token-like string present in the ticket description); invalid/unknown answers → `invalid`; timeout → `timeout`; `one desk call per ticket at a time` (two calls → one `run`); cache 10 min; source checks for the IPC names, preload and `quest/**/*` in build.files.
- [ ] **Step 2: Run** `node --test test/quest-main.test.mjs` — FAIL.
- [ ] **Step 3: Implement**; `node --check main.mjs preload.cjs`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(quest): 퀘스트 상태 저장과 프런트데스크(자동 배정 제안)`.

### Task 3: Quest view on the Jira page

**Files:** Modify `widget.html` (Jira page: a `퀘스트` view switch next to the existing list/board mode — see `jiraSetMode`; quest cards; party picker; 자동; hooks into `jiraSessionModal`/`jiraWorktreeModal` success to call `questAssign`, and into `jiraCapture` to call `questReport`), `README.md`, `README.ko.md`; Test `test/quest-ui.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`questView`, `partyOf`), Task 2 IPC.
- Produces: `questRender(root)` (renders into a given container; used by Task 4), `questOpenPicker(key)`, `questAuto(key)`.
- Look: four columns or stacked groups `새 퀘스트 · 진행 중 · 보고 대기 · 완료`; a card = difficulty stars, key, title, due date, assignee/party member (or `종료됨`), buttons `맡기기` (opens the party picker: eligible sessions first with repo, `doing`, recent skills chips; disabled ones `작업 중`; last row `새 워크트리에서 시작`) and `자동` (spinner + `취소`; then a proposal row `⟶ <session or repo> · <reason>` with `맡기기` / `다른 사람`); errors → `직접 고르세요`.
- [ ] **Step 1: Failing tests** (source checks): the 퀘스트 mode exists; cards render through `questRender(root)`; the picker disables non-eligible sessions; 자동 never dispatches without the confirm button; assignment recorded only after the modal's send succeeds; I18N check.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; `node scripts/csp-hash.mjs --write`; `node scripts/i18n-check.mjs`.
- [ ] **Step 4: Run** `node --test test/quest-ui.test.mjs && npm test` — PASS (known timing flakes: re-run alone).
- [ ] **Step 5: Commit** — `feat(quest): Jira 화면 퀘스트 보기·맡기기·자동`.

### Task 4: Dock panel and office marker

**Files:** Modify `widget.html` (dock: a 🗡 button next to 📖, a dock sheet kind like the Skillbook's `sbDockToggle`/`dockSheetOpen()`; office: marker over assigned sessions' desks via the effect system or a small sprite); Test extend `test/quest-ui.test.mjs`

**Interfaces:**
- Consumes: `questRender(root)` (Task 3), the dock sheet helpers from the Skillbook dock panel.
- Produces: `questDockToggle(open)`; office marker drawn in the seat draw path for sessions with a live quest.
- [ ] **Step 1: Failing tests**: the 🗡 button with an I18N title; mutual exclusion with 📥/📖 (shared `dockSheetOpen()`); the panel loads the Jira board if not loaded and shows the sign-in message when disconnected; the office marker condition (assigned, no `reportAt`, session has a seat).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; csp-hash; i18n-check.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** — `feat(quest): 도크 퀘스트 패널과 오피스 퀘스트 표시`.
