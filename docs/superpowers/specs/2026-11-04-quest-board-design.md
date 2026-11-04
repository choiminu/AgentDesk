# Quest board — design

Date: 2026-11-04 · Status: for owner approval · Project 3 of 3 (Skillbook → Shop → **Quest board**)

## Why

The owner wants work to feel like a game: Jira tickets become **quests**, and you hand each quest to one of your agents
(your "party"). AgentDesk already connects to Jira (OAuth or the Orca CLI), shows a kanban board, and can send a ticket
to a new worktree session or an existing one (`jiraWorktreeModal`, `jiraSessionModal`, report capture). The Quest board
re-presents that as a game screen and adds assignment help, including in dock mode.

## Goals (owner requests)

1. **Quest list**: the Jira page gets a 퀘스트 view: each ticket is a quest card (key, title, priority as a difficulty
   mark, status, due date if any, who is on it). Grouped as 새 퀘스트 / 진행 중 / 보고 대기 / 완료, mapped from Jira status
   categories.
2. **Assign to a specific agent**: on a quest card, pick a party member — one of my current sessions (name, repo,
   status, what it's doing, the skills it used recently from the Skillbook) — or "새 워크트리에서 시작". This uses the
   existing dispatch paths and their prompt templates.
3. **자동 (auto) button**: a "front desk" reads the quest and proposes who should take it, with a one-line reason:
   an existing session (same repo / related work / idle) or a new worktree in a named repo. The owner sees the proposal
   and confirms with one click (the designer's call: propose-then-confirm, not silent dispatch).
4. **Dock mode**: a 🗡 퀘스트 button in the dock opens the quest list as a dock panel (like 📥 and 📖), with the same
   assign and 자동 actions.
5. The pixel office reacts: a quest accepted by an agent shows a small quest marker over its desk until the report
   arrives (reuse the office effect system).

## Front desk (auto) — how

A headless Claude call (`claude -p --output-format json`, like AgentDesk's existing headless summarizer) with:
the ticket (key, title, description trimmed, labels, components), and the party list (session id, name, repo, branch,
status, last activity, a one-line "what it's doing", recent skills). It must answer with JSON
`{ choice: { kind: 'session', id } | { kind: 'worktree', repo }, reason }`. Validate the answer against the real list;
on anything invalid, fall back to "pick it yourself". Text sent to the model goes through AgentDesk's existing outbound
masking. The call costs the owner's Claude usage, so it runs only when 자동 is pressed.

## Non-goals

- Creating or editing Jira tickets from the quest view (except the existing report → comment draft).
- XP, levels, achievements (game elements stay light, like the Skillbook's stars).
- Assigning teammates' sessions (team sharing exists; out of scope here).

## Anti-goals

- Dispatching work the owner didn't confirm.
- Sending secrets or unmasked text to the model.
- A slow Jira page: the quest view reuses the data the Jira page already loads.

## The designer's calls (owner may override)

- 자동 proposes, the owner confirms (one click).
- Quest groups come from Jira status categories (to do / in progress / done) plus "보고 대기" from AgentDesk's own
  report capture.
- Difficulty mark = Jira priority (Highest ★★★ … Low ★).

## Settled after review (the designer's calls — the owner may override)

- **Party** = my live interactive agent sessions the dashboard knows (not teammates', not finished ones). Selectable
  only when idle (입력 대기 / 완료); working or permission-waiting sessions show disabled with "작업 중". Recent skills
  come from that session's timeline entries (Skill calls), not the global counters.
- **Quest state** is stored by AgentDesk in `~/.roca/quests.json` (ticket key → assigned session or worktree, at, report
  captured at), so it survives restarts. Grouping: AgentDesk's own state wins for 진행 중 / 보고 대기 (assigned, report
  captured); otherwise the Jira status category decides 새 퀘스트 / 진행 중 / 완료. The desk marker shows from assignment
  until the report is captured or the session ends.
- **Which tickets**: the issues the Jira page already loads for the selected board; the fetch's field list is widened to
  include priority and due date where the API returns them (missing fields just don't show; the Orca-CLI fallback shows
  fewer marks).
- **Front desk**: the same headless approach as the existing summarizer (`recall/lib.mjs`: haiku by default, tools off,
  JSON schema, env override for the model). Everything sent goes through the outbound masking, repo and branch names
  included. Worktree repos are limited to repos Orca knows plus repos seen in sessions; the answer is validated against
  that list and the party list. A spinner with 취소; the proposal is cached per ticket for 10 minutes.
- **Dock**: quest data and Jira loading live in the renderer's existing Jira module, which the dock panel calls (loading
  the board if the Jira page was never opened, showing the same sign-in prompt when disconnected). Assignment from the
  dock opens the same modals.
- **Office marker**: only for assigned sessions that have a desk; otherwise no marker.
- **Difficulty**: Highest ★★★, High ★★★, Medium ★★, Low ★, Lowest ★, none → no mark; unknown names → ★★.

## Left to the builder

Card layout, dock panel height, how the "what it's doing" line is built (existing dashboard summary), marker sprite.
