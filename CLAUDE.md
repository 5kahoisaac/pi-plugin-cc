# CLAUDE.md

Guidance for AI agents (Claude Code, Codex, Pi, or any other) working in this repository.
`AGENTS.md` is a symlink to this file.

## What this repo is

`pi-plugin-cc` is a Claude Code plugin that lets users delegate code reviews and coding tasks to
Pi from inside Claude Code. It is a port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(Copyright 2026 OpenAI, Apache-2.0): same plugin structure, same command surface, same UX — but
the runtime underneath is Pi instead of Codex.

**The guiding principle: seamless UX parity with codex-plugin-cc.** When upstream adds or changes
a feature, this repo should follow with the Pi-equivalent implementation, unless Pi fundamentally
cannot support it (document that in COMPARISON.md).

## Repo layout

```
.claude-plugin/marketplace.json     Marketplace manifest (name: 5kahoisaac-pi)
plugins/pi/
  .claude-plugin/plugin.json        Plugin manifest
  assets/icon.png                   Plugin icon (`icon` in plugin.json; directory listing only)
  agents/pi-rescue.md               Thin forwarding subagent
  skills/                           pi-cli-runtime + pi-result-handling (rescue forwarding rules)
  commands/*.md                     Slash command prompts (review, task, rescue, ...)
  hooks/hooks.json                  SessionStart / SessionEnd / Stop hook wiring
  prompts/*.md                      Review, adversarial-review, and stop-gate prompt templates
  schemas/review-output.schema.json Structured review JSON schema
  scripts/
    pi-companion.mjs                Main CLI dispatcher (all subcommands)
    session-lifecycle-hook.mjs      Env capture + session-scoped job cleanup
    stop-review-gate-hook.mjs       Optional Stop-gate review
    lib/*.mjs                       args, fs, git, job-control, pi, process, prompts,
                                    render, state, tracked-jobs, workspace,
                                    claude-session-transfer
tests/*.test.mjs                    node --test suites (unit + command-level)
tests/fake-pi.cjs                   Fake `pi` binary emitting Pi's JSONL events per scenario
tests/fake-pi-fixture.mjs           Installs the fake `pi` on PATH; reads its call log
scripts/dev.mjs                     Dev bind/unbind of the local plugin in Claude Code
scripts/bump-version.mjs            Sets or checks the version in every manifest (upstream's)
.github/workflows/pull-request-ci.yml  CI: claude plugin validate --strict, node --check, npm test
```

## Architecture in one paragraph

codex-plugin-cc drives Codex through a long-lived **app-server broker** (JSON-RPC over a Unix
socket, ~5 lib modules). Pi has no shared server (its RPC mode is a child process that only its
parent can drive), and the plugin does not need one: it runs Pi **headlessly** per turn,
`pi -p --mode json` with `--session-id <uuid>` for tasks or `--no-session` for reviews, parsing
the JSONL event stream from stdout. Session persistence comes
from Pi's own session store (tasks resume via `--session-id`; users reopen them with
`pi --session <id>`), so there is no broker to manage, and no socket lifecycle. Job tracking, state
files, background workers (detached `task-worker` respawn), and the stop-gate hook all follow the
upstream design. See COMPARISON.md for the full mapping and rationale.

## Working conventions

- **Node 18.18+, ESM only** (`"type": "module"`). No TypeScript build step; plain `.mjs`.
- **No runtime dependencies.** Only Node stdlib. Keep it that way.
- **Prose in plugin files uses "Pi"** (capitalized) as the agent name — never lowercase "pi" in
  user-facing text (commands, agents, README). Lowercase only for literal commands, paths, and
  flags (`pi -p`, `pi-companion.mjs`, `/pi:task`).
- **Match upstream naming where possible**: `pi-companion.mjs` ↔ `codex-companion.mjs`,
  `PI_COMPANION_SESSION_ID` ↔ `CODEX_COMPANION_SESSION_ID`, state dir `pi-companion` ↔
  `codex-companion`. This makes diffs against upstream easy to read.
- **Surgical changes.** Touch only what the task requires. Don't refactor lib modules that
  aren't involved.

## Testing

Always run the full suite before declaring work done:

```bash
npm test          # node --test tests/*.test.mjs
```

- Tests must pass with zero failures.
- New features synced from upstream **require** corresponding test changes — see the
  `sync-upstream` skill for the required workflow.
- Command-level tests run against the fake `pi` in `tests/fake-pi.cjs`. Add a scenario there
  rather than calling the real `pi` or the network.
- E2E sanity (optional, when Pi is configured): `node plugins/pi/scripts/pi-companion.mjs setup`
  should report ready.

## Syncing from upstream

Use the `sync-upstream` skill. It defines the full procedure: clone upstream, diff against the
last synced release tag, check Pi's docs and behavior before porting each change, port it,
**always update tests**, record every Pi difference in COMPARISON.md, then run the `release`
skill.

## Releasing a change

Use the `release` skill. Run it once per pull request, after the code and tests are done. It
compares the version with `origin/main`'s and bumps it per Semantic Versioning when `plugins/pi/`
changed (users stay on their cached copy until the version changes). It sets every manifest with
`npm run bump-version -- X.Y.Z`, writes the CHANGELOG.md entry under that version (there is no
`[Unreleased]` section), updates only the other docs the change makes stale, and verifies the
result. It never commits, tags, or pushes. The PR template's checklist requires it.

## Licensing guardrail

This repo contains software adapted from Apache-2.0-licensed codex-plugin-cc. Keep the
Apache-2.0 LICENSE and the NOTICE files (root + plugins/pi) intact; the NOTICE must continue to
carry the OpenAI attribution for adapted portions. Do not relicense to MIT.

## Things that are easy to break

- `pi -p` child processes hang if their stdin is a pipe that never closes — always spawn with
  `stdio: ["ignore", "pipe", "pipe"]` (see `spawnPiProcess` in `lib/pi.mjs`).
- `pi auth check` requires `--model` or `--provider`; the plugin reads `defaultProvider` and
  `defaultModel` from `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`. Pi has
  no `PI_MODEL` variable.
- Read-only runs need `--no-mcp` next to `--tools read,grep,find,ls`: `--tools` alone leaves MCP
  tools callable.
- Pi's `tool_execution_end` carries no `args`; take them from `tool_execution_start` by
  `toolCallId` (see `describeToolEnd` in `lib/pi.mjs`).
- Split Pi's JSONL on LF only, after UTF-8 decoding; Node's `readline` also splits on Unicode
  line separators that are valid inside JSON strings.
- The stop-gate hook must never emit a decision on stdout except the single JSON line; stderr is
  for notes.
- `--cwd` must be in `valueOptions` for every companion subcommand that accepts it, or it gets
  parsed as a positional job id.
- Cancel must send SIGTERM, never SIGKILL. Pi's bash tool runs each command in its own process
  group and kills those groups only from its SIGTERM handler; after a SIGKILL the command keeps
  running (COMPARISON.md §9).
- No HTML in Markdown table cells. Claude Code's terminal prints `<br>` literally, and a table
  row cannot hold a line break; put lists below the table (COMPARISON.md §14).
- Pi's flags and values decide what the plugin accepts, not upstream's. Check `pi --help` and
  Pi's `docs/cli.md` before porting a flag or value: Pi has `--thinking` and no effort setting
  (COMPARISON.md §6).
