# Contributing to AgentDesk

Thank you for your interest in contributing! Here's how you can help.

## Getting Started

```bash
git clone https://github.com/choiminu/AgentDesk.git
cd AgentDesk
npm install
npm start
```

## Development

### Project structure

- `main.mjs`: Electron main process (agent CLI hooks, terminal adapters, transcript readers, update check, IPC handlers)
- `jira-oauth.mjs`: Atlassian OAuth 2.0 (3LO) sign-in, encrypted token store and the Kanban board API
- `preload.cjs`: context bridge between main and renderer (`window.orca`)
- `widget.html`: single-file frontend (HTML + CSS + JS): dashboard, office, dock, team and Jira views
- `core/`: logic shared by the renderer and the tests (status judgement, dock, Jira, masking and more)
- `team/`: team sharing (signed HTTP server and client, discovery, delegation, identity keys)
- `perm/`: widget permission approval server and hook installation
- `guard/`: guardrail rules and verdicts
- `diff/`: change view (git diff) readers
- `recall/`: session notes, Slack bridge and morning briefing (not included in the installers)
- `test/`: `node --test` unit tests
- `scripts/`: CSP hash, i18n check and build helpers
- `docs/`: [team sharing guide](docs/TEAM-GUIDE.en.md), [Jira setup](docs/JIRA-SETUP.md) and design notes
- `package.json`: app config and electron-builder settings

### Commands

```bash
npm run dev          # run with NODE_ENV=development
npm test             # all unit tests (test/*.test.mjs)
npm run dist         # macOS DMGs; dist:linux / dist:win for the other platforms
```

### Before you commit

1. **Run the tests**: `npm test`.
2. **Update the CSP hash** after editing the inline `<script>` in `widget.html`: `node scripts/csp-hash.mjs --write`. The widget runs under a Content-Security-Policy that allows exactly one inline script by its sha256 hash, so a stale hash keeps the script from running. `node scripts/csp-hash.mjs` (without `--write`) only checks it, and `npm test` checks it too.
3. **Check translations** after adding or changing UI strings: `node scripts/i18n-check.mjs`. It lists Korean strings in `widget.html` that would still show in English mode. Text that must stay untranslated goes into `scripts/i18n-allow.json`; keep that list short.

## How to Contribute

### Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- OS and version (macOS, Linux distribution, or Windows)
- AgentDesk version (⚙ Settings → Update row) and how you installed it (installer or source)
- Agent CLI and version (Claude Code, Codex CLI or Gemini CLI, for example `claude --version`)
- Orca version (`orca --version`), if you use Orca

### Suggesting Features

Open an issue describing:
- What problem it solves
- How it should work
- Mockup or screenshot if possible

### Submitting Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm test`, and the CSP and i18n steps above when they apply
4. Test locally with `npm start`
5. Commit with a clear message describing the change
6. Open a PR against `main`

## Code Style

- No external CSS/JS frameworks; the frontend is a single HTML file
- Keep IPC handlers in `main.mjs`, expose them in `preload.cjs`
- Put logic that can be tested without Electron in `core/` (or `team/`, `perm/`, `guard/`, `diff/`) and cover it in `test/`
- Use CSS custom properties (variables) defined in `:root` for theming
- UI strings: write new strings in `widget.html` in Korean (the source language), wrap them with `t('…')` in scripts, and add the English translation to the `I18N` map (key: the Korean text, value: the English text). Code, comments and docs are in English

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
