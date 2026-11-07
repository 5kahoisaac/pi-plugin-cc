# DEVELOPMENT.md

How to develop, test, and contribute to `pi-plugin-cc`. Read [CLAUDE.md](./CLAUDE.md) (also
`AGENTS.md`) for repo conventions and [COMPARISON.md](./COMPARISON.md) for the Pi/Codex
architecture mapping.

## Prerequisites

- **Node.js 22.19+** (matches Pi's own requirement; the plugin runtime needs ≥18.18)
- **Claude Code** (`claude`) on PATH
- **Pi** on PATH with at least one authenticated provider — needed for end-to-end runs:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# then: run `pi`, use /login inside it (or export a provider API key)
node plugins/pi/scripts/pi-companion.mjs setup   # should report ready
```

## Repo layout

See [CLAUDE.md](./CLAUDE.md#repo-layout). The short version: the plugin lives in
`plugins/pi/` (manifest, commands, agent, hooks, prompts, schema, scripts) and tests in `tests/`.
Two repo skills cover maintenance: `sync-upstream` ports upstream changes, and `release`
versions and documents each change. `scripts/dev.mjs` binds and unbinds the local plugin in
Claude Code, and `scripts/bump-version.mjs` sets the version in every manifest.

## Run the tests

```bash
npm test
```

`node --test` over `tests/*.test.mjs`. Tests must pass before you push. The suite is hermetic:
command-level tests put a fake `pi` (`tests/fake-pi.cjs`, installed by
`tests/fake-pi-fixture.mjs`) first on `PATH`. It emits Pi 1.5.0's JSONL events per scenario and
logs each call's argv and prompt, so no test runs the real `pi` or touches the network.

## Validate the plugin and marketplace

```bash
claude plugin validate --strict ./plugins/pi   # plugin manifest + structure
claude plugin validate --strict .              # marketplace manifest (.claude-plugin/marketplace.json)
```

Both must end with `✔ Validation passed`. `--strict` treats warnings, such as unrecognized fields
or missing metadata, as errors. CI runs both commands this way with Claude Code 2.1.319, and
neither needs a sign-in. Anthropic's plugin directory also runs a safety scan and a policy review
that this command does not, so keep hooks and commands obvious and free of obfuscated code.

## Load the plugin in local Claude Code

You do **not** need to publish anything to develop. The fastest path is the dev script, which
registers this checkout as a local marketplace and installs the plugin from it:

```bash
npm run dev:bind      # register + install from this checkout
```

Then reload plugins in your Claude Code session (`/reload-plugins` or a new session) and verify:

- `/pi:setup` runs and reports status
- `/agents` lists `pi:pi-rescue`
- `npm run dev:status` shows the binding and the folder it points at

When you're done:

```bash
npm run dev:unbind    # uninstall plugin + remove local marketplace
```

`bind` is idempotent: re-running it re-points the binding at the current checkout (useful after
moving/renaming). Set `CLAUDE_BIN` if `claude` is not on PATH.

### Manual alternative — local marketplace

If you prefer the raw commands (same thing the script does):

```bash
# from the repo root (the directory containing .claude-plugin/)
claude plugin marketplace add ./
claude plugin install pi@5kahoisaac-pi
```

Inside an interactive session the same steps are `/plugin marketplace add ./` and
`/plugin install pi@5kahoisaac-pi`. Uninstall with
`claude plugin uninstall pi@5kahoisaac-pi` and `claude plugin marketplace remove 5kahoisaac-pi`.

### Manual alternative — load straight from the plugin folder

For iterating on a single plugin without the marketplace layer:

```bash
claude --plugin-dir ./plugins/pi
```

(or set the same flag on a nested session). Commands appear as `/pi:*`, the subagent as
`pi:pi-rescue`, and hooks run from `plugins/pi/hooks/hooks.json` with
`CLAUDE_PLUGIN_ROOT` pointing at the plugin folder.

### Verify it loaded

In a Claude Code session in any directory:

- `/pi:setup` should run and report status
- `/agents` should list `pi:pi-rescue`
- `/plugin` should show the plugin (dev:bind install; --plugin-dir shows it as a dev load)

## Iterate on the plugin scripts

The companion CLI is a plain Node script — you can drive it directly, without Claude Code:

```bash
SC=plugins/pi/scripts/pi-companion.mjs
node $SC help
node $SC setup
node $SC status --all
node $SC task --cwd /tmp/scratch-repo "Summarize this repository."   # foreground, read-only
node $SC review --cwd /tmp/scratch-repo                              # real Pi review
```

For background jobs, use `--background` then poll `status`/`result` — that's the same path the
slash commands take. Job state lands in `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>`
when running under Claude Code, or `pi-companion/<workspace-slug>-<hash>` under the OS temp
directory (`os.tmpdir()`) otherwise.

### Debugging hooks

- `SessionStart`/`SessionEnd` hooks capture env (`PI_COMPANION_SESSION_ID`,
  `PI_COMPANION_TRANSCRIPT_PATH`) via `CLAUDE_ENV_FILE`; run
  `claude --debug` to see hook stderr.
- The `Stop` hook (`stop-review-gate-hook.mjs`) is config-gated. Enable it per workspace with
  `node plugins/pi/scripts/pi-companion.mjs setup --cwd <repo> --enable-review-gate` (the same
  path as `/pi:setup --enable-review-gate`) and check job logs under the state dir if it
  misbehaves. It prints a JSON decision line to stdout only when it blocks.
- Every job writes `jobs/<id>.log` next to `jobs/<id>.json` in the state dir — check that first
  when a background task fails silently.

## Syncing from upstream (codex-plugin-cc)

Use the `sync-upstream` skill. The short version: diff upstream's newest release against the last
synced one, check Pi's docs and behavior before porting each change, **always add/update tests**,
record each Pi difference in COMPARISON.md, then run the `release` skill.

## Versions and releases

Run the `release` skill once per pull request, after your change and its tests are done. When
`plugins/pi/` changed, it raises the version above `main`'s per Semantic Versioning, because
users stay on their cached copy of the plugin until the version string changes. It sets every
manifest with `npm run bump-version -- X.Y.Z` (`npm run check-version` verifies them), writes the
CHANGELOG.md entry under that version, and updates the docs the change makes stale. Testing
through `npm run dev:bind` needs no bump: a marketplace added from a local path loads the plugin
in place.

## Pull requests

The checklist lives in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`). CI
(`.github/workflows/pull-request-ci.yml`) runs on every pull request: `claude plugin validate
--strict` on the plugin and the marketplace, `node --check` on every script, and `npm test`. The
tests also check that the manifests share one version, that CHANGELOG.md opens with it, that every
JSON file parses, that there are no runtime dependencies, and that LICENSE and NOTICE are intact.
