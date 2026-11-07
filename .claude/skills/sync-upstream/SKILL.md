---
name: sync-upstream
description: Sync this repo (pi-plugin-cc) with a newer release of openai/codex-plugin-cc. Diffs upstream's release tags, checks every change against Pi's own docs and behavior before porting it, ports it the way Pi supports (or records why it cannot), updates tests, records each Pi difference in COMPARISON.md with evidence, and hands off to the release skill. Use when asked to sync or port upstream changes, to check for a new codex-plugin-cc release, or when upstream has a feature this plugin lacks.
---

# Sync from codex-plugin-cc upstream

This repo ports `openai/codex-plugin-cc` to Pi. Users should get the same commands, flags, and
output as upstream. Pi is a different agent, though: where Pi does the same thing, port it the
same way; where Pi works differently, do what is correct for Pi and record why. Never carry
upstream's flags or values over to Pi by name, and never write down a Pi behavior you have not
checked. A sync without test changes is not done.

## Preconditions

- You are at the repo root and `npm test` passes. If it does not, stop and report.
- The last synced release is the newest `Synced upstream:` line in CHANGELOG.md:
  `grep -m1 '^Synced upstream: codex-plugin-cc v' CHANGELOG.md`
- Pi is installed (`pi --version`), for Step 3. Without it, read Pi's docs on GitHub (Step 3) and
  say in the report that no behavior was observed.

## Step 1 — Clone upstream with full history

```bash
UPSTREAM="$(mktemp -d)/codex-plugin-cc"   # in Claude Code, use a folder in your scratchpad
git clone https://github.com/openai/codex-plugin-cc.git "$UPSTREAM"
git -C "$UPSTREAM" tag --sort=-v:refname | head -5   # release tags look like v1.0.6
```

- Clone the full history; never pass `--depth`. Step 2 diffs two tags, and a shallow clone has no
  history between them (the clone used for the first port was shallow:
  `git rev-parse --is-shallow-repository` printed `true`).
- Clone into a new directory. Do not delete or reuse an old clone.
- The target is the newest release tag. If it is the last synced one, there is nothing to sync.
  Report that, list any upstream commits after the tag
  (`git -C "$UPSTREAM" log --oneline vNEW..origin/main`), port them only if the user asks, and
  stop.

## Step 2 — Build the delta map

```bash
git -C "$UPSTREAM" log --oneline vLAST..vNEW
git -C "$UPSTREAM" diff --stat vLAST..vNEW
git -C "$UPSTREAM" diff vLAST..vNEW -- <path>   # read every hunk
```

Diff the whole tree, not only `plugins/codex/`: tests, scripts, CI, `package.json`, and README
changes are part of a sync too. Map each changed file:

| Upstream (as of v1.0.6) | Ours | Port action |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` | `.claude-plugin/marketplace.json` | Port field changes; keep our name, owner, and `source: ./plugins/pi` |
| `plugins/codex/.claude-plugin/plugin.json` | `plugins/pi/.claude-plugin/plugin.json` | Port field changes; keep `icon`, `homepage`, `repository`, `license` |
| `plugins/codex/commands/*.md` (8) | `plugins/pi/commands/*.md` (the same 8 plus `task.md`) | Port; flags and values per Step 3 |
| `plugins/codex/agents/codex-rescue.md` | `plugins/pi/agents/pi-rescue.md` | Port; no prompt-shaping skill |
| `plugins/codex/skills/codex-cli-runtime/`, `codex-result-handling/` | `plugins/pi/skills/pi-cli-runtime/`, `pi-result-handling/` | Port |
| `plugins/codex/skills/gpt-5-4-prompting/` | none | Not ported: it targets Codex's models (COMPARISON.md §6) |
| `plugins/codex/hooks/hooks.json` | `plugins/pi/hooks/hooks.json` | Direct |
| `plugins/codex/prompts/adversarial-review.md`, `stop-review-gate.md` | same names | Port with Pi naming |
| none | `plugins/pi/prompts/review.md` | Ours: Pi has no built-in reviewer (COMPARISON.md §4) |
| `plugins/codex/schemas/review-output.schema.json` | same | Direct; Pi has no output schema, so the prompt asks for the shape (COMPARISON.md §4) |
| `plugins/codex/scripts/codex-companion.mjs` | `plugins/pi/scripts/pi-companion.mjs` | Port; app-server calls become `runPiTurn` (Step 4) |
| `plugins/codex/scripts/lib/codex.mjs` | `plugins/pi/scripts/lib/pi.mjs` | Re-express on Pi's CLI and JSONL events (Step 4) |
| `plugins/codex/scripts/app-server-broker.mjs`, `lib/app-server.mjs`, `lib/app-server-protocol.d.ts`, `lib/broker-endpoint.mjs`, `lib/broker-lifecycle.mjs` | none | Not ported: no broker (COMPARISON.md §1). Port what a change does through `runPiTurn`, or record the gap |
| `plugins/codex/scripts/lib/{args,claude-session-transfer,fs,git,job-control,process,prompts,render,state,tracked-jobs,workspace}.mjs` | same names | Port; keep the structure aligned |
| `plugins/codex/scripts/session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs` | same names | Port; no broker teardown |
| `plugins/codex/CHANGELOG.md`, `LICENSE`, `NOTICE` | root `CHANGELOG.md`; `plugins/pi/LICENSE`, `NOTICE` | Not ported: upstream's CHANGELOG is a stub; keep our LICENSE and NOTICE (tests check them) |
| `scripts/bump-version.mjs` | `scripts/bump-version.mjs` | Direct (Pi's plugin path and name only) |
| `tests/*.test.mjs`, `tests/helpers.mjs` | same names | Port and adapt (Step 5) |
| `tests/fake-codex-fixture.mjs` | `tests/fake-pi.cjs`, `tests/fake-pi-fixture.mjs` | Add a fake-`pi` scenario instead (Step 5) |
| `tests/broker-endpoint.test.mjs` | none | Not ported: no broker |
| `.github/workflows/pull-request-ci.yml` | same | Port pin and Node changes; ours installs Claude Code instead of Codex, runs `claude plugin validate --strict`, and has no build |
| `package.json`, `package-lock.json`, `tsconfig.app-server.json` | `package.json`, `package-lock.json` | Port script changes; no `build`/`prebuild` (no app-server types), no TypeScript, no dependencies |
| `README.md` | `README.md` | Port user-facing changes; keep upstream's structure |
| none | `scripts/dev.mjs`, CLAUDE.md, COMPARISON.md, DEVELOPMENT.md, the PR template, the repo skills | Ours |

A file the table does not list is new upstream: decide where it belongs and add a row.

## Step 3 — Check each change against Pi before porting it

Do this for every change that touches Codex behavior: a flag, an accepted value, a CLI call, an
app-server request, an event, or output text.

1. **Read upstream's code** for it: what Codex does, and which flag, values, or app-server call it
   uses.
2. **Read Pi's docs for the same thing.** They ship with Pi; `pi --help` is authoritative for the
   installed version:

   ```bash
   PI_PKG="$(dirname "$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$(command -v pi)")")"
   while [ ! -f "$PI_PKG/package.json" ]; do PI_PKG="$(dirname "$PI_PKG")"; done
   ls "$PI_PKG/docs"   # cli.md, cli-integration.md, json.md, rpc.md, rpc-commands.md, settings.md, sessions.md, security.md, ...
   pi --help
   ```

   Without a local Pi, read `packages/coding-agent/docs/` in
   [earendil-works/pi](https://github.com/earendil-works/pi) at the tag for the version users run
   (tags look like `v1.5.0`). When the docs are not enough, the package's compiled code under
   `$PI_PKG/dist/` shows what Pi actually does.
3. **Run Pi** wherever the docs are silent or the plugin depends on exact behavior (event shapes,
   exit codes, signals): for example
   `pi -p --mode json --no-session "<prompt>" > events.jsonl` in a scratch git repo. Keep the
   output; it is your evidence and the basis for the fake-`pi` scenario.
4. **Decide**:
   - Pi does the same thing: port it the same way, with Pi's flag and value names.
   - Pi does it differently: port the Pi way. Upstream's `--effort` became Pi's `--thinking`, with
     values from Pi's docs, not upstream's.
   - Pi cannot do it: do not ship a shim. Record the gap and the closest Pi behavior.
   - The choice is the user's (dropping a feature, accepting a different UX, picking among valid
     Pi options): ask, and record the answer.
5. **Record it** in COMPARISON.md: the summary row and the numbered section, with evidence per its
   legend (Pi docs, Pi source, Observed, Upstream, Plugin). An unchecked claim does not go in.

## Step 4 — Port the changes

1. **UX parity first.** The command surface, argument hints, rendered output, and progress
   wording match upstream, with Pi in place of Codex, unless Step 3 found that Pi differs.
2. **No broker.** Anything built on the app server becomes one or more `pi -p --mode json` runs.
   Upstream's `lib/codex.mjs` exports map to `lib/pi.mjs` like this:

   | Upstream | Ours |
   | --- | --- |
   | `getCodexAvailability`, `getCodexAuthStatus` | `getPiAvailability`, `getPiAuthStatus` |
   | `runAppServerTurn`, `runAppServerReview` | `runPiTurn` (built on `buildPiArgs`, `spawnPiProcess`, `createPiTurnState`, `handlePiEvent`) |
   | `interruptAppServerTurn` | none: cancel sends SIGTERM (`terminateProcessTree` in `lib/process.mjs`) |
   | `importExternalAgentSession` | `importClaudeSession` |
   | `findLatestTaskThread` | `findLatestTaskThread`, which returns `null`: Pi has no headless session listing |
   | `buildPersistentTaskThreadName`, `parseStructuredOutput` | same names |
   | `readOutputSchema` | none: Pi has no output schema |

3. **Prose says "Pi"**, capitalized. Lowercase `pi` only in literal commands, paths, and flags.
4. **Keep names aligned** (`pi-companion.mjs` ↔ `codex-companion.mjs`, `PI_COMPANION_*` ↔
   `CODEX_COMPANION_*`) so the next sync diffs cleanly.
5. **Surgical edits.** Port the delta, not a rewrite.

## Step 5 — Update the tests (required)

- Port upstream's test changes for the behavior you ported. Upstream fakes the app server
  (`fake-codex-fixture.mjs`); this repo fakes the `pi` binary. Add a scenario to
  `tests/fake-pi.cjs` whose events come from a real Pi run (Step 3), not from Codex's
  notifications.
- Every new flag, branch, or output gets a test: `args.test.mjs` (parsing), `state.test.mjs`,
  `render.test.mjs`, `pi.test.mjs` (event mapping), `runtime.test.mjs` (command behavior), and
  `commands.test.mjs` (command and doc contracts).
- No test runs the real `pi` or touches the network.
- Run `npm test` until it is green. If a ported test cannot pass, fix the port, not the test.

## Step 6 — Known traps

These broke during the first port. Check each against the change you are porting. CLAUDE.md's
"Things that are easy to break" is the running list; add new traps there.

- **Thinking, not effort.** Pi has `--thinking` and no effort setting. The plugin accepts
  `off|minimal|low|medium|high`, the maintainer's choice (COMPARISON.md §6). Never port upstream's
  `--effort` values.
- **No `PI_MODEL`.** Pi reads `defaultProvider` and `defaultModel` from its `settings.json`, and
  `pi auth check` needs `--provider` or `--model`.
- **Read-only means `--tools read,grep,find,ls --no-mcp`.** `--tools` alone leaves MCP tools
  callable, and Pi has no sandbox.
- **Sign-in.** Pi has no login subcommand, and `!pi` cannot reach `/login`, which lives in Pi's
  interactive UI. Tell users to run `pi` in a separate terminal, or to export a provider API key.
- **Events.** `tool_execution_end` carries no `args`; take them from `tool_execution_start` by
  `toolCallId`. Decode the JSONL as UTF-8 and split on LF only, never with `readline`.
- **Progress wording.** Keep upstream's lines with Pi's nouns (`Starting Pi review session.`,
  `Starting Pi task session.`, `Resuming session <id>.`). Pi's events carry no turn ids.
- **Output format.** Reports keep upstream's layout and field order, with `Pi session ID:` and
  `Resume in Pi: pi --session <id>`.
- **Sessions.** Tasks use `--session-id <uuid>` and `--name`; reviews use `--no-session`; never
  pass `--session-dir`.
- **Cancel sends SIGTERM, never SIGKILL.** Pi kills its bash commands only from its SIGTERM
  handler.
- **Stdin.** Spawn `pi -p` with stdin ignored, or it waits for the pipe to close.
- **Tables.** Claude Code prints HTML such as `<br>` in a table cell literally, and a table row is
  one line. Keep lists out of table cells.

## Step 7 — Record the sync

- Run the `release` skill. A sync usually changes `plugins/pi/`, so it bumps the version and
  writes the CHANGELOG section.
- In that section, add the line `Synced upstream: codex-plugin-cc vNEW` exactly in this form
  (`tests/commands.test.mjs` and this skill read it). Add bullets for what was ported, and for what
  was skipped and why, naming its COMPARISON.md section.
- Update COMPARISON.md's version references (its opening line and evidence legend name
  codex-plugin-cc and Pi versions) once every section has been checked against the new versions.

## Step 8 — Verify end to end

```bash
npm test
npm run check-version
claude plugin validate --strict ./plugins/pi
claude plugin validate --strict .
node plugins/pi/scripts/pi-companion.mjs setup
```

If the sync touches tasks or reviews, also do one real run in a scratch git repo
(`node plugins/pi/scripts/pi-companion.mjs task --cwd <repo> "…"`, then `review --cwd <repo>`)
and check `status` and `result`.

## Step 9 — Report

Tell the user the range synced (`vLAST` → `vNEW`), files ported, files skipped (with the
COMPARISON.md section), the Pi evidence behind each difference, tests added or changed, the suite
result, docs updated, and the version bump. Do not commit or push unless the user asks.
