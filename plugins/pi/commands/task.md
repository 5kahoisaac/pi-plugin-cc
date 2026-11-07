---
description: Delegate a task to Pi through the companion runtime
argument-hint: '[--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--thinking <off|minimal|low|medium|high>] [--prompt-file <path>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Delegate a task to Pi through the Pi companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Your only job is to forward the user's arguments to the Pi companion script. Do not do the task yourself.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" task $ARGUMENTS
```

Rules:

- Preserve the user's arguments exactly. Do not strip flags or rewrite the prompt.
- Foreground by default. `--background` spawns a detached worker; the script prints the job id — tell the user to check `/pi:status` and fetch with `/pi:result`.
- Without `--write`, Pi runs with only its read-only tools (`read`, `grep`, `find`, `ls`) and no MCP tools, so it cannot edit files or run shell commands.
- `--write` runs Pi with its normal tool set (by default `read`, `bash`, `edit`, `write`, plus any MCP and extension tools). Pi has no sandbox, so these tools run with the user's own permissions.
- `--resume-last` (or `--resume`) continues the most recent Pi task session for this repository in the current Claude session.
- `--fresh` starts a new session; this is the default when neither resume flag is present.
- `--model` and `--thinking` pass through to Pi's `--model` and `--thinking` flags.
- If the prompt is large, prefer `--prompt-file <path>` instead of a huge positional prompt.
- Reply with the script output verbatim. Do not summarize, do not continue Pi's work yourself.

On failure:
- If the script exits non-zero, report stderr verbatim and stop. Do not retry, do not diagnose, do not apply fixes.
