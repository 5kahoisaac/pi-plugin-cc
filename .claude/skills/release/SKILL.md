---
name: release
description: Prepare a change in this repo (pi-plugin-cc) for release. Picks the Semantic Versioning bump against the default branch, sets the version in package.json, package-lock.json, plugin.json, and marketplace.json with `npm run bump-version`, writes the CHANGELOG.md entry under that version, and updates the docs the change makes stale (README, COMPARISON, DEVELOPMENT, CLAUDE.md). Use when a change is ready for a pull request, after fixing a bug or adding or changing a command, flag, output, or setup step, or when asked to bump the version or cut a release. sync-upstream runs it after porting upstream codex-plugin-cc changes.
---

# Release a change

Users install this plugin from the repository's default branch
(`/plugin marketplace add 5kahoisaac/pi-plugin-cc`), so every change merged to `main` that touches
`plugins/pi/` reaches them, but only once the version changes. Claude Code copies an installed
plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and keeps users there:

- "Bump `version` on each release: users stay on their cached copy until the string changes."
- `plugin.json`'s `version` wins over the marketplace entry's. When both are set and differ,
  `claude plugin validate` reports the mismatch.

Both points come from the Claude Code docs, [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace),
"Release a new version".

Run this skill once per pull request, after the code and tests are done. It never commits, tags,
or pushes. Leave those to the user.

## Preconditions

- The change is complete and `npm test` passes. Release notes describe working behavior.
- `origin/main` is current: `git fetch origin`.

## Step 1 — Find the base version and whether the change ships

```bash
git cat-file -e origin/main:package.json \
  && git show origin/main:package.json | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version'
node -p 'require("./package.json").version'           # this branch's version
git diff --name-only origin/main...HEAD -- plugins/pi  # committed on this branch
git status --porcelain -- plugins/pi                   # not committed yet, including new files
```

- **Base version**: the first command's output. If `origin/main` has no `package.json`, this
  branch introduces the first version, `0.1.0`, and needs no bump.
- **Ships**: either of the last two commands lists a file. Only `plugins/pi/` is copied into the
  plugin cache, so a change there needs a version above the base.
- **Repo-only**: nothing under `plugins/pi/` changed (tests, CI, `scripts/`, the skills, README,
  contributor docs, the marketplace listing). It needs no bump. Skip to Step 5; add a CHANGELOG
  line only if this branch already carries a version above the base.

## Step 2 — Choose the version

[SemVer](https://semver.org/) rule 4: "Major version zero (0.y.z) is for initial development.
Anything MAY change at any time. The public API SHOULD NOT be considered stable." This project's
own rule while it is on 0.y.z: breaking changes and new features bump the minor version, and
everything else bumps the patch.

The public interface is what users and Claude touch: the slash commands with their flags,
arguments, and accepted values; each command's rendered output and `--json` payload; the
`pi:pi-rescue` subagent; the hooks' behavior; `PI_COMPANION_*` variables; and the supported Pi and
Node.js versions.

| Change | On 0.y.z | From 1.0.0 |
| --- | --- | --- |
| Breaking: removes or renames a command or flag, rejects input that used to work, changes output or `--json` fields that commands parse, raises the minimum Pi or Node.js version | minor | major |
| Feature: new command, flag, accepted value, or output field that keeps old usage working | minor | minor |
| Fix, prompt or wording change, docs under `plugins/pi/`, refactor, performance | patch | patch |

Then compare this branch's version with the base:

- **Equal**: bump from the base, e.g. a fix on `0.1.0` becomes `0.1.1`.
- **Already above the base**: this branch bumped earlier. Keep it, unless the change now needs a
  higher level (base `0.1.0`, branch `0.1.1`, and you add a feature: re-bump to `0.2.0`).
- If another pull request takes your number first, rebasing conflicts in `package.json` and
  CHANGELOG.md. Rebase onto `main` and run this skill again.

Going to `1.0.0` is the user's decision. Never make that bump on your own.

## Step 3 — Set the version everywhere

```bash
npm run bump-version -- X.Y.Z
```

`scripts/bump-version.mjs` (upstream's script) writes all six fields: `package.json` `version`,
`package-lock.json` `version` and `packages[""].version`, `plugins/pi/.claude-plugin/plugin.json`
`version`, and `.claude-plugin/marketplace.json` `metadata.version` and `plugins[pi].version`.
Like upstream, the version sits in both `plugin.json` and the marketplace entry, so the two must
match. Never edit them by hand. `npm run check-version` confirms they agree, and `npm test` checks the
same in CI.

## Step 4 — Write the CHANGELOG entry

- There is no `[Unreleased]` section. Every change sits under its version heading,
  `## [X.Y.Z] — YYYY-MM-DD`, newest first. `tests/commands.test.mjs` fails unless the newest
  heading is `package.json`'s version.
- For a new version, add its heading above the newest one and date it today. For a re-bump
  (`0.1.1` → `0.2.0`), rename the existing heading. For a version this branch already added, add
  to its section.
- Group bullets under Keep a Changelog's types and use only the ones that apply: `Added`,
  `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. `0.1.0` has only `Added`, because
  there is no earlier version to compare it with.
- Write one bullet per change users can see, saying what they see. For a fix, give the symptom
  and the fix ("`/pi:status` printed a literal `<br>`; each follow-up command now has its own
  line"), not just "fix status".
- Leave the `Synced upstream: codex-plugin-cc vX.Y.Z` line alone unless you are syncing.
  sync-upstream reads the newest one, and a sync adds a new one to its version's section.

## Step 5 — Update the docs the change makes stale

| Change | Doc |
| --- | --- |
| A command, flag, setup step, or output users see | README.md (keep upstream's structure) |
| Something done differently from upstream because Pi differs | COMPARISON.md: the summary row and the numbered section, with evidence (Pi docs, Observed, Upstream, Plugin) |
| Install, readiness, or sign-in | README.md and COMPARISON.md §7 |
| Repo layout, a convention, or a new trap | CLAUDE.md (`AGENTS.md` is a symlink to it) |
| Loading, validation, debugging, or release workflow | DEVELOPMENT.md |
| License or attribution | Never weaken LICENSE or either NOTICE |

Update only the docs the table names. README.md documents behavior, not internals.

## Step 6 — Style gates

- "Pi" is capitalized in prose. Lowercase `pi` only in literal commands, paths, and flags
  (`pi -p`, `/pi:task`, `pi-companion.mjs`).
- State behavior. No marketing language, no TODOs or placeholders.
- Escape `|` inside table cells as `\|`.

## Step 7 — Verify

```bash
npm test
npm run check-version
claude plugin validate --strict ./plugins/pi
claude plugin validate --strict .
```

All four must pass. CI runs the same checks. Re-read each edited doc once, and confirm LICENSE and
both NOTICE files are untouched.

## Step 8 — Report

Tell the user:
- the base version, the new version, and the table row that decided it;
- the files the bump touched and the CHANGELOG section;
- which docs you updated (one line why each) and which you left alone;
- the verification results.

After the pull request merges, the user may tag `v<version>` for a GitHub release (upstream tags
`v1.0.6`). Claude Code does not read tags.

## Notes

- Local testing needs no bump. A marketplace added from a local path (`npm run dev:bind`) loads the
  plugin in place, so edits apply at `/reload-plugins` ([Plugin loading reference](https://code.claude.com/docs/en/plugins/loading),
  "In-place and copied plugins").
- Example: `main` is at `0.1.0` and a branch fixes `render.mjs`. Bump to `0.1.1` and add
  `## [0.1.1] — <today>` with a `### Fixed` bullet. If the same branch then adds `--json` to
  `/pi:status`, re-bump to `0.2.0`, rename the heading, add an `### Added` bullet, and update the
  README usage.
- Example: a branch changes only `tests/` and CI. No bump and no CHANGELOG entry.
