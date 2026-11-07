# Changelog

All notable changes to this project. Each version records what was implemented by referencing
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), plus anything Pi-specific.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-06

First release: codex-plugin-cc 1.0.6 ported to Pi (tested with Pi 1.5.0), running Pi headlessly
where upstream runs Codex's app server. [COMPARISON.md](./COMPARISON.md) records every difference
from upstream and its evidence.

Synced upstream: codex-plugin-cc v1.0.6

### Added

#### Plugin

- The `pi` plugin in the `5kahoisaac-pi` marketplace, laid out like upstream's `plugins/codex/`:
  manifest, commands, the `pi:pi-rescue` subagent, the `pi-cli-runtime` and `pi-result-handling`
  skills, hooks, prompts, and the review-output schema. It runs on Node.js 18.18 or newer with no
  dependencies.
- The plugin icon, `plugins/pi/assets/icon.png`, set through `icon` in `plugin.json`. Anthropic's
  plugin directory shows it in the listing; Claude Code does not read the field. Upstream ships no
  icon.

#### Commands

- Upstream's eight commands with Pi in place of Codex: `/pi:review`, `/pi:adversarial-review`,
  `/pi:rescue`, `/pi:transfer`, `/pi:status`, `/pi:result`, `/pi:cancel`, and `/pi:setup`.
- `/pi:task`, which runs the companion's `task` directly, with `--background`, `--write`,
  `--resume-last` (or `--resume`), `--fresh`, `--model`, `--thinking`, and `--prompt-file`.
- `/pi:review` and `/pi:adversarial-review` take `--wait`, `--background`, `--base <ref>`, and
  `--scope auto|working-tree|branch`. The adversarial review also takes focus text, which
  `/pi:review` rejects, as upstream does.
- `/pi:rescue` runs `task-resume-candidate --json` and asks once whether to continue the current
  Pi session or start a new one; `--resume` and `--fresh` answer for it. Rescue runs can write
  unless the request asks for read-only work.
- `/pi:setup --enable-review-gate` and `--disable-review-gate` turn the stop-time review gate on
  and off.

#### Running Pi

- Each review and task is one headless `pi -p --mode json` run, with no broker. The JSONL stream
  is decoded as UTF-8 and split on LF only, as Pi's docs require.
- Tasks live in Pi's normal session store, with `--session-id <uuid>` and a
  `Pi Companion Task: …` name, and run from the repository root. Results show
  `Resume in Pi: pi --session <id>`. Reviews run with `--no-session`.
- Read-only runs (reviews, the stop gate, and `/pi:task` without `--write`) get only `read`,
  `grep`, `find`, and `ls`, with `--no-mcp`. `/pi:transfer` runs with `--no-tools`. Pi has no
  sandbox, so read-only means no edits and no commands; reads are not limited.
- `--thinking off|minimal|low|medium|high` passes Pi's native `--thinking`; any other value fails
  before Pi starts. Without `--model` or `--thinking`, Pi's own defaults apply.
- Prompts over 96 KB, or starting with `-` or `@`, reach Pi as an attached `@file`.
- Review prompts inline the whole diff whenever it fits in 256 KB, because a read-only Pi run
  cannot call git. Past the limit, the prompt tells Pi to read the changed files.
- `/pi:review` has its own plain-text prompt (`prompts/review.md`), since Pi has no built-in
  reviewer. `/pi:adversarial-review` keeps upstream's prompt and JSON contract, accepts bare or
  fenced JSON, and checks its shape before rendering.
- `/pi:transfer` sends the user and assistant text of the Claude transcript as the first turn of a
  new Pi session, then prints `pi --session <id>`.
- Cancel sends SIGTERM to the job's process group, or to the pid when it leads no group. The
  companion stops its Pi child and exits at once, and Pi kills the command its bash tool was
  running, so the job stays `cancelled`.
- A Pi run killed by a signal exits 1 with `Pi was terminated by <signal>.`.

#### Progress and output

- Upstream's progress lines with Pi's nouns: `Starting Pi review session.`,
  `Starting Pi task session.`, `Resuming session <id>.`, `Session ready (<id>).`,
  `Turn started.`, `Running command: …`, `Command completed|failed: … (exit <n>)`,
  `Applying 1 file change(s).`, and `File changes completed.`. Commands come from the matching
  `tool_execution_start` by `toolCallId`, because Pi's `tool_execution_end` carries no `args`, and
  test, lint, and build commands set the `verifying` phase.
- `Retrying after Pi error (attempt n/m).` while Pi retries a provider error itself. A run that
  recovers counts as a success.
- Upstream's report layouts: `# Pi Setup`; `# Pi Review` around Pi's plain-text review; the
  adversarial review's findings by severity, then next steps; `/pi:task`'s final message verbatim;
  `/pi:result`'s stored answer with `Pi session ID:` and `Resume in Pi:` lines; and `# Pi Cancel`.
- `/pi:status` prints upstream's `# Pi Status` report: session runtime, review-gate state, the
  active-jobs table (Job, Kind, Status, Phase, Elapsed, Pi Session ID, Summary), the latest
  finished job, and recent jobs. Each job's follow-up commands come after the table, one per line,
  because Claude Code prints the `<br>` that upstream joins them with literally, and a table cell
  cannot hold a line break.

#### Setup

- `/pi:setup` checks Node.js, npm, and Pi, and reports readiness the way Pi picks its startup
  model: `pi auth check --provider <p> --model <m> --json` for the saved `defaultProvider` and
  `defaultModel`, then `pi --offline --list-models` for any model with credentials. Settings come
  from `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.
- It offers `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` on Node.js 22.19 or
  newer, and points to Pi's installer otherwise.
- Sign-in guidance: run `pi` in a separate terminal and use `/login`, or export a provider API key
  before starting Claude Code. Pi's `/login` needs its interactive terminal UI.

#### Hooks and job tracking

- Upstream's job tracking: per-workspace `state.json`, `jobs/<id>.json` and `jobs/<id>.log`,
  newest-first listing, Claude-session filtering, and a 50-job cap. State is written to a temp
  file and renamed, so a concurrent reader never sees a half-written file.
- Background jobs re-spawn a detached `task-worker` with `--cwd` and `--job-id`.
- The `SessionStart` hook records the Claude session id and transcript path. The `SessionEnd` hook
  stops the session's workers and clears its jobs.
- The stop-time review gate, off by default, runs a read-only Pi task with upstream's stop-gate
  prompt and ALLOW/BLOCK contract. The prompt reaches the companion on stdin, with the working tree
  inlined.
- Argument parsing splits `--key=value` on the first `=` only, so `--base=refs/x=y` keeps `=y`.

#### Repository

- A hermetic test suite (`npm test`) built on a fake `pi` (`tests/fake-pi.cjs`) that emits Pi
  1.5.0's JSONL events per scenario and logs each call. It covers setup, tasks, sessions, thinking
  levels, retries, UTF-8 framing, `@file` prompts, reviews, progress lines, background jobs,
  cancel, the stop gate, rendering, state, job resolution, process termination, upstream's git
  tests, and the command, skill, manifest, icon, and README contracts.
- Release guards in the suite: every manifest carries `package.json`'s version, CHANGELOG.md
  opens with it, every JSON file parses, scripts import only Node built-ins, and LICENSE and
  NOTICE keep the Apache-2.0 text and the codex-plugin-cc attribution.
- `scripts/bump-version.mjs` (upstream's), run as `npm run bump-version -- <version>` and
  `npm run check-version`.
- `scripts/dev.mjs`, run as `npm run dev:bind`, `dev:unbind`, and `dev:status`: registers this
  checkout as a local marketplace in Claude Code and installs `pi@5kahoisaac-pi` from it.
- Pull-request CI on Node.js 22: `claude plugin validate --strict` on the plugin and the
  marketplace (Claude Code 2.1.319), `node --check` on every script, and `npm test`.
- A pull-request template, and two repo skills: `release` (Semantic Versioning bump, CHANGELOG
  entry, and docs for each change) and `sync-upstream` (port a new upstream release after checking
  each change against Pi's docs and behavior).
- README.md on upstream's structure, COMPARISON.md, DEVELOPMENT.md, and CLAUDE.md (with
  `AGENTS.md` as a symlink to it).
