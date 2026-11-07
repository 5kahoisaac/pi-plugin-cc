<!--
Thanks for contributing to pi-plugin-cc!

Before opening the PR, please:
1. Read CLAUDE.md (repo conventions) and, if this changes how the plugin drives Pi, COMPARISON.md.
2. Run the `release` skill. It bumps the version per Semantic Versioning, writes the CHANGELOG.md
   entry, and updates the docs your change affects.
3. Fill in the sections below. Mark the checklist honestly — reviewers rely on it.

CI (.github/workflows/pull-request-ci.yml) checks every PR, so the checklist leaves these out:
`claude plugin validate --strict` on the plugin and the marketplace, `node --check` on every
script, and `npm test`. The tests also check that every manifest carries the same version, that
CHANGELOG.md opens with it, that every JSON file parses, that there are no runtime dependencies,
and that LICENSE and NOTICE are intact.
-->

## What changed

<!-- One-paragraph summary. If this syncs behavior from codex-plugin-cc, name the upstream version and files. -->

## Why

<!-- The bug, gap, or upstream change this addresses. Link issues if any. -->

## How I tested

<!-- What you ran beyond CI, with the observed result. Example:
- `npm run dev:bind`, then in Claude Code: /pi:task --background "…", /pi:status, /pi:result
- node plugins/pi/scripts/pi-companion.mjs setup → ready
-->

## Checklist

- [ ] New or changed behavior has matching test changes in `tests/` (command-level tests use the fake `pi` in `tests/fake-pi.cjs`)
- [ ] I loaded the plugin in Claude Code and exercised the change (`npm run dev:bind` + the relevant `/pi:*` command), or drove `pi-companion.mjs` directly
- [ ] I ran the **release** skill: if `plugins/pi/` changed, the version is above `main`'s; the CHANGELOG.md entry and the affected docs are updated
- [ ] Every new difference from upstream is in COMPARISON.md with its evidence (Pi docs, observed Pi behavior, or upstream source)
- [ ] User-facing prose uses "Pi" (capitalized); lowercase `pi` only in literal commands, paths, and flags
- [ ] If this syncs from codex-plugin-cc: I followed the **sync-upstream** skill and added the new `Synced upstream:` line to CHANGELOG.md

## Notes for reviewers

<!-- Anything non-obvious, tradeoffs made, or things deliberately skipped (with the COMPARISON.md section). -->
