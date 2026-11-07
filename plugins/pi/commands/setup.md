---
description: Check whether the local Pi CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup --json $ARGUMENTS
```

If the result says Pi is unavailable and npm is available:
- Pi requires Node.js 22.19 or newer. If the `node` check reports an older version, do not offer the npm install. Tell the user to upgrade Node.js, or to install Pi with its own installer (`curl -fsSL https://pi.dev/install.sh | sh`), then rerun `/pi:setup`.
- Otherwise use `AskUserQuestion` exactly once to ask whether Claude should install Pi now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Pi (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" setup --json $ARGUMENTS
```

If Pi is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Pi is installed but not authenticated, preserve the guidance to run `pi` in a separate terminal and use `/login` inside Pi, or to export a provider API key before starting Claude Code. Pi has no login subcommand, and its interactive TUI does not work through Claude Code's `!` shell mode.
