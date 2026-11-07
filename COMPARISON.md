# COMPARISON.md — Pi vs Codex under this plugin

This plugin ports [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 1.0.6 to Pi.
The command surface, prompts, job tracking, and rendered output follow upstream. Pi is a
different agent, though, so wherever Codex and Pi behave differently the plugin does what is
correct for Pi instead of copying upstream. This file records each difference, what the plugin
does about it, and the evidence.

Evidence is cited as:

- **Pi docs**: files in the Pi 1.5.0 package (`@earendil-works/pi-coding-agent/docs/`).
- **Pi source**: compiled code in the same package (`@earendil-works/pi-coding-agent/dist/`).
- **Observed**: behavior seen by running Pi 1.5.0 directly.
- **Upstream**: files in codex-plugin-cc 1.0.6 (`plugins/codex/...`).
- **Plugin**: files in this repo (`plugins/pi/...`).

## Summary

| Area | codex-plugin-cc (Codex) | pi-plugin-cc (Pi) | Evidence |
| --- | --- | --- | --- |
| Runtime | Long-lived `codex app-server` (JSON-RPC over a socket), shared across commands | One headless `pi -p --mode json` process per review or task; no broker | Pi docs `cli-integration.md`, `json.md`, `rpc.md`; plugin `lib/pi.mjs` `buildPiArgs` |
| Task sessions | Persistent Codex thread | Persistent Pi session: `--session-id <uuid>` and `--name "Pi Companion Task: …"` | Pi docs `cli.md` |
| Review sessions | Ephemeral thread | In-memory session (`--no-session`) | Pi docs `cli.md`; upstream `runAppServerReview` (`ephemeral: true`) |
| Resume outside Claude | `codex resume <session-id>` | `pi --session <session-id>` from the repository root, or the `pi --resume` picker | Pi docs `cli.md` |
| Read-only runs | Codex `read-only` sandbox | No sandbox exists; Pi gets only `read`, `grep`, `find`, `ls`, with MCP off | Pi docs `cli.md`, `security.md` |
| Write runs | Codex `workspace-write` sandbox | Pi's normal tools, with the user's own permissions | Pi docs `cli.md`, `security.md` |
| Approvals | `approvalPolicy: "never"` | Pi "does not ask for approval before every tool call"; a headless run could not answer anyway | Pi docs `security.md` |
| `/pi:review` engine | Codex built-in reviewer (`review/start`) | Plugin review prompt (`prompts/review.md`) with the diff inlined; plain-text answer | plugin `pi-companion.mjs` `executeReviewRun` |
| Adversarial review JSON | Enforced by `outputSchema` | Requested by the prompt; bare or fenced JSON accepted; shape checked when rendering | plugin `parseStructuredOutput`, `renderReviewResult` |
| Large diffs | Codex runs read-only git commands itself | Pi cannot run git in a read-only run; it reads the changed files with its read tools | plugin `PI_SUMMARY_COLLECTION_GUIDANCE` |
| Stop-gate review | `task --json <prompt>`; Codex inspects the repo itself | Same task call; prompt on stdin with the working tree inlined | plugin `stop-review-gate-hook.mjs` |
| Reasoning control | `--effort none\|minimal\|low\|medium\|high\|xhigh` | `--thinking off\|minimal\|low\|medium\|high`; Pi has no effort setting | Pi docs `cli.md`, `settings.md` |
| Model aliases | `spark` → `gpt-5.3-codex-spark` | None; `--model` passes through as given | upstream `codex-companion.mjs` `MODEL_ALIASES` |
| Prompt shaping | Rescue agent may tighten the prompt with the `gpt-5-4-prompting` skill | Not ported; the request is forwarded as-is | upstream `agents/codex-rescue.md` |
| Auth check | Codex login status via the app server | `pi auth check` for the saved default model, else `pi --offline --list-models` | Pi docs `cli.md`; plugin `getPiAuthStatus` |
| Sign-in guidance | `!codex login` | Run `pi` in a separate terminal and use `/login`, or export a provider API key | Pi docs `quickstart.md`, `providers.md`; observed |
| Install | `npm install -g @openai/codex` | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (Node.js 22.19+) or Pi's installer | Pi docs `quickstart.md` |
| Session transfer | `externalAgentSession/import` RPC | Transcript text sent as the first turn of a new Pi session, with tools off | plugin `importClaudeSession` |
| Cancel | `turn/interrupt` RPC, then kill the process tree | JSON mode takes no commands (`abort` is RPC mode's); SIGTERM to the process group, falling back to the pid, and Pi stops its bash commands on SIGTERM | Pi docs `rpc-commands.md`; Pi source `modes/print-mode.js`; plugin `lib/process.mjs`, `spawnPiProcess` |
| Latest task without a Claude session id | `thread/list` | No headless session listing; only tasks the plugin tracked can resume | plugin `findLatestTaskThread` |
| Progress lines | `Starting Codex review thread.`, `Thread ready (<id>).`, `Turn started (<id>).` | `Starting Pi review session.`, `Session ready (<id>).`, `Turn started.` | Pi docs `json.md` (no turn ids) |
| Project config trust | `.codex/config.toml` loads only in trusted projects | `.pi/settings.json` loads only in trusted projects; headless runs cannot ask | Pi docs `security.md` |
| Commands | 8 slash commands | The same 8, plus `/pi:task` | plugin `commands/` |

## 1. Runtime: headless runs instead of an app server

**Codex**: the plugin starts `codex app-server`, a long-lived JSON-RPC process reached over a Unix
socket (a named pipe on Windows), and shares it across commands. Several lib modules manage the
broker endpoint, its lifecycle, and the protocol types.

**Pi**: has no shared server. RPC mode (`pi --mode rpc`) is a long-lived child process that only
the process that started it can drive, through the child's stdin and stdout (Pi docs `rpc.md`).
JSON mode (`pi -p --mode json`) runs one prompt and exits, writing a JSONL event stream to stdout
(Pi docs `cli-integration.md`, `json.md`).

**What the plugin does**: every review and task is a fresh `pi -p --mode json` process
(`buildPiArgs` and `spawnPiProcess` in `lib/pi.mjs`). Each companion command, and each background
worker, runs exactly one turn, which is what JSON mode does, and `--session-id` carries a task's
conversation into the next turn (section 2). Keeping an RPC child alive between commands would need
a broker like upstream's. The interrupt that RPC mode adds (`abort`) is covered by SIGTERM
(section 9). There is no broker to start, reuse, or tear down, so the upstream broker modules are
not ported, and `/pi:setup` reports the session runtime as `direct startup`. The child is spawned
with stdin ignored, because `pi -p` waits for an open stdin pipe to close (observed).

## 2. Sessions and resume

**Codex**: tasks run on persistent threads and reviews on ephemeral ones. Users reopen a thread
with `codex resume <session-id>`.

**Pi**: sessions are files Pi stores per working directory. `--session-id <id>` opens the current
directory's session with that id or creates it; `--no-session` keeps the session in memory only;
`--session <id>` reopens a session in its own working directory; `--resume` opens a picker
(Pi docs `cli.md`).

**What the plugin does**:

- Tasks get a new random UUID as `--session-id` and a `--name` built the same way as upstream's
  thread name (`Pi Companion Task: …`). Resumed tasks reuse the recorded id and skip `--name`.
- Reviews use `--no-session`, matching upstream's ephemeral review threads.
- Tasks run from the repository root, so their sessions belong to it. Results and status show
  `Resume in Pi: pi --session <session-id>`; run that from the repository root. From another
  directory, Pi offers to fork the session instead (Pi docs `cli.md`).
- The plugin never passes `--session-dir`, so sessions live in Pi's normal store and plain
  `pi --session` and `pi --resume` find them.
- Upstream falls back to `thread/list` to find the latest task thread when there is no Claude
  session id. Pi has no headless session listing, so `findLatestTaskThread` returns nothing and
  `--resume-last` only resumes tasks the plugin itself recorded.

## 3. Tools, sandbox, approvals, and project trust

**Codex**: runs read-only work in its `read-only` sandbox and write work in `workspace-write`,
with `approvalPolicy: "never"`.

**Pi**: has no sandbox. Tools run with the operating-system permissions of the Pi process, and Pi
"does not ask for approval before every tool call" (Pi docs `security.md`).

**What the plugin does**:

- **Read-only** (reviews, the stop gate, `/pi:task` without `--write`): `--tools read,grep,find,ls
  --no-mcp`. `--tools` with plain names is an allowlist that also covers extension and custom
  tools, and `--no-mcp` turns MCP off, because `--tools` alone keeps MCP tools callable
  (Pi docs `cli.md`). Pi cannot edit files or run commands, but the read tools can read anything
  the user can, including files outside the repository. Installed extensions still load.
- **Write** (`--write`, and rescue by default): no tool flags, so Pi uses its normal tools (by
  default `read`, `bash`, `edit`, `write`, plus MCP and extension tools, unless `defaultTools`
  changes them).
- **Transfer**: `--no-tools`, since that turn only needs to read the transcript.
- **Project trust**: Pi loads project `.pi/settings.json` (and project MCP servers, extensions,
  skills, and prompts) only when the project is trusted. Print and JSON modes cannot show the
  trust prompt, so headless runs load them only after a saved `/trust` decision, an extension
  decision, or `defaultProjectTrust: "always"` (Pi docs `security.md`). The plugin never passes
  `--approve`, so it never trusts a project on the user's behalf.
- Pi loads `AGENTS.md` and `CLAUDE.md` context files whether or not the project is trusted (Pi docs
  `security.md`), so a repository's Claude instructions also reach Pi.

## 4. Reviews

**Codex**: `/codex:review` calls the built-in reviewer (`review/start`) with an
`uncommittedChanges` or `baseBranch` target. `/codex:adversarial-review` runs a turn whose answer
is enforced by `outputSchema`. For larger diffs, upstream sends a summary and Codex runs
read-only git commands to inspect the rest.

**Pi**: has no built-in reviewer and no output-schema enforcement. A read-only Pi run has no
`bash` tool, so it cannot run git.

**What the plugin does**:

- `/pi:review` sends the plugin's `prompts/review.md` with the repository context and returns
  Pi's plain-text answer in upstream's native-review format (`# Pi Review`, target, then the
  review text).
- `/pi:adversarial-review` keeps upstream's prompt and JSON contract. `parseStructuredOutput`
  accepts a bare JSON object or a fenced `json` block, and `renderReviewResult` checks the shape,
  reporting a missing field or invalid JSON with the raw answer instead of crashing.
- The diff is inlined whenever it fits the byte limit (256 KB), whatever the file count, because
  Pi cannot fetch it with git; upstream inlines at most 2 files. Over the limit, the prompt
  carries a summary and tells Pi to read the changed files with `read`, `grep`, `find`, and `ls`.
- Target selection (`--base`, `--scope`) and diff collection (`lib/git.mjs`) are upstream's,
  unchanged.
- Focus text on `/pi:review` is rejected, as upstream does.

## 5. Stop-gate review

**Codex**: the `Stop` hook runs `codex-companion.mjs task --json <prompt>`, and Codex inspects the
repository itself.

**What the plugin does**: the hook runs the same read-only task, but sends the prompt on stdin
instead of as an argument, and inlines the working-tree context in `<repository_context>`, since
Pi cannot run git in that run. Stdin keeps a large working tree clear of the per-argument size
limit. The ALLOW/BLOCK contract, the block message, and the never-block-on-failure behavior are
upstream's.

## 6. Thinking levels, models, and prompt shaping

**Codex**: `--effort none|minimal|low|medium|high|xhigh` sets reasoning effort; the `spark` alias
maps to `gpt-5.3-codex-spark`; the rescue agent may tighten prompts with the `gpt-5-4-prompting`
skill.

**Pi**: has no effort setting. It has thinking levels, set with `--thinking` and the
`defaultThinkingLevel` setting, and clamps a level to what the chosen model supports (Pi docs
`cli.md`, `settings.md`).

**What the plugin does**:

- `/pi:task` and `/pi:rescue` take `--thinking` and accept exactly `off`, `minimal`, `low`,
  `medium`, and `high`. Any other value fails before Pi starts. There is no `--effort` flag.
- Without `--model` or `--thinking`, the plugin passes neither, so Pi's own defaults apply
  (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`).
- `--model` passes through as given (a Pi model id or pattern, optionally `provider/id`). There is
  no `spark` alias.
- The `gpt-5-4-prompting` skill is not ported, since it targets Codex's models; the rescue
  subagent forwards the request unchanged.

## 7. Setup: install, readiness, and sign-in

**Install**. Upstream offers `npm install -g @openai/codex`. Pi's documented npm install is
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, which requires Node.js 22.19 or
newer (Pi docs `quickstart.md`). `/pi:setup` offers that command only when the `node` check
reports 22.19 or newer; otherwise it points to Pi's installer
(`curl -fsSL https://pi.dev/install.sh | sh`). The plugin itself still needs only Node.js 18.18.

**Readiness**. `pi auth check` needs `--provider` or `--model` (Pi docs `cli.md`). The plugin
mirrors Pi's startup model choice: when both `defaultProvider` and `defaultModel` are set, it runs
`pi auth check --provider <p> --model <m> --json`; if that is not ready, or no default is saved, it
runs `pi --offline --list-models` and counts the models that have credentials. That listing exits
0 even when it is empty, so readiness comes from its rows. Settings are read from
`$PI_CODING_AGENT_DIR` or `~/.pi/agent`. There is no `PI_MODEL` variable in Pi.

**Sign-in**. Upstream tells users to run `!codex login`. Pi has no login subcommand: `/login` lives
inside Pi's interactive terminal UI (Pi docs `quickstart.md`), and without a terminal `pi` never
shows that UI. It reads stdin as a prompt and exits (observed). So the plugin tells users to run
`pi` in a separate terminal and use `/login`, or to export a provider API key such as
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before starting Claude Code (Pi docs `providers.md`).

## 8. Session transfer

**Codex**: `/codex:transfer` uses the app server's `externalAgentSession/import`, which converts
the Claude transcript into native Codex turns.

**Pi**: has no importer for another agent's transcript. Its `/import <path>` command, available
only in the interactive UI, imports Pi's own JSONL session files (Pi docs `slash-commands.md`).

**What the plugin does**: it reads the Claude JSONL itself, keeps the user and assistant text
(tool calls and tool output are dropped), and sends it in `<transcript>` tags as the first turn of
a new persisted Pi session named `Claude session <id>`, with `--no-tools`. Pi replies with a short
summary of where things stand, and the plugin prints `pi --session <session-id>`. The history
arrives as quoted context rather than as native turns. Source validation (a `.jsonl` file under
`~/.claude/projects`) is upstream's.

## 9. Cancel

**Codex**: `/codex:cancel` interrupts the turn over the app server (`turn/interrupt`) and then
terminates the worker's process tree.

**Pi**: JSON mode reads no commands, so there is nothing to send an interrupt to; `abort` exists
only in RPC mode (Pi docs `rpc-commands.md`). Pi's bash tool starts each command in its own process
group (`detached`), and in print and JSON modes Pi answers SIGTERM by killing those groups and
exiting with 143 (Pi source `core/tools/bash.js`, `modes/print-mode.js`, `utils/shell.js`).

**What the plugin does**: it sends SIGTERM to the job's process group and, when the pid leads no
group (a foreground companion run), to the pid itself (`lib/process.mjs`). The companion forwards
SIGTERM or SIGINT to its Pi child and exits at once with 143 or 130, so the job stays `cancelled`.
Pi then kills the command its bash tool was running. SIGKILL would skip Pi's handler and leave
that command running in its own group (observed: a `sleep` started by Pi outlives a SIGKILL of
Pi but not a SIGTERM). The cancel payload reports `turnInterruptAttempted: false`.

## 10. Event mapping

Upstream maps app-server notifications to progress lines and phases. The plugin maps Pi's JSONL
events (Pi docs `json.md`) to the same messages wherever Pi has an equivalent:

- **Framing**: the stream is decoded as UTF-8 and split on LF only, as Pi's docs require (Node's
  `readline` is unsuitable because it also splits on Unicode line separators).
- **Start**: before Pi starts, `/pi:review` says `Starting Pi review session.` (upstream:
  `Starting Codex review thread.`). Tasks and adversarial reviews say
  `Starting Pi task session.` and resumes say `Resuming session <id>.`, matching upstream's
  `Starting Codex task thread.` and `Resuming thread <id>.`.
- **Session and turn**: `session` gives `Session ready (<id>).` (`ephemeral` for reviews) and the
  first `turn_start` gives `Turn started.`. Pi's events carry no turn ids.
- **Commands**: `tool_execution_end` carries no `args`, so the plugin keeps each call's args from
  `tool_execution_start` by `toolCallId`. That gives upstream's `Running command: <cmd>` and
  `Command completed|failed: <cmd> (exit <n>)`, with the exit code from the bash result's
  `structuredContent.exit_code` (observed). Test, lint, and build commands set the `verifying`
  phase, as upstream does.
- **Files and tools**: `edit` and `write` give `Applying 1 file change(s).` and
  `File changes completed.`; other tools give `Running tool: <name>.` and
  `Tool <name> completed.`.
- **Errors and retries**: an assistant turn that ends in an error records `Pi error: <message>`.
  Pi retries some provider errors itself (`auto_retry_start`, `auto_retry_end`); the plugin shows
  `Retrying after Pi error (attempt n/m).` and clears the error once a later turn succeeds.
  Upstream has no equivalent.
- **Not surfaced**: Pi's thinking blocks, so the reasoning section upstream fills from
  `reasoningSummary` stays empty, and compaction events.

## 11. Prompt delivery

**Codex**: prompts travel over JSON-RPC.

**Pi**: the prompt is a command-line argument, and Pi treats an argument that starts with `@` as a
file to attach.

**What the plugin does**: a prompt over 96 KB, or one that starts with `-` or `@`, is written to a
temp file and passed as `@<file>` with the instruction "Follow the instructions in the attached
file.". The temp directory is removed after the run.

## 12. Known limitations

- **Windows**: the plugin spawns `pi` without a shell, so prompt text is never parsed by
  `cmd.exe`. npm's `pi.cmd` shim cannot be started that way, so an npm install of Pi does not
  work with the plugin on Windows. The availability check does use a shell on Windows, so
  `/pi:setup` can report Pi as ready there. Windows is untested.
- **No sandbox**: read-only runs block edits and commands, not reads. See section 3.
- **Project settings**: project `.pi/settings.json` is ignored until the project is trusted. See
  section 3.

## 13. Kept identical to upstream

- Marketplace and plugin manifests keep upstream's fields with Pi names, plus the author's
  `email` and `url`. The plugin manifest also sets `homepage`, `repository`, `license`, and
  `icon` (`./assets/icon.png`, read only by Anthropic's directory listing); upstream ships no
  icon.
- Hooks wiring, and the command prompts except for the Pi differences in the sections above.
- Job state: per-workspace `state.json`, `jobs/<id>.json` and `jobs/<id>.log`, newest-first
  listing, Claude-session filtering, 50-job cap.
- Background execution: a detached `task-worker` re-spawn with `--cwd` and `--job-id`.
- Rendered output: setup, status, review, task, stored result, and cancel reports, with `Pi` in
  place of `Codex` and `pi --session <id>` in place of `codex resume <id>`. The status table's
  follow-up commands move below it (section 14).
- `resolveResultJob` treats an explicit reference to a running job as "No job found", the same
  quirk upstream has.

## 14. Fixes over upstream

These are not Pi differences; they fix upstream bugs found while porting:

- `parseArgs` splits `--key=value` on the first `=` only, so `--base=refs/x=y` keeps `=y`
  (upstream's `split("=", 2)` drops it).
- `saveState` writes a temp file and renames it, so a concurrent reader never sees a half-written
  state file.
- `/pi:status` lists each job's follow-up commands below the active-jobs table, one per line.
  Upstream puts them in an `Actions` cell joined with `<br>` (`appendActiveJobsTable`). Claude
  Code's terminal prints that `<br>` literally, and a Markdown table row is a single line, so a cell
  cannot hold a line break (observed in Claude Code 2.1.319). `commands/status.md` also tells
  Claude to keep the commands out of table cells.
