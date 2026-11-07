import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, flagValue, installFakePi, readFakePiCalls, readFakePiRuns } from "./fake-pi-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "pi");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "pi-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const READ_ONLY_ARGS = ["--tools", "read,grep,find,ls", "--no-mcp"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROMPT_FILE_MESSAGE = "Follow the instructions in the attached file.";

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function fakePi(scenario = "ok", options = {}) {
  const binDir = makeTempDir();
  installFakePi(binDir, scenario, options);
  return binDir;
}

function companion(args, { cwd, binDir, env = {}, input } = {}) {
  return run(process.execPath, [SCRIPT, ...args], { cwd, env: buildEnv(binDir, env), input });
}

function containsSequence(argv, sequence) {
  return argv.some((_, index) => sequence.every((token, offset) => argv[index + offset] === token));
}

function isProcessGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

test("setup checks the provider and model Pi starts with by default", () => {
  const binDir = fakePi("ok");
  const result = companion(["setup", "--json"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.pi.detail, "1.5.0");
  assert.equal(payload.auth.detail, "ready (fake, api_key)");
  assert.equal(payload.sessionRuntime.mode, "direct");
  const authCall = readFakePiCalls(binDir).find((call) => call.argv[0] === "auth");
  assert.deepEqual(authCall.argv, ["auth", "check", "--provider", "fake", "--model", "fake-model", "--json"]);
});

test("setup falls back to the models Pi has credentials for when no default model is set", () => {
  const binDir = fakePi("ok", { settings: null });
  const payload = JSON.parse(companion(["setup", "--json"], { cwd: makeRepo(), binDir }).stdout);

  assert.equal(payload.ready, true);
  assert.equal(payload.auth.detail, "ready (1 model available)");
  const calls = readFakePiCalls(binDir);
  assert.equal(calls.some((call) => call.argv[0] === "auth"), false);
  assert.ok(calls.some((call) => call.argv.includes("--list-models") && call.argv.includes("--offline")));
});

test("setup reports Pi's reason and login guidance when credentials are missing", () => {
  const binDir = fakePi("auth-missing");
  const payload = JSON.parse(companion(["setup", "--json"], { cwd: makeRepo(), binDir }).stdout);

  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.detail, "credentials not configured (fake)");
  // Pi delta: Pi has no login subcommand and its TUI needs a real terminal, so the guidance
  // points to a separate terminal instead of Claude Code's `!` shell mode.
  assert.ok(payload.nextSteps.includes("Run `pi` in a separate terminal and use `/login` inside Pi to connect a provider."));
  assert.ok(
    payload.nextSteps.includes(
      "Or export a provider API key such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before starting Claude Code, then rerun `/pi:setup`."
    )
  );
});

test("setup reports no models when Pi has neither a default model nor credentials", () => {
  const binDir = fakePi("no-models", { settings: null });
  const payload = JSON.parse(companion(["setup", "--json"], { cwd: makeRepo(), binDir }).stdout);

  assert.equal(payload.ready, false);
  assert.equal(payload.auth.detail, "no models available");
});

test("setup tells users how to install Pi when it is missing", () => {
  const binDir = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: makeRepo(),
    env: { ...buildEnv(binDir), PATH: binDir }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.pi.available, false);
  assert.ok(
    payload.nextSteps.includes(
      "Install Pi with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (Pi requires Node.js 22.19 or newer)."
    )
  );
});

test("setup renders the upstream report layout", () => {
  const binDir = fakePi("ok");
  const result = companion(["setup"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Pi Setup\n\nStatus: ready\n\nChecks:\n- node: v\d+/);
  assert.match(
    result.stdout,
    /\n- pi: 1\.5\.0\n- auth: ready \(fake, api_key\)\n- session runtime: direct startup\n- review gate: disabled\n/
  );
});

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

test("task runs Pi read-only by default in a new named session", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  const result = companion(["task", "diagnose the flaky test"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\n");
  assert.match(result.stderr, /\[pi\] Starting Pi task session\./);
  assert.match(result.stderr, /\[pi\] Session ready \(/);

  const [turn] = readFakePiRuns(binDir);
  assert.deepEqual(turn.argv.slice(0, 3), ["-p", "--mode", "json"]);
  assert.match(flagValue(turn.argv, "--session-id"), UUID_PATTERN);
  assert.equal(flagValue(turn.argv, "--name"), "Pi Companion Task: diagnose the flaky test");
  assert.ok(containsSequence(turn.argv, READ_ONLY_ARGS));
  assert.equal(turn.prompt, "diagnose the flaky test");
  assert.equal(fs.realpathSync(turn.cwd), fs.realpathSync(repo));
});

test("task --write runs Pi with its normal tool set and reports touched files", () => {
  const binDir = fakePi("write");
  const result = companion(["task", "--write", "--json", "fix the greeting"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.rawOutput, "Edited README.md.");
  assert.deepEqual(payload.touchedFiles, ["README.md"]);

  const [turn] = readFakePiRuns(binDir);
  assert.equal(turn.argv.includes("--tools"), false);
  assert.equal(turn.argv.includes("--no-mcp"), false);
});

test("task --thinking passes Pi's native thinking level through", () => {
  const binDir = fakePi("ok");
  const result = companion(["task", "--thinking", "low", "summarize the module"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  const [turn] = readFakePiRuns(binDir);
  assert.equal(flagValue(turn.argv, "--thinking"), "low");
  assert.equal(turn.prompt, "summarize the module");
});

test("task rejects thinking levels outside Pi's off, minimal, low, medium, high", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  for (const level of ["xhigh", "max", "none"]) {
    const result = companion(["task", "--thinking", level, "summarize"], { cwd: repo, binDir });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`Unsupported thinking level "${level}"\\. Use one of: off, minimal, low, medium, high\\.`)
    );
  }
  assert.equal(readFakePiRuns(binDir).length, 0);
});

test("task --resume-last resumes the latest persisted task session", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  assert.equal(companion(["task", "initial task"], { cwd: repo, binDir }).status, 0);

  const result = companion(["task", "--resume-last", "follow up"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
  const [firstTurn, secondTurn] = readFakePiRuns(binDir);
  const sessionId = flagValue(firstTurn.argv, "--session-id");
  assert.equal(flagValue(secondTurn.argv, "--session-id"), sessionId);
  assert.equal(secondTurn.argv.includes("--name"), false);
  assert.equal(secondTurn.prompt, "follow up");
  assert.ok(result.stderr.includes(`[pi] Resuming session ${sessionId}.`), result.stderr);
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  assert.equal(companion(["task", "initial task"], { cwd: repo, binDir }).status, 0);

  const result = companion(["task", "--resume", "follow up"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  const [firstTurn, secondTurn] = readFakePiRuns(binDir);
  assert.equal(flagValue(secondTurn.argv, "--session-id"), flagValue(firstTurn.argv, "--session-id"));
  assert.equal(secondTurn.prompt, "follow up");
});

test("task --fresh starts a new session and does not leak the flag into the prompt", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  assert.equal(companion(["task", "initial task"], { cwd: repo, binDir }).status, 0);

  const result = companion(["task", "--fresh", "diagnose the flaky test"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  const [firstTurn, secondTurn] = readFakePiRuns(binDir);
  assert.notEqual(flagValue(secondTurn.argv, "--session-id"), flagValue(firstTurn.argv, "--session-id"));
  assert.equal(secondTurn.prompt, "diagnose the flaky test");
});

test("task rejects --resume together with --fresh", () => {
  const result = companion(["task", "--resume", "--fresh", "follow up"], { cwd: makeRepo(), binDir: fakePi("ok") });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --resume\/--resume-last or --fresh\./);
});

test("task --resume-last fails clearly when there is no previous task session", () => {
  const result = companion(["task", "--resume-last", "follow up"], { cwd: makeRepo(), binDir: fakePi("ok") });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /No previous Pi task session was found for this repository\./);
});

test("task succeeds when Pi recovers from a provider error through its automatic retry", () => {
  const binDir = fakePi("retry");
  const result = companion(["task", "summarize the module"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Recovered after retry.\n");
  assert.match(result.stderr, /\[pi\] Retrying after Pi error \(attempt 1\/3\)\./);
});

test("task fails with Pi's error when the final turn errors", () => {
  const binDir = fakePi("error");
  const result = companion(["task", "summarize the module"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "401 invalid api key\n");
  assert.match(result.stderr, /\[pi\] Pi error: 401 invalid api key/);
});

test("task decodes Pi's JSONL as one UTF-8 stream across chunk boundaries", () => {
  const binDir = fakePi("utf8-split");
  const result = companion(["task", "summarize"], { cwd: makeRepo(), binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "完成 ✅ — 測試通過\n");
});

test("task sends oversized or dash-leading prompts to Pi as an attached file", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  const promptDir = makeTempDir();
  const prompts = ["x".repeat(100 * 1024), "- list the risks"];

  for (const [index, prompt] of prompts.entries()) {
    const promptFile = path.join(promptDir, `prompt-${index}.md`);
    fs.writeFileSync(promptFile, prompt);
    const result = companion(["task", "--prompt-file", promptFile], { cwd: repo, binDir });
    assert.equal(result.status, 0, result.stderr);
  }

  const runs = readFakePiRuns(binDir);
  assert.equal(runs.length, prompts.length);
  for (const [index, prompt] of prompts.entries()) {
    const turn = runs[index];
    const attachment = turn.argv.find((arg) => arg.startsWith("@"));
    assert.ok(attachment, "the prompt is delivered as an @file attachment");
    assert.equal(turn.argv.at(-1), PROMPT_FILE_MESSAGE);
    assert.equal(turn.prompt, `${prompt}\n${PROMPT_FILE_MESSAGE}`);
    assert.equal(fs.existsSync(attachment.slice(1)), false, "the temporary prompt file is removed");
  }
});

test("task-resume-candidate only offers task sessions from the current Claude session", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");
  const sessionA = { PI_COMPANION_SESSION_ID: "sess-a" };
  assert.equal(companion(["task", "initial task"], { cwd: repo, binDir, env: sessionA }).status, 0);
  const [turn] = readFakePiRuns(binDir);

  const current = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, binDir, env: sessionA }).stdout);
  assert.equal(current.available, true);
  assert.equal(current.candidate.threadId, flagValue(turn.argv, "--session-id"));

  const other = JSON.parse(
    companion(["task-resume-candidate", "--json"], { cwd: repo, binDir, env: { PI_COMPANION_SESSION_ID: "sess-b" } }).stdout
  );
  assert.equal(other.available, false);
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

test("review sends Pi the standard review prompt read-only without saving a session", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello\nREVIEW_MARKER\n");
  const binDir = fakePi("review");

  const result = companion(["review"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "# Pi Review\n\nTarget: working tree diff\n\nThe change is small and safe to merge.\nNo material findings.\n"
  );
  // Upstream's native review says "Starting Codex review thread." (runAppServerReview).
  assert.match(result.stderr, /\[pi\] Starting Pi review session\./);
  assert.doesNotMatch(result.stderr, /Starting Pi task session/);
  const [turn] = readFakePiRuns(binDir);
  assert.ok(turn.argv.includes("--no-session"));
  assert.equal(turn.argv.includes("--session-id"), false);
  assert.ok(containsSequence(turn.argv, READ_ONLY_ARGS));
  assert.match(turn.prompt, /<repository_context>/);
  assert.match(turn.prompt, /REVIEW_MARKER/);
});

test("adversarial review renders Pi's structured findings", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello\nretry change\n");
  const binDir = fakePi("adversarial");

  const result = companion(["adversarial-review", "challenge the retry design"], { cwd: repo, binDir });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Pi Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n/);
  assert.match(result.stdout, /- \[high\] Missing empty-state guard \(src\/app\.js:4-6\)/);
  assert.match(result.stdout, /Next steps:\n- Add a regression test for an empty queue\./);
  // Upstream runs adversarial reviews as a turn, so it says "Starting Codex task thread.".
  assert.match(result.stderr, /\[pi\] Starting Pi task session\./);
  const [turn] = readFakePiRuns(binDir);
  assert.match(turn.prompt, /challenge the retry design/);
  assert.ok(turn.argv.includes("--no-session"));
  assert.ok(containsSequence(turn.argv, READ_ONLY_ARGS));
});

test("review rejects focus text and points to adversarial review", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello\nchange\n");
  const binDir = fakePi("review");
  const result = companion(["review", "focus on security"], { cwd: repo, binDir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /`\/pi:review` maps directly to the standard reviewer and does not support custom focus text/);
  assert.equal(readFakePiRuns(binDir).length, 0);
});

// ---------------------------------------------------------------------------
// background jobs: status, result, cancel
// ---------------------------------------------------------------------------

test("task --background enqueues a detached worker and exposes per-job status and result", async () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");

  const launched = companion(["task", "--background", "--json", "investigate the failing test"], { cwd: repo, binDir });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waited = companion(
    ["status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "100", "--json"],
    { cwd: repo, binDir }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = companion(["result", launchPayload.jobId, "--json"], { cwd: repo, binDir });
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  });
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task\./);
});

test("cancel stops a running background Pi task, its Pi process, and records the cancellation", async () => {
  const repo = makeRepo();
  const binDir = fakePi("slow");

  const launched = companion(["task", "--background", "--json", "long investigation"], { cwd: repo, binDir });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const running = await waitFor(() => {
    const job = JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, binDir }).stdout).job;
    return job.status === "running" && job.pid && readFakePiRuns(binDir).length > 0 ? job : null;
  });
  const piPid = readFakePiRuns(binDir)[0].pid;

  const cancel = companion(["cancel", jobId, "--json"], { cwd: repo, binDir });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).status, "cancelled");

  await waitFor(() => isProcessGone(running.pid) && isProcessGone(piPid));
  // The worker exits on SIGTERM without overwriting the cancelled record.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, binDir }).stdout).job;
  assert.equal(after.status, "cancelled");
});

test("status, result, and cancel fail cleanly in a repository without jobs", () => {
  const repo = makeRepo();
  const binDir = fakePi("ok");

  const status = companion(["status"], { cwd: repo, binDir });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /No jobs recorded yet\./);

  const result = companion(["result"], { cwd: repo, binDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No finished Pi jobs found for this repository yet\./);

  const cancel = companion(["cancel"], { cwd: repo, binDir });
  assert.notEqual(cancel.status, 0);
  assert.match(cancel.stderr, /No active Pi jobs to cancel\./);
});

// ---------------------------------------------------------------------------
// stop-time review gate
// ---------------------------------------------------------------------------

function runStopHook(repo, binDir, sessionId) {
  return run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: sessionId,
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
}

test("stop hook blocks on findings from a read-only Pi stop-gate review", () => {
  const repo = makeRepo();
  const binDir = fakePi("stop-block");
  const setup = companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, binDir });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\nretry change\n");

  const blocked = runStopHook(repo, binDir, "sess-stop-review");

  assert.equal(blocked.status, 0, blocked.stderr);
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Pi stop-time review found issues that still need fixes/);
  assert.match(decision.reason, /Missing empty-state guard/);
  const turn = readFakePiRuns(binDir).at(-1);
  assert.match(turn.prompt, /Only review the work from the previous Claude turn/);
  assert.match(turn.prompt, /I completed the refactor and updated the retry logic\./);
  assert.match(turn.prompt, /<repository_context>/);
  assert.match(turn.prompt, /retry change/);
  assert.ok(containsSequence(turn.argv, READ_ONLY_ARGS));
});

test("stop hook allows the stop when the stop-gate review is clean", () => {
  const repo = makeRepo();
  const binDir = fakePi("stop-allow");
  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, binDir }).status, 0);

  const allowed = runStopHook(repo, binDir, "sess-stop-allow");

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  assert.equal(readFakePiRuns(binDir).length, 1);
});

test("stop hook does not run Pi when the review gate is disabled", () => {
  const repo = makeRepo();
  const binDir = fakePi("stop-block");

  const result = runStopHook(repo, binDir, "sess-gate-off");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFakePiRuns(binDir).length, 0);
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test("help lists Pi's thinking flag and no effort flag", () => {
  const result = companion(["help"], { cwd: makeRepo(), binDir: fakePi("ok") });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--thinking <off\|minimal\|low\|medium\|high>/);
  assert.doesNotMatch(result.stdout, /--effort/);
});

test("unknown subcommands fail with a clear error", () => {
  const result = companion(["frobnicate"], { cwd: makeRepo(), binDir: fakePi("ok") });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown subcommand: frobnicate/);
});
