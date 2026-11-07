# Pi plugin for Claude Code

Use [Pi](https://github.com/earendil-works/pi) from inside Claude Code for code reviews or to delegate tasks to Pi.

This plugin is for Claude Code users who want an easy way to start using Pi from the workflow
they already have.

## What You Get

- `/pi:review` for a normal read-only Pi review
- `/pi:adversarial-review` for a steerable challenge review
- `/pi:rescue`, `/pi:transfer`, `/pi:status`, `/pi:result`, and `/pi:cancel` to delegate work, hand off sessions, and manage background jobs
- `/pi:task` to run Pi directly, with explicit control over write access and session resume

## Requirements

- **Pi 1.5.0 or later with at least one provider configured**, either through `/login` inside Pi (a subscription or a stored API key) or a provider API key in the environment.
  - Usage counts against that provider's usage limits or billing.
- **Node.js 18.18 or later** for the plugin. Installing Pi from npm requires Node.js 22.19 or later.

> [!NOTE]
> The plugin starts `pi` directly, without a shell, so prompt text is never parsed by a shell. On Windows, npm's `pi.cmd` shim cannot be started that way, so an npm install of Pi does not work with this plugin on Windows. Windows is untested.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add 5kahoisaac/pi-plugin-cc
```

Install the plugin:

```bash
/plugin install pi@5kahoisaac-pi
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/pi:setup
```

`/pi:setup` will tell you whether Pi is ready. If Pi is missing and npm is available, it can offer to install Pi for you.

If you prefer to install Pi yourself, use Pi's installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Or install it from npm (requires Node.js 22.19 or later):

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

If Pi is installed but no provider is configured yet, run `pi` in a separate terminal and use `/login` inside Pi. Pi has no login subcommand, and its interactive terminal UI does not work through Claude Code's `!` shell mode. You can also export a provider API key such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before starting Claude Code.

After install, you should see:

- the slash commands listed below
- the `pi:pi-rescue` subagent in `/agents`

One simple first run is:

```bash
/pi:review --background
/pi:status
/pi:result
```

## Usage

### `/pi:review`

Runs a normal Pi review on your current work. Pi has no built-in review command, so the plugin sends Pi a review prompt with the diff inlined (or, for a very large diff, a summary of the changed files that Pi then reads itself), and Pi reviews it with read-only tools.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/pi:adversarial-review`](#piadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/pi:review
/pi:review --base main
/pi:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/pi:status`](#pistatus) to check on the progress and [`/pi:cancel`](#picancel) to cancel the ongoing task.

### `/pi:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/pi:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/pi:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/pi:adversarial-review
/pi:adversarial-review --base main challenge whether this was the right caching and retry design
/pi:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/pi:rescue`

Hands a task to Pi through the `pi:pi-rescue` subagent.

Use it when you want Pi to:

- investigate a bug
- try a fix
- continue a previous Pi task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/pi:rescue investigate why the tests started failing
/pi:rescue fix the failing test with the smallest safe patch
/pi:rescue --resume apply the top fix from the last run
/pi:rescue --model anthropic/claude-sonnet-4-5 --thinking low investigate the flaky integration test
/pi:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Pi:

```text
Ask Pi to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--thinking`, Pi uses its own defaults (`defaultProvider`, `defaultModel`, and `defaultThinkingLevel` in your Pi settings).
- `--model` takes a Pi model ID or pattern, optionally with a provider prefix, such as `anthropic/claude-sonnet-4-5` or `sonnet`.
- `--thinking` accepts `off`, `minimal`, `low`, `medium`, or `high`. Pi clamps the level to what the model supports.
- rescue runs can edit files unless you ask only for read-only investigation, review, or research.
- follow-up rescue requests can continue the latest Pi task in the repo

### `/pi:task`

Runs Pi directly through the companion runtime, with explicit control over write access and session resume. `/pi:rescue` uses the same runtime underneath.

Options:

- `--background` runs Pi as a detached job; follow it with `/pi:status`, `/pi:result`, and `/pi:cancel`
- `--write` gives Pi its normal tool set so it can edit files and run commands
- `--resume-last` (or `--resume`) continues the latest Pi task session from this Claude session in this repository
- `--fresh` starts a new Pi session (the default)
- `--model <model>` and `--thinking <off|minimal|low|medium|high>` pass through to Pi
- `--prompt-file <path>` reads the prompt from a file

Without `--write`, Pi gets only its `read`, `grep`, `find`, and `ls` tools, with MCP turned off, so it cannot edit files or run commands. With `--write`, Pi uses its normal tools (by default `read`, `bash`, `edit`, and `write`, plus your MCP and extension tools).

> [!WARNING]
> Pi has no sandbox. Its tools run with your own user permissions, and even the read-only tools can read files outside the repository.

Examples:

```bash
/pi:task Read the failing test in tests/auth.test.ts and report the root cause.
/pi:task --background --write Refactor src/render.mjs to remove the duplicated severity ranking.
/pi:task --resume-last Continue where you left off.
```

### `/pi:transfer`

Creates a persistent Pi session from the current Claude Code session and prints a `pi --session <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Pi.

Examples:

```bash
/pi:transfer
/pi:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The source must be a `.jsonl` file under `~/.claude/projects`. Pi cannot import a Claude transcript (its `/import` takes only Pi's own session files), so the plugin sends the user and assistant messages of the transcript to a new Pi session as its first turn, with all tools turned off, and Pi replies with a short summary of where things stand. Tool calls and tool output are not carried over.

### `/pi:status`

Shows running and recent Pi jobs for the current repository.

Examples:

```bash
/pi:status
/pi:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/pi:result`

Shows the final stored Pi output for a finished job.
When available, it also includes the Pi session ID so you can reopen that run directly in Pi with `pi --session <session-id>`.

Examples:

```bash
/pi:result
/pi:result task-abc123
```

### `/pi:cancel`

Cancels an active background Pi job.

Examples:

```bash
/pi:cancel
/pi:cancel task-abc123
```

### `/pi:setup`

Checks whether Pi is installed and authenticated.
If Pi is missing and npm is available, it can offer to install Pi for you.

You can also use `/pi:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/pi:setup --enable-review-gate
/pi:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Pi review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Pi loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/pi:review
```

### Hand A Problem To Pi

```bash
/pi:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/pi:adversarial-review --background
/pi:rescue --background investigate the flaky test
```

Then check in with:

```bash
/pi:status
/pi:result
```

## Pi Integration

The Pi plugin runs your local Pi CLI headlessly (`pi -p --mode json`), once per review or task. It uses the global `pi` binary installed in your environment and applies the same configuration. See [COMPARISON.md](./COMPARISON.md) for how this maps onto the original plugin's design.

### Common Configurations

If you want to change the default model or thinking level that gets used by the plugin, you can define that in your Pi settings. For example, to always use `claude-sonnet-4-5` on `high`, add the following to `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high"
}
```

Your configuration will be picked up based on:

- user-level settings in `~/.pi/agent/settings.json` (or in `$PI_CODING_AGENT_DIR` when you set it)
- project-level overrides in `.pi/settings.json`
- project-level overrides only load when the project is trusted. The plugin runs Pi without a terminal, where Pi cannot ask, so trust the project once with `/trust` in interactive Pi, or set `"defaultProjectTrust": "always"` in your user-level settings

Pi loads `AGENTS.md` and `CLAUDE.md` context files from the project whether or not it is trusted.

Check out the Pi docs for more [settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).

### Moving The Work Over To Pi

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Pi by running `pi --session <session-id>` from the repository root with the session ID you received from running `/pi:result` or `/pi:status`, or by running `pi --resume` and selecting it from the list.

This way you can review the Pi work or continue the work there.

## FAQ

### Do I need a separate Pi account for this plugin?

If you have already configured a provider in Pi on this machine, that setup should work immediately here too. This plugin uses your local Pi CLI authentication.

If you only use Claude Code today and have not used Pi yet, you will also need to connect Pi to a model provider, with a subscription or an API key. Run `/pi:setup` to check whether Pi is ready. If it is not, run `pi` in a separate terminal and use `/login` inside Pi, or export a provider API key before starting Claude Code.

### Does the plugin use a separate Pi runtime?

No. This plugin delegates through your local Pi CLI on the same machine.

That means:

- it uses the same Pi install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Pi config I already have?

Yes. If you already use Pi, the plugin picks up the same [configuration](#common-configurations).

### Is "read-only" a sandbox?

No. Pi has no sandbox. Read-only runs give Pi only the `read`, `grep`, `find`, and `ls` tools with MCP turned off, so Pi cannot edit files or run commands, but those tools can still read anything your user account can read. Extensions you have installed still load. Write runs use Pi's normal tools with your own permissions.

## Credits

This plugin is inspired by and adapted from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Copyright 2026 OpenAI, Apache-2.0). The marketplace structure, command surface, prompt design, and job-tracking model follow their design, reimplemented on top of Pi's headless mode. See [NOTICE](./NOTICE) and [COMPARISON.md](./COMPARISON.md).

## License

Apache-2.0
