# AgentDesk — working checkout

This checkout (`~/project/agentdesk-internal`) is the main working copy of AgentDesk. It pushes to the personal
GitHub repository https://github.com/choiminu/AgentDesk (`origin`, SSH). The old `upstream` remote points at the
same repository and is kept read-only for history.

Rules
- The repository is public. Keep company-specific content out of tracked files: internal hostnames and IP ranges,
  Slack/Jira identifiers, tokens, team names, merchant or settlement data. Such values live only in local config
  (`~/.agentdesk/*.json`, `~/.roca/*.json`, environment variables such as `AGENTDESK_JIRA_SITE`).
- Before every push run `git grep -n` for company strings (company name, office subnet, real e-mail addresses) and
  the secret patterns listed in `core/mask.js`; tests must use obviously fake values (`example.invalid`,
  `192.168.77.x`, `xoxb-0000…FAKE`).
- Commits from this checkout use the personal author identity (set in `.git/config`).

Company mirror
- The company knowledge repository (`~/fin-management`, GitLab) carries a copy of this tree under `agentdesk/`.
  After every push to `origin`, run `node scripts/sync-fin-management.mjs` — it copies HEAD (tracked files only,
  `.github/` left out), commits only that directory and pushes. Set `AGENTDESK_MIRROR_REPO` if the checkout lives
  elsewhere.
