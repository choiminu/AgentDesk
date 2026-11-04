# Shop — design

Date: 2026-11-04 · Status: for owner approval · Project 2 of 3 (Skillbook → **Shop** → Quest board)

## Why

The owner finds new skills and MCP servers by chance (Instagram) and installing one was painful: `/plugin marketplace
add patch-gg/pixelfx` failed twice and had to be finished from the terminal. The Shop is where AgentDesk brings that
information in and installs it, so AgentDesk becomes the place to grow what your agents can do — the Skillbook shows
what you have, the Shop what you could have.

## Goals

- A **🏪 상점** tab in the Skillbook (page and dock panel), in the same book style: left page = list, right page =
  the item's page.
- **Browse** three kinds: plugins (Claude Code marketplaces), MCP servers, skills. Sort: 새로 나온 순 · 인기순 (when the
  source has a popularity number) · 이름순; filter by kind and a search box.
- **Look before installing.** The item page shows what it does, where it comes from (repo / homepage / marketplace),
  version and last update, popularity if known, and **what installing will do**: the exact command or the files that
  will be written, and for MCP servers the env keys it needs (names only). Already-installed items say so and link to
  their Skillbook page.
- **Install with one confirm**, then it appears in the Skillbook. If one install route fails, try the next one and say
  which worked (the pixelfx case: `/plugin` path failed, CLI path worked).
- **Install from a link**: a box where the user pastes a GitHub URL (`owner/repo` or full URL). AgentDesk fetches it,
  detects what it is (plugin marketplace, plugin, skill folder, MCP server), shows the same item page, and installs on
  confirm.

## Sources (researched 2026-11-04)

| Source | How | Gives |
|---|---|---|
| Claude Code plugin marketplaces already known to the user (`~/.claude/plugins/known_marketplaces.json`, e.g. the official one with 315 plugins) | read the cached `marketplace.json`; refresh with `claude plugin marketplace update` | name, description, category, author, version, homepage |
| Official MCP registry `registry.modelcontextprotocol.io/v0/servers` | public JSON, no key, paginated, search | name, description, version, remotes/packages, published/updated dates |
| Smithery `registry.smithery.ai/servers` | public JSON, no key (checked) | description, **useCount** (popularity), verified, created date |
| A pasted GitHub repo | GitHub's public API / raw files | whatever the repo holds |

skills.sh is left out: its API needs a Vercel deployment token, which a desktop app can't use. [Unverified: Smithery's
terms of use for showing its data in an app — check before shipping; if they forbid it, drop Smithery and sort MCP by
date only.]

## Install routes

- **Plugin**: `claude plugin marketplace add <source>` (if the marketplace isn't known) then
  `claude plugin install <name>@<marketplace>`; on failure, retry with the repo cloned to `~/.roca/shop/<owner>-<repo>`
  and added as a local-path marketplace (what fixed pixelfx).
- **MCP server**: `claude mcp add` at user scope, using the registry's remote URL (http/sse) or package (`npx`/`uvx`
  command). If the server needs env values, the item page asks for them in password-style fields; values go straight
  into the command's arguments in main and are never logged, echoed or sent anywhere else. Gemini/Codex install is not
  in scope (the Skillbook still shows them).
- **Skill** (a folder with `SKILL.md`): download that folder to a temp dir, show the SKILL.md and the file list, then
  copy to `~/.claude/skills/<name>` (or `~/.agents/skills/<name>` if the owner picks "모든 에이전트").

## Non-goals

- Ratings, reviews, accounts, publishing.
- Auto-updating installed items (the Skillbook's plugin update action is deferred here: the Shop shows "새 버전 있음"
  when a known marketplace lists a newer version than installed, with an 업데이트 button that runs
  `claude plugin update` [unverified command name — check `claude plugin --help` first; if missing, reinstall]).
- Installing for Codex/Gemini.

## Anti-goals

- **Running code the user hasn't seen.** Nothing is installed or executed before the confirm; skill folders with
  scripts are marked "실행 파일 포함".
- **Leaking env values** typed for MCP servers (no logs, no renderer echo after submit, no backups in clear outside
  Claude's own config).
- Blocking the widget on network calls: fetches are async with short timeouts and a visible "불러오는 중" state;
  offline shows the last cached list.

## Decided by the owner (earlier in the conversation)

- The Shop brings discovery info into AgentDesk and installs it, including from a pasted link.
- It follows the Skillbook (installed things show up there).

## The designer's calls (owner may override)

- Lives as a tab inside the Skillbook book, not a separate page.
- Lists are cached in `~/.roca/shop-cache.json` for 6 hours.
- Install always needs one confirm on the item page; no bulk install.

## Settled after review (the designer's calls — the owner may override)

- **MCP env values never go on a command line** (argv is visible to `ps`): when a server needs env values or headers,
  the Shop writes the entry into `~/.claude.json` `mcpServers` itself, through the Skillbook's config-write code
  (re-read, backup, one entry, atomic write; refuse if the name exists). `claude mcp add` is used only when nothing
  secret is needed. Servers whose remote needs browser OAuth are installed and marked "Claude에서 인증 필요".
- **Registry install preference**: remote `streamable-http` → remote `sse` → npm package via `npx -y` → pypi via `uvx`;
  docker/oci/nuget, or npx/uvx missing on the machine, show as "자동 설치 불가" with the manual command to copy.
- **Pasted link**: fetched as a shallow `git clone --depth 1` into `~/.roca/shop/` (no GitHub API rate limits; public
  repos only; a `/tree/<ref>/<path>` URL selects that ref and subfolder). Detection order: `.claude-plugin/marketplace.json`
  → `.claude-plugin/plugin.json` → `SKILL.md` folders → `server.json` (MCP registry manifest). Several matches → the item
  page lists them and the user picks one. README snippets are not parsed.
- **Skill install name** = the `name:` in SKILL.md (else the folder name). An existing folder of that name → refuse with
  "이미 있음" (no overwrite). "모든 에이전트" installs to `~/.agents/skills/<name>` and adds a symlink
  `~/.claude/skills/<name>` → it (the layout the Skillbook already merges into one shared item).
- **Updates**: "새 버전 있음" only when both versions are semver and the marketplace's is higher; the update runs the CLI's
  update command if `claude plugin --help` lists one, else it is not offered (no reinstall that could lose state).
- **Smithery** is one removable source module; the license check is a pre-ship item, not a blocker for building.
- The Shop reuses `skillbook/actions.mjs` conventions (runner without a shell, backups, fixed error codes); installs are
  not recorded in "최근 제거".

## Left to the builder

Paging sizes, icons per category, how search matches, the exact layout inside the book.
