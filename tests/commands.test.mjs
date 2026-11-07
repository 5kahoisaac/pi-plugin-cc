import crypto from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "pi");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function readRoot(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function listFiles(dir, extensions) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(fullPath, extensions);
    }
    return extensions.includes(path.extname(entry.name)) ? [fullPath] : [];
  });
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Pi's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pi-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Pi review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
  // Pi delta: Pi has no built-in reviewer, so the plugin supplies the review prompt.
  assert.match(source, /Pi has no built-in reviewer/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Pi's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pi-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Pi adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/pi:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command; /pi:task is the one plugin addition", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "task.md",
    "transfer.md"
  ]);
});

test("status command lists follow-up commands one per line, outside table cells", () => {
  const status = read("commands/status.md");

  assert.match(status, /List the follow-up commands below the table, one command per line/);
  assert.match(status, /Never put several commands in one table cell or use HTML such as `<br>`/);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/pi-rescue.md");
  const readme = readRoot("README.md");
  const runtimeSkill = read("skills/pi-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Pi's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Same transport pin as upstream (#234): route through the Agent tool and never re-enter
  // this command through Skill under `context: fork`.
  assert.match(rescue, /subagent_type: "pi:pi-rescue"/);
  assert.match(rescue, /do not call `Skill\(pi:pi-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model>/);
  // Pi delta: Pi has thinking levels, not reasoning effort, and no `spark` alias.
  assert.match(rescue, /--thinking <off\|minimal\|low\|medium\|high>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Pi session/);
  assert.match(rescue, /Start a new Pi session/);
  assert.match(rescue, /run the `pi:pi-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--thinking` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--thinking` unset unless the user explicitly asks for a specific thinking level/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new session, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Pi companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);

  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Pi running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--thinking` unset unless the user explicitly requests a specific thinking level/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for a concrete model, pass it through with `--model` as given/i);
  assert.match(agent, /Return the stdout of the `pi-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Pi cannot be invoked, return nothing/i);
  // Pi delta: the GPT-5.4 prompting skill is not ported; the subagent forwards the request as-is.
  assert.match(agent, /skills:\n\s+- pi-cli-runtime\n---/);
  assert.doesNotMatch(agent, /prompting/i);

  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /Do not do any Claude-side work beyond building that single `task` call/i);
  assert.match(runtimeSkill, /Leave `--thinking` unset unless the user explicitly requests a specific thinking level/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--thinking`: accepted values are `off`, `minimal`, `low`, `medium`, `high`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Pi cannot be invoked, return nothing/i);

  assert.match(readme, /`pi:pi-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--thinking`, Pi uses its own defaults/i);
  // A model with reasoning support in Pi's registry, so the thinking level is not clamped to off.
  assert.match(readme, /--model anthropic\/claude-sonnet-4-5 --thinking low/);
  assert.match(readme, /continue a previous Pi task/i);
  assert.match(readme, /### `\/pi:setup`/);
  assert.match(readme, /### `\/pi:review`/);
  assert.match(readme, /### `\/pi:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/pi:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/pi:rescue`/);
  assert.match(readme, /### `\/pi:task`/);
  assert.match(readme, /### `\/pi:transfer`/);
  assert.match(readme, /### `\/pi:status`/);
  assert.match(readme, /### `\/pi:result`/);
  assert.match(readme, /### `\/pi:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/pi-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /pi-companion\.mjs" transfer "\$ARGUMENTS"/);
  // Pi delta: Pi reopens a session with `pi --session <id>`, not `codex resume <id>`.
  assert.match(transfer, /pi --session <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /pi-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /pi-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Pi run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Pi was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/pi-cli-runtime/SKILL.md");

  assert.match(runtimeSkill, /pi-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Pi install and still points users to /login", () => {
  const setup = read("commands/setup.md");
  const readme = readRoot("README.md");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  // Pi delta: Pi's documented npm install, which needs Node.js 22.19+.
  assert.match(setup, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  assert.match(setup, /Node\.js 22\.19 or newer/);
  assert.match(setup, /pi-companion\.mjs" setup --json \$ARGUMENTS/);
  // Pi delta: Pi has no login subcommand; `/login` lives in Pi's TUI, which needs a real terminal.
  assert.match(setup, /run `pi` in a separate terminal and use `\/login` inside Pi/i);
  assert.match(readme, /run `pi` in a separate terminal and use `\/login` inside Pi/i);
  assert.match(readme, /offer to install Pi for you/i);
  assert.match(readme, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  assert.match(readme, /\/pi:setup --enable-review-gate/);
  assert.match(readme, /\/pi:setup --disable-review-gate/);
});

test("task command documents Pi's read-only tool set and the missing sandbox", () => {
  const task = read("commands/task.md");
  const readme = readRoot("README.md");

  assert.match(task, /disable-model-invocation:\s*true/);
  assert.match(task, /--thinking <off\|minimal\|low\|medium\|high>/);
  assert.match(task, /--resume-last\|--resume\|--fresh/);
  assert.match(task, /pi-companion\.mjs" task \$ARGUMENTS/);
  assert.match(task, /`read`, `grep`, `find`, `ls`/);
  assert.match(task, /Pi has no sandbox/);
  assert.match(readme, /Pi has no sandbox/);
  assert.match(readme, /`read`, `grep`, `find`, and `ls`/);
  assert.match(readme, /pi --session <session-id>/);
});

test("user-facing plugin files carry no Codex-only names or options", () => {
  const files = [
    ...listFiles(PLUGIN_ROOT, [".md", ".json"]),
    path.join(ROOT, ".claude-plugin", "marketplace.json"),
    path.join(ROOT, "README.md")
  ];
  const forbidden = [
    /\bcodex\b(?!-plugin-cc)/i,
    /@openai\/codex/,
    /\bspark\b/i,
    /gpt-5/i,
    /--effort/,
    /\bxhigh\b/,
    /gpt-5-4-prompting/,
    /PI_MODEL/,
    /config set/,
    /--session-dir/,
    // Pi's TUI cannot run inside Claude Code's `!` shell mode, so no doc may suggest `!pi`.
    /!pi\b/
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path.relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test("runtime scripts use only Pi's real thinking levels and environment", () => {
  for (const file of listFiles(path.join(PLUGIN_ROOT, "scripts"), [".mjs"])) {
    const source = fs.readFileSync(file, "utf8");
    // PI_MODEL is not a Pi environment variable; Pi reads its defaults from settings.json.
    assert.doesNotMatch(source, /PI_MODEL/, path.relative(ROOT, file));
    assert.doesNotMatch(source, /\bxhigh\b/, path.relative(ROOT, file));
  }
});

test("plugin manifests describe Pi with a capitalized name", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(readRoot(".claude-plugin/marketplace.json"));
  const pkg = JSON.parse(readRoot("package.json"));

  assert.equal(plugin.name, "pi");
  assert.match(plugin.description, /^Use Pi from Claude Code/);
  assert.match(marketplace.plugins[0].description, /^Use Pi from Claude Code/);
  assert.match(pkg.description, /^Use Pi from Claude Code/);
});

test("plugin manifest points its icon at the bundled Pi image", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(readRoot(".claude-plugin/marketplace.json"));

  // Anthropic's directory reads `icon` from plugin.json only; in a marketplace entry
  // `claude plugin validate` reports it as an unknown field.
  assert.equal(plugin.icon, "./assets/icon.png");
  assert.equal("icon" in marketplace.plugins[0], false);
  const icon = fs.readFileSync(path.join(PLUGIN_ROOT, plugin.icon));
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "icon starts with the PNG signature");
  assert.equal(icon.subarray(-8, -4).toString("ascii"), "IEND", "icon is a complete PNG");
  // The artwork is drawn on a transparent background; a flattened copy loses it.
  assert.equal(icon[25], 6, "icon keeps its alpha channel (IHDR color type 6, RGBA)");
});

// The guards below replace PR-checklist items: CI runs `npm test` on every pull request.

test("CHANGELOG opens with the package version and records the synced upstream release", () => {
  const { version } = JSON.parse(readRoot("package.json"));
  const changelog = readRoot("CHANGELOG.md");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // The release skill files every change under a version heading; there is no Unreleased section.
  assert.match(changelog.match(/^## .*$/m)?.[0] ?? "", new RegExp(`^## \\[${escapedVersion}\\] — \\d{4}-\\d{2}-\\d{2}$`));
  // The sync-upstream skill takes the last synced upstream release from the newest line like this.
  assert.match(changelog, /^Synced upstream: codex-plugin-cc v\d+\.\d+\.\d+$/m);
});

test("the plugin and repo scripts use only Node's standard library", () => {
  const pkg = JSON.parse(readRoot("package.json"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    assert.equal(pkg[field], undefined, `package.json declares ${field}`);
  }

  const specifierPattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;
  const files = [
    ...listFiles(path.join(PLUGIN_ROOT, "scripts"), [".mjs", ".cjs", ".js"]),
    ...listFiles(path.join(ROOT, "scripts"), [".mjs", ".cjs", ".js"])
  ];
  let checked = 0;
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const isLocal = specifier.startsWith("./") || specifier.startsWith("../");
      assert.ok(isBuiltin(specifier) || isLocal, `${path.relative(ROOT, file)} imports ${specifier}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "found no imports to check");
});

test("LICENSE and NOTICE keep the Apache-2.0 license and the codex-plugin-cc attribution", () => {
  // Both LICENSE files are codex-plugin-cc's Apache-2.0 text, byte for byte (LF line endings).
  for (const file of ["LICENSE", "plugins/pi/LICENSE"]) {
    const text = readRoot(file).replace(/\r\n/g, "\n");
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    assert.equal(digest, "e591c02a0b2ea7717d99e15bd51ea05d879bbf5a4452d66d15b51a7107d3821a", `${file} is not the Apache-2.0 text`);
  }
  for (const file of ["NOTICE", "plugins/pi/NOTICE"]) {
    assert.match(
      readRoot(file).replace(/\r\n/g, "\n"),
      /This product includes software adapted from codex-plugin-cc\.\nCopyright 2026 OpenAI\nLicensed under the Apache License, Version 2\.0/,
      file
    );
  }
  assert.equal(JSON.parse(readRoot("package.json")).license, "Apache-2.0");
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).license, "Apache-2.0");
});

test("every JSON file in the package, marketplace, and plugin parses", () => {
  const files = [
    path.join(ROOT, "package.json"),
    path.join(ROOT, "package-lock.json"),
    ...listFiles(path.join(ROOT, ".claude-plugin"), [".json"]),
    ...listFiles(PLUGIN_ROOT, [".json"])
  ];
  for (const file of files) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), path.relative(ROOT, file));
  }
});
