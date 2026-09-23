# AgentDesk

A pixel-art office for your AI coding agents. AgentDesk is a lightweight macOS desktop widget that watches your Claude Code sessions in real time — in any terminal, or inside [Orca](https://github.com/stablyai/orca) — and shows what each agent is doing: as a dashboard, and as characters at their desks.

*Formerly "Orca Widget". Orca is optional; only Claude Code is required.*

[한국어 README](README.ko.md)

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![Electron](https://img.shields.io/badge/electron-36-blue)
![License](https://img.shields.io/badge/license-MIT-green)

<img width="635" alt="Dashboard" src="https://github.com/user-attachments/assets/6ec55127-14d7-495d-ad5d-9379c010775a" />

<img width="1772" alt="Pixel office" src="https://github.com/user-attachments/assets/5e9c3146-bf3b-4b1f-b525-7f08f5502929" />

## Features

- **Live dashboard** — every Orca worktree session with its real state: working, waiting for input, needs a choice, done, error. State comes from Claude Code hooks when enabled, otherwise from the terminal screen itself, so it stays correct even when Orca's own agent state lags.
- **Pixel office** — each recent session is a character. Working agents sit at station desks (Dev / Research / Exec / Docs, picked from the tools they use) with a live tool tag and a context-window gauge; subagents appear next to their parent; idle agents rest on the lounge sofa; a whiteboard on the wall summarizes the room.
- **PM teams** — drag an agent onto the PM seat to form a team and drag others in as members. Give the PM a goal: it writes a team brief, proposes a task split, and after your approval each member receives the brief plus its task. Reports flow back to the PM automatically.
- **Needs-input alerts** — notifications, toast, tray badge and an optional chime fire only when an agent is really waiting on you (permission prompt or a question), not on every finished turn.
- **Chat panel** — click any character or card to read the agent's screen and send it a message without leaving the widget; double-click jumps to its Orca terminal.
- **Utilities** — clipboard history, listening-port monitor with kill, quick memo, Pomodoro timer.
- **Works with or without Orca** — with Orca you get session discovery, chat and terminal control through the Orca CLI. Without Orca (any Mac with Claude Code), the widget discovers sessions from Claude Code hooks and transcripts; sessions running inside tmux can still be chatted with and directed. Both kinds of sessions show up side by side; nothing to configure.
- **English and Korean UI** — English by default, switch in ⚙ Settings.

## Quick start

Requirements: macOS and Node.js 18+. [Orca](https://github.com/stablyai/orca) 1.4+ is optional — without it the widget runs in hooks-only mode (Claude Code hooks + [tmux](https://github.com/tmux/tmux) for sending messages).

```bash
git clone https://github.com/choiminu/AgentDesk.git
cd AgentDesk
npm install
npm start
```

The widget opens as an always-on-top window. Install the prebuilt app instead with `npm run dist`, which produces `dist/AgentDesk-<version>-arm64.dmg` (Apple Silicon) and `dist/AgentDesk-<version>.dmg` (Intel). The app is not code-signed: on first launch allow it under **System Settings → Privacy & Security**.

On first launch a short onboarding checks the machine (Claude Code, the widget hooks, the Orca CLI, terminal Automation permission) and lets you turn on **Exact detection** in one click. This registers Claude Code hooks (see [How it works](#how-it-works)) so states arrive as events instead of being inferred; you can also toggle it later in ⚙ Settings. Run with `ROCA_START_PAGE=onboarding` to see the onboarding again.

## Usage

| Action | Result |
|---|---|
| Click a session card | Brings that agent's terminal forward (Orca, tmux, iTerm2 or Terminal); ended sessions reopen with `claude --resume` |
| *Chat* button on a card, or click a character | Opens the chat panel for that agent |
| Double-click a character | Switches to the agent's terminal |
| Right-click | Menu: open chat, show terminal, copy session ID, interrupt, close, team actions |
| Drag a character onto the PM seat | Creates a team with that agent as PM (the template appears while dragging) |
| Drag a character into a team block | Adds it as a member; drop it outside to remove |
| Right-click the PM → *Give the team a goal* | Brief → task plan → approval → dispatch |
| Drag a file onto a card | Inserts the file path into that terminal's prompt |
| ▾ / ▴ | Collapse to the header bar / restore |
| ⚙ in the header | Settings: language, theme (system / light / dark), exact detection, chime, pixel zoom, show onboarding again |

### Reading the office

| What you see | Meaning |
|---|---|
| Blue rug, tool tag above the head, lit monitor | Working. Dots under the tag are the last three tools |
| Yellow rug, character turned around waving, ❓ bubble, timer | Needs your input (permission or question) |
| Green ✓ bubble, no animation | Turn finished, waiting quietly |
| Red rug, blinking ! | Error |
| `↳ name` character on a pale-blue rug | Subagent spawned by the neighbouring session; disappears when it stops |
| Lounge sofa | Idle session (still within the last 24 hours) |
| Gauge under the name | Context-window usage — yellow at 75%, blinking red at 90% |
| Gold team block with 👑 PM | PM team; dotted lines run from the PM to each member, badges show roles and current tasks |

The **Auto / 2× / 3× / 4×** control sets the pixel zoom; the bell toggles the chime.

## How it works

The widget polls `orca worktree ps` and `orca terminal list` every 5 seconds for the session list, and reads each open terminal with `orca terminal read --screen` every 2 seconds. State is resolved in this order:

1. **Hook events** (exact, when Exact detection is on)
2. **Terminal screen** (inferred)
3. **Orca's own agent state** (fallback)

<details>
<summary>Where sessions come from (Orca and plain terminals)</summary>

| Session kind | Discovered through | Chat, PM teams, interrupt |
|---|---|---|
| **Orca session** | `orca worktree ps` + terminal list; hook events enrich them | Orca terminals |
| **Terminal session** (Claude Code started in iTerm2, Terminal.app or tmux) | Claude Code hook events (`~/.roca/events.jsonl`) + transcript metadata (title from `/rename` or the AI title, last message, context usage, git branch) | tmux panes (`send-keys` / `capture-pane`), or iTerm2 / Terminal.app tabs found through the `claude` process (AppleScript); ended sessions reopen with `claude --resume` |

The two kinds are told apart by the `TERM_PROGRAM` the hook script records (`Orca` vs `iTerm.app`, `tmux`, `Apple_Terminal`), so both appear in one list. Without Orca installed, hooks are the only source; the dashboard then shows a banner, with a one-click button when Exact detection is off.
</details>

<details>
<summary>Exact detection via Claude Code hooks</summary>

Turning on Exact detection adds widget hooks to `~/.claude/settings.json` (existing hooks are kept, the previous file is backed up under `~/.roca/`). The hook script `~/.roca/hook.sh` appends each event as one JSON line to `~/.roca/events.jsonl` and exits immediately; the widget tails that file. Claude Code reloads hook settings live, so running sessions are covered too. Turning it off removes only the widget's entries.

| Hook event | Widget state |
|---|---|
| `UserPromptSubmit`, `PreToolUse` (tool name and target recorded), `PostToolUse` | Working |
| `Stop` | Waiting (Done after 10 minutes) |
| `PermissionRequest`, `Notification` (`permission_prompt`, `agent_needs_input`, `elicitation_*`), `PreToolUse(AskUserQuestion)` | Needs input |
| `SubagentStart` / `SubagentStop`, `PreToolUse` inside a subagent | Subagent appears, shows its tool, leaves |
| `SessionEnd` | Done |

Events are matched to sessions by the event's `cwd` and the worktree path. Sessions without hook data (other agents, hooks not installed) fall back to screen reading.
</details>

<details>
<summary>Screen-based detection</summary>

The parser anchors on the last `❯` prompt line and looks at the first meaningful line above it, skipping indented hint lines and the status bar.

| Screen | State |
|---|---|
| Spinner line such as `· Working… (1m 14s · ↓ 3.8k tokens)` or `esc to interrupt` | Working |
| A `⏺` response with no spinner below it | Waiting; Done once the screen has been unchanged for 10 minutes |
| `✻ Worked for 22s · done 2:34 PM` within 10 minutes | Waiting |
| Same line older than 10 minutes, or dated another day | Done |
| Numbered choice with a `❯` marker, or `Do you want …` | Needs input |
| Shell terminal without a prompt | Orca state |

Times are parsed in English and Korean formats. The same screen also yields the subagent panel (`⏺ main` followed by `◯ name  description  17s · ↓ 30.5k tokens`) and the context percentage from the status line.
</details>

<details>
<summary>PM teams</summary>

Every instruction sent to a member carries the full team brief (goal, scope, decisions, per-member deliverables, done criteria, forbidden), so members keep the PM's context even after long sessions or compaction. Members are asked to end with a `REPORT_START … REPORT_END` block; when a member finishes, the widget collects the report and asks the PM for the next step (approval dialog by default, or auto-dispatch, capped at 12 rounds). Team layout and logs live in `~/.roca/teams.json`.
</details>

## Development

```bash
npm run dev          # run with NODE_ENV=development
npm run dist         # build arm64 and x64 DMGs into dist/
```

| Environment variable | Effect |
|---|---|
| `ROCA_START_PAGE=office` | Start on a tab (`settings`, or `onboarding`, `onboarding-2`, `onboarding-3` for the onboarding steps). `office-demo` renders twelve fake sessions (subagents, needs-input, a team). Append `,en` or `,ko` to force a language |
| `ROCA_SHOT=/path/shot.png` | Capture the window at 8 s, 13.5 s and 24 s as `shot-1.png` … |
| `ROCA_DEBUG=1` | Print terminal-read and renderer console logs |
| `ROCA_HOOKS_INSTALL=1` | Register hooks at startup |
| `ROCA_ORCA_BIN=/path/orca` | Force the Orca CLI path |

```
main.mjs        Electron main process: Orca CLI bridge, hook install/watch, team storage, IPC
preload.cjs     Context bridge exposed as window.orca
widget.html     Single-file frontend (HTML + CSS + JS); office renderer and teams live here
assets/pixel/   Sprites and furniture (see CREDITS.md)
assets/fonts/   Galmuri9 pixel font (OFL)
```

## Troubleshooting

- **Empty session list** — the widget looks for `orca` in `/usr/local/bin`, `/opt/homebrew/bin` and `/Applications/Orca.app/Contents/Resources/bin`. If the call fails a red banner explains why. Make sure the Orca app is running and `orca --version` works in a terminal; if needed, `sudo ln -s /Applications/Orca.app/Contents/Resources/bin/orca /usr/local/bin/orca`.
- **Orca older than 1.4** — screen reading and chat need `terminal read --screen` and `--json`; a banner asks you to update.
- **"Open terminal" or sending a message does nothing** — macOS asks once whether AgentDesk may control iTerm2 / Terminal (Automation permission). Allow it under **System Settings → Privacy & Security → Automation**; without it the widget can still read states but cannot switch to or type into terminal tabs.
- **States look wrong** — turn on Exact detection. Screen reading depends on the Claude Code TUI text; hooks do not.

## Credits

- Office furniture and character sheets from [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT, Pablo De Lucca)
- Characters based on the [Metro City Free Topdown Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) by JIK-A-4 (CC0)
- Pixel font [Galmuri](https://github.com/quiple/galmuri) by quiple (SIL Open Font License 1.1)
- UI fonts [Manrope](https://github.com/sharanda/manrope) by Mikhail Sharanda and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) by JetBrains (SIL Open Font License 1.1)

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
