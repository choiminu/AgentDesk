# AgentDesk — company-internal fork

This checkout is the **company-internal** copy of AgentDesk. The open-source project lives at
https://github.com/choiminu/AgentDesk and is wired here as the `upstream` remote.

Rules
- Company-specific content (internal URLs, Slack webhooks, team names, private prompts, PSP-related notes) goes only here, never to `upstream`.
- Pull open-source improvements with `git fetch upstream && git merge upstream/main`.
- Generic fixes that are safe to publish: make them in the open-source checkout (`~/orca-widget`) and let them flow down here through `upstream`, not the other way round.
- `origin` is the company remote; set it with `git remote add origin <company-git-url>` and push `main` there.
