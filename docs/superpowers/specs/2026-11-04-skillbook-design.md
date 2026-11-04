# Skillbook — design

Date: 2026-11-04 · Status: for owner approval

## Why

AgentDesk so far adds convenience on top of tools people already have (Orca, terminals, Claude Code). Nothing in it is
something you can only do in AgentDesk, so teammates and GitHub users don't keep it open. The owner wants AgentDesk to
become the place where you **see and manage what your AI agents can do**: which skills, plugins and MCP servers are
installed, which ones actually get used, and add or remove them. Today that information is scattered across hidden
folders and JSON/TOML files and nobody can see it at a glance.

The Skillbook is the first of three connected projects, in this order (owner agreed):

1. **Skillbook** (this document): see and manage what is installed.
2. **Shop**: discover new skills / plugins / MCP servers and install them from inside AgentDesk.
3. **Quest board**: Jira tickets shown as quests, assigned to agents (by hand, or an "auto" button where a front-desk
   agent reads the ticket and assigns it to a fitting session), also visible in dock mode.

The Skillbook must leave room for both: the Shop installs into it, and the Quest board will show "what this agent can
do" from it. Neither is built here.

## Goals

- A new top-level page **스킬북 / Skillbook** next to 대시보드 · 오피스 · 팀 · Jira · 타이머 (`.page-nav` in
  `widget.html`).
- Drawn as an **open book** in the pixel office's art style (owner chose mockup A):
  - **Left page — index.** Tabs by kind: **스킬**, **플러그인**, **🧰 도구 주머니** (MCP servers). Above the tabs, an
    **agent filter**: 전체 · Claude · Codex · Gemini. Each row: icon, name, and a **mastery mark** (★ to ★★★ by use)
    or "미사용" when never used. MCP rows show a green dot (on) or grey dot (off) instead of stars, plus which project
    when the server is project-scoped.
  - **Right page — the "spell" page** for the selected item: big icon, name, mastery and "이번 주 N회", what it does
    (from its description), the phrases that trigger it (skills: from the `description`), source (folder / plugin /
    marketplace / project), last used (time and session/repo), which agents can use it, and actions.
  - For MCP servers the right page shows: connection state, the tools it provides, scope (user / project), how it runs
    (local command or remote URL), uses this week, last used, and actions.
- **📊 사용 기록 page** (owner request; owner chose option B of
  [`skillbook-mockups/skillbook-usage-page.html`](skillbook-mockups/skillbook-usage-page.html) — the earlier dark
  "shelf under the book" was rejected as off-style): a fourth tab after 스킬 · 플러그인 · 🧰 도구 주머니. Opened, both
  parchment pages become the usage view, in the same book style:
  - **left page**: every countable item of the current agent filter (skills, plugins and MCP servers together),
    most-called first, each row with its icon, name, a **10-cell pixel gauge** (filled relative to the most-used item;
    green, amber for the middle, grey for little use) and "N회"; a period switch **7일 · 30일 (default) · 전체**.
  - **right page**: **💤 안 쓰는 것** with a count ribbon — items with 0 calls in the chosen period, dimmed, each
    selectable, and two buttons **고른 것 끄기** and **휴지통으로** (same reversible actions; one confirmation for the
    batch). The point is to find unused skills and clean them up.
  - Items whose use can't be counted (Codex/Gemini-only) are not in either list; a one-line note says so.
  The index pages keep the mastery stars of mockup A.
- Covers **Claude Code, Codex and Gemini** plus the shared skills folder `~/.agents/skills`; the agent filter shows only
  what that agent can use; an item usable by several agents shows that on its page.
- **Actions** (owner-approved defaults): skills — open folder, turn off / on, delete; plugins — turn on / off, update,
  remove; MCP servers — turn on / off, remove. Delete / remove moves to the trash (never a hard delete) and always asks
  for one more confirmation.
- **Mastery** comes from usage AgentDesk already records: the hook log `~/.roca/events.jsonl` (`PreToolUse` with
  `tool_name: "Skill"` → `tool_input.skill`; a `UserPromptSubmit` whose prompt starts with `/name`; MCP tools as
  `tool_name: "mcp__<server>__<tool>"`). Thresholds are the builder's call; never-used items must stand out.
- Empty states lead forward: an agent with nothing installed says so and points at the (future) Shop.

## Non-goals

- Discovering or installing new items from the internet (that is the Shop, project 2). A plain "open the folder"
  action is enough here.
- Quests, Jira, assigning work (project 3).
- Editing a skill's content or an MCP server's configuration inside AgentDesk (open the file / folder instead).
- Extra game mechanics beyond mastery stars (achievements, levels, XP): owner wants to see the book first.

## Anti-goals (would make it a failure even if it works)

- **Showing secrets.** MCP configs hold tokens, passwords and API keys in `env`, `headers`, args and URLs. Nothing from
  those values may be rendered, logged, sent to the renderer unmasked, or shared with teammates. Show names, kinds and
  key *names* at most.
- **Breaking someone's setup.** Turning something off or removing it must be reversible and must not rewrite unrelated
  parts of `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml` or `~/.gemini/settings.json` (back up
  before writing, keep formatting/unknown keys, the same care the status-line relay takes in `statusline/install.mjs`).
- **A text-heavy admin table.** The owner explicitly preferred the book over a management table; the page should be
  pleasant to open, not a settings screen.
- Slowing the widget: reading and counting must not block the renderer or re-read the whole hook log on every open.

## Constraints and existing pieces

- Electron app: main process `main.mjs`, preload `preload.cjs`, single-file renderer `widget.html` (one inline
  script under a CSP hash — run `node scripts/csp-hash.mjs --write` after editing), pure logic in `core/*.js` (works as
  a classic script and as a module), tests in `test/*.test.mjs` (`npm test`). Korean UI strings need English entries in
  the `I18N` map (`node scripts/i18n-check.mjs`). Public GitHub repo: no company identifiers in tracked files.
- The hook log is already read incrementally in main (`readNewEvents`, `timelineIndex` in `main.mjs`); the index keeps
  the last 2,000 entries per session and `core/timeline.js` entries already carry a `skill` field. Counting "this week"
  needs counts that survive beyond that ring (keep a small persistent counter, or scan once and then count increments
  — builder's call).
- Where things live on this machine (verified 2026-11-04):
  - Claude Code: user skills `~/.claude/skills/*/SKILL.md`; plugins listed in
    `~/.claude/plugins/installed_plugins.json`, their files under `~/.claude/plugins/cache/...`, marketplaces in
    `~/.claude/plugins/known_marketplaces.json` (+ `marketplaces/*/.claude-plugin/marketplace.json`); enabled state in
    `~/.claude/settings.json` (`enabledPlugins`); MCP servers in `~/.claude.json` (`mcpServers` at top level for user
    scope, `projects[<path>].mcpServers` for project scope) and in a project's `.mcp.json`; project skills in
    `<repo>/.claude/skills`.
  - Codex: `~/.codex/config.toml` (MCP as `[mcp_servers.<name>]`); no skills folder present here. [unverified: where
    Codex reads skills from]
  - Gemini: `~/.gemini/settings.json` (`mcpServers`), extensions under `~/.gemini/extensions`; both empty here.
  - Shared: `~/.agents/skills/*` (installed by `npx skills add`).
- The Claude Code CLI can do some operations safely (`claude plugin install|enable|disable|uninstall`,
  `claude mcp add|remove|list`); `claude plugin` commands were used successfully on this machine.
- Art: the office uses pixel sprites (`assets/pixel/`), the Galmuri9 pixel font and a warm palette; mockup A
  (parchment pages on a dark leather book, tabs, stars) is the agreed look:
  [`skillbook-mockups/skillbook-layout.html`](skillbook-mockups/skillbook-layout.html) (option A; B and C were not
  chosen) and [`skillbook-mockups/skillbook-mcp.html`](skillbook-mockups/skillbook-mcp.html) (the 도구 주머니 tab).
  Numbers in the mockups are made up.

## Decided by the owner

- Make the Skillbook first, then Shop, then Quest board.
- Look: mockup A (open book). MCP servers are a tab in the same book (🧰 도구 주머니).
- Include all agents (Claude, Codex, Gemini) with a filter to view each.
- Actions as listed above; deletes go to the trash with a confirmation.
- Game elements for now: mastery stars only.
- A 📊 사용 기록 tab (mockup B): usage gauges on the left page, unused items with bulk clean-up on the right.

## Settled after review (the designer's calls — the owner may override)

- **Usage history.** The hook log is trimmed to its last 4,000 lines (hook script in `main.mjs`), so counting only
  from it would show almost everything as 미사용 on day one. Backfill **Claude Code** usage once, in the background,
  from its transcripts (`~/.claude/projects/*/*.jsonl`: `tool_use` blocks named `Skill`, `mcp__<server>__<tool>` tool
  calls, user prompts starting with `/name`; 694 `Skill` calls exist on this machine), then keep a small persistent
  counter fed by the hook log from then on (dedupe by tool-use id / prompt id). Codex and Gemini are not backfilled.
- **Agents whose use can't be counted** show **"사용 기록 없음"** instead of stars (not 미사용, which means "counted and
  zero"). A shared `~/.agents/skills` item's stars use the combined count; its page shows the split by agent.
- **Removing and turning off things that are not folders.** Before any write, back up the config file
  (`~/.roca/skillbook-backup/<file>.<timestamp>`), edit only the one entry (keep formatting and unknown keys), and
  record what was removed in `~/.roca/skillbook-removed.json`. The book has a small **최근 제거** list (last 30 days)
  with a **되살리기** button that writes the entry back. Skill folders go to the OS trash and are listed there too.
  Plugins are removed with `claude plugin uninstall`; 되살리기 reinstalls the same name from the same marketplace.
  Turning off uses the agent's own switch where one exists (`enabledPlugins`, `claude mcp` / config flags) and is not
  a removal.
- **Which projects.** Only repos with an AgentDesk session in the last 30 days (plus the repo of any session open
  now); stale paths in `~/.claude.json` are skipped. Project items show the repo name; acting on them edits that
  repo's files only after the usual confirmation.

## Left to the builder

- Mastery thresholds and the exact "this week" window; how counts persist.
- Icons per item (a small fixed icon set picked by kind/keywords is fine).
- How "turn off" works for a plain user skill (Claude Code has no switch for it; e.g. moving it to a sibling
  `skills-disabled` folder) — must be reversible and visible in the book as off.
- Whether MCP connection state is checked live (e.g. `claude mcp list`) or shown as configured on/off, and how often.
- Page layout at small window widths, keyboard navigation, light theme.
- Exact file structure (`core/skillbook.js` for parsing/merging, IPC names, etc.).
