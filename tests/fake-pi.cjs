// Stand-in for the `pi` CLI used by the runtime tests. It follows Pi's documented headless
// contract (docs/json.md in @earendil-works/pi-coding-agent): `pi -p --mode json` prints a
// session header, then agent/turn/message/tool events as JSONL on stdout. It implements only
// what the plugin calls: `--version`, `auth check`, `--list-models`, and `-p --mode json`.
//
// installFakePi() installs this file as `pi`, prefixed with `const SCENARIO = "<name>";`.
// Every invocation is appended to fake-pi-calls.jsonl next to the executable.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BIN_DIR = path.dirname(fs.realpathSync(process.argv[1]));
const CALLS_FILE = path.join(BIN_DIR, "fake-pi-calls.jsonl");
const SESSIONS_FILE = path.join(BIN_DIR, "fake-pi-sessions.json");
const STOP_GATE_MARKER = "Run a stop-gate review of the previous Claude turn.";
const VALUE_FLAGS = new Set([
  "--mode",
  "--session-id",
  "--session",
  "--session-dir",
  "--name",
  "--model",
  "--provider",
  "--thinking",
  "--tools"
]);

const ADVERSARIAL_REVIEW = {
  verdict: "needs-attention",
  summary: "One blocking issue in the retry path.",
  findings: [
    {
      severity: "high",
      title: "Missing empty-state guard",
      body: "retry() reads items[0] without checking for an empty queue.",
      file: "src/app.js",
      line_start: 4,
      line_end: 6,
      confidence: 0.8,
      recommendation: "Return early when the queue is empty."
    }
  ],
  next_steps: ["Add a regression test for an empty queue."]
};

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (VALUE_FLAGS.has(token)) {
      flags[token.slice(2)] = argv[index + 1];
      index += 1;
    } else if (token.startsWith("-")) {
      flags[token.replace(/^-+/, "")] = true;
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

// Pi inlines `@file` arguments into the first user message.
function resolvePrompt(positionals) {
  return positionals.map((arg) => (arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg)).join("\n");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Working through the request." },
      { type: "text", text }
    ],
    stopReason: "stop",
    usage: { input: 12, output: 7, totalTokens: 19 }
  };
}

function endTurn(message) {
  emit({ type: "message_end", message });
  emit({ type: "turn_end", message, toolResults: [] });
}

function endRun() {
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled", aborted: false });
}

function runTool(toolCallId, toolName, args) {
  emit({ type: "tool_execution_start", toolCallId, toolName, args });
  emit({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { content: [{ type: "text", text: "ok" }], details: {} },
    isError: false,
    durationMs: 1
  });
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function replyFor(prompt, resumed) {
  if (prompt.includes(STOP_GATE_MARKER)) {
    return SCENARIO === "stop-block"
      ? "BLOCK: Missing empty-state guard in src/app.js."
      : "ALLOW: No blocking issues found.";
  }
  if (SCENARIO === "adversarial") {
    return JSON.stringify(ADVERSARIAL_REVIEW);
  }
  if (SCENARIO === "review") {
    return "The change is small and safe to merge.\nNo material findings.";
  }
  return resumed ? "Resumed the prior run.\nFollow-up prompt accepted." : "Handled the requested task.";
}

function printRun(flags, positionals) {
  const prompt = resolvePrompt(positionals);
  const sessionId = typeof flags["session-id"] === "string" ? flags["session-id"] : null;
  const sessions = loadSessions();
  const resumed = Boolean(sessionId && sessions[sessionId]);
  if (sessionId) {
    if (!resumed) {
      process.stderr.write(`Warning: No project session found with id '${sessionId}'; creating a new session with that id.\n`);
    }
    sessions[sessionId] = { name: flags.name ?? sessions[sessionId]?.name ?? null, cwd: process.cwd() };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), "utf8");
  }

  emit({ type: "session", version: 3, id: sessionId ?? crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_end", message: { role: "user", content: prompt, timestamp: Date.now() } });

  switch (SCENARIO) {
    case "slow":
      emit({ type: "tool_execution_start", toolCallId: "call_slow", toolName: "bash", args: { command: "sleep 600" } });
      process.on("SIGTERM", () => process.exit(143));
      setInterval(() => {}, 1000);
      return;
    case "error":
      endTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid api key" });
      endRun();
      return;
    case "retry":
      endTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" });
      emit({ type: "agent_end", messages: [], willRetry: true });
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529 overloaded" });
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
      endTurn(assistantMessage("Recovered after retry."));
      emit({ type: "auto_retry_end", success: true, attempt: 2 });
      endRun();
      return;
    case "write":
      runTool("call_edit", "edit", { path: "README.md", oldText: "hello", newText: "hello pi" });
      endTurn(assistantMessage("Edited README.md."));
      endRun();
      return;
    case "utf8-split": {
      // One JSONL record split inside a multi-byte character, across two separate writes.
      const line = `${JSON.stringify({ type: "turn_end", message: assistantMessage("完成 ✅ — 測試通過"), toolResults: [] })}\n`;
      const bytes = Buffer.from(line, "utf8");
      const cut = bytes.indexOf(Buffer.from("✅", "utf8")) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(cut));
        endRun();
      }, 100);
      return;
    }
    default:
      runTool("call_read", "read", { path: "README.md" });
      endTurn(assistantMessage(replyFor(prompt, resumed)));
      endRun();
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgv(argv);
  const call = { argv, cwd: process.cwd(), pid: process.pid, prompt: resolvePrompt(positionals) };
  fs.appendFileSync(CALLS_FILE, `${JSON.stringify(call)}\n`);

  if (flags.version) {
    process.stdout.write("1.5.0\n");
    return;
  }
  if (positionals[0] === "auth" && positionals[1] === "check") {
    const provider = typeof flags.provider === "string" ? flags.provider : "fake";
    if (SCENARIO === "auth-missing") {
      process.stdout.write(`${JSON.stringify({ status: "not_ready", provider, reason: "credentials_not_configured" })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ status: "ready", provider, authType: "api_key" })}\n`);
    return;
  }
  if (flags["list-models"]) {
    if (SCENARIO === "auth-missing" || SCENARIO === "no-models") {
      process.stdout.write("No models available. Use /login to log into a provider via OAuth or API key. See:\n  docs/providers.md\n");
      return;
    }
    process.stdout.write("provider  model       context  max-out  thinking  images\nfake      fake-model  128K     16K      yes       no\n");
    return;
  }
  if (flags.p || flags.print) {
    printRun(flags, positionals);
    return;
  }
  process.stderr.write(`fake pi: unsupported invocation: ${argv.join(" ")}\n`);
  process.exitCode = 2;
}

main();
