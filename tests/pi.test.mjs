import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPersistentTaskThreadName,
  buildPiArgs,
  createPiTurnState,
  findLatestTaskThread,
  getSessionRuntimeStatus,
  handlePiEvent,
  parseStructuredOutput,
  readClaudeTranscriptMessages,
  READ_ONLY_TOOLS
} from "../plugins/pi/scripts/lib/pi.mjs";
import { makeTempDir } from "./helpers.mjs";

const READ_ONLY_ARGS = ["--tools", "read,grep,find,ls", "--no-mcp"];

function trackProgress(threadId = null) {
  const events = [];
  const state = createPiTurnState({
    threadId,
    onProgress: (event) => events.push(typeof event === "string" ? { message: event, phase: null } : event)
  });
  return { state, events };
}

function assistantTurn(content, extra = {}) {
  return { type: "turn_end", message: { role: "assistant", content, stopReason: "stop", ...extra }, toolResults: [] };
}

function erroredTurn(errorMessage) {
  const message = { role: "assistant", content: [], stopReason: "error", ...(errorMessage ? { errorMessage } : {}) };
  return { type: "turn_end", message, toolResults: [] };
}

// ---------------------------------------------------------------------------
// buildPiArgs
// ---------------------------------------------------------------------------

test("buildPiArgs starts a persisted, named, read-only task session", () => {
  assert.equal(READ_ONLY_TOOLS, "read,grep,find,ls");
  assert.deepEqual(buildPiArgs({ sessionId: "abc", sessionName: "Pi Companion Task: fix it", sandbox: "read-only" }), [
    "-p",
    "--mode",
    "json",
    "--session-id",
    "abc",
    "--name",
    "Pi Companion Task: fix it",
    ...READ_ONLY_ARGS
  ]);
});

test("buildPiArgs runs reviews without saving a session and read-only by default", () => {
  assert.deepEqual(buildPiArgs({}), ["-p", "--mode", "json", "--no-session", ...READ_ONLY_ARGS]);
});

test("buildPiArgs gives write runs Pi's normal tools and passes model and thinking through", () => {
  assert.deepEqual(buildPiArgs({ sessionId: "abc", model: "openai/gpt-4o", thinking: "low", sandbox: "workspace-write" }), [
    "-p",
    "--mode",
    "json",
    "--session-id",
    "abc",
    "--model",
    "openai/gpt-4o",
    "--thinking",
    "low"
  ]);
  assert.deepEqual(buildPiArgs({ sandbox: "none" }), ["-p", "--mode", "json", "--no-session", "--no-tools"]);
  assert.throws(() => buildPiArgs({ sandbox: "danger-full-access" }), /Unsupported Pi sandbox mode "danger-full-access"\./);
});

// ---------------------------------------------------------------------------
// handlePiEvent
// ---------------------------------------------------------------------------

test("handlePiEvent reports the session and the first turn once", () => {
  const { state, events } = trackProgress("abc");
  handlePiEvent(state, { type: "session", id: "abc" });
  handlePiEvent(state, { type: "turn_start" });
  handlePiEvent(state, { type: "turn_start" });

  assert.deepEqual(events, [
    { message: "Session ready (abc).", phase: "starting", threadId: "abc" },
    { message: "Turn started.", phase: "starting" }
  ]);

  const ephemeral = trackProgress();
  handlePiEvent(ephemeral.state, { type: "session", id: "in-memory" });
  assert.deepEqual(ephemeral.events, [{ message: "Session ready (ephemeral).", phase: "starting" }]);
});

test("handlePiEvent maps Pi tool calls to upstream progress messages and phases", () => {
  const { state, events } = trackProgress();
  handlePiEvent(state, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "npm test" } });
  // Pi's tool_execution_end carries no args; the command comes from the matching start event.
  handlePiEvent(state, {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [], structuredContent: { exit_code: 1 } },
    isError: true
  });
  handlePiEvent(state, { type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "ls -la" } });
  handlePiEvent(state, { type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", result: { content: [] }, isError: false });
  handlePiEvent(state, { type: "tool_execution_start", toolCallId: "call_3", toolName: "edit", args: { path: "src/app.js" } });
  handlePiEvent(state, { type: "tool_execution_end", toolCallId: "call_3", toolName: "edit", result: { content: [] }, isError: false });
  handlePiEvent(state, { type: "tool_execution_start", toolCallId: "call_4", toolName: "write", args: { path: "src/new.js" } });
  handlePiEvent(state, { type: "tool_execution_start", toolCallId: "call_5", toolName: "read", args: { path: "README.md" } });
  handlePiEvent(state, { type: "tool_execution_end", toolCallId: "call_5", toolName: "read", result: { content: [] }, isError: false });

  assert.deepEqual(
    events.map(({ message, phase }) => [message, phase]),
    [
      ["Running command: npm test", "verifying"],
      ["Command failed: npm test (exit 1)", "verifying"],
      ["Running command: ls -la", "running"],
      ["Command completed: ls -la (exit ?)", "running"],
      ["Applying 1 file change(s).", "editing"],
      ["File changes completed.", "editing"],
      ["Applying 1 file change(s).", "editing"],
      ["Running tool: read.", "investigating"],
      ["Tool read completed.", "investigating"]
    ]
  );
  assert.deepEqual([...state.touchedFiles], ["src/app.js", "src/new.js"]);
  assert.equal(state.toolArgs.size, 1, "only the unfinished write call is still tracked");
});

test("handlePiEvent clears an error once Pi's automatic retry recovers", () => {
  const { state, events } = trackProgress();
  handlePiEvent(state, erroredTurn("529 overloaded"));
  assert.equal(state.errorMessage, "529 overloaded");

  handlePiEvent(state, { type: "agent_end", messages: [], willRetry: true });
  handlePiEvent(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529 overloaded" });
  handlePiEvent(state, assistantTurn([{ type: "text", text: "Recovered." }]));
  handlePiEvent(state, { type: "auto_retry_end", success: true, attempt: 2 });

  assert.equal(state.errorMessage, null);
  assert.equal(state.lastAgentMessage, "Recovered.");
  assert.deepEqual(
    events.map(({ message }) => message),
    ["Pi error: 529 overloaded", "Retrying after Pi error (attempt 1/3)."]
  );
});

test("handlePiEvent keeps a final provider error and supplies a default message", () => {
  const { state } = trackProgress();
  handlePiEvent(state, erroredTurn());
  assert.equal(state.errorMessage, "Pi reported a provider error.");

  const retry = trackProgress();
  handlePiEvent(retry.state, { type: "auto_retry_start" });
  assert.deepEqual(retry.events, [{ message: "Retrying after Pi error.", phase: "running" }]);
});

test("handlePiEvent takes the reply text and usage from assistant turns only", () => {
  const { state } = trackProgress();
  handlePiEvent(
    state,
    assistantTurn(
      [
        { type: "thinking", thinking: "Working through the request." },
        { type: "text", text: "Answer." }
      ],
      { usage: { input: 5, output: 7 } }
    )
  );
  // A later tool-call-only turn and non-assistant messages leave the reply untouched.
  handlePiEvent(state, assistantTurn([{ type: "toolCall", id: "call_9", name: "read", arguments: {} }]));
  handlePiEvent(state, { type: "turn_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } });
  handlePiEvent(state, null);
  handlePiEvent(state, { type: "compaction_start", reason: "threshold" });

  assert.equal(state.lastAgentMessage, "Answer.");
  assert.deepEqual(state.usage, { input: 5, output: 7 });
  assert.equal(state.errorMessage, null);
});

// ---------------------------------------------------------------------------
// Output parsing, names, runtime status
// ---------------------------------------------------------------------------

test("parseStructuredOutput accepts bare or fenced JSON and reports invalid output", () => {
  assert.deepEqual(parseStructuredOutput('{"verdict":"approve"}').parsed, { verdict: "approve" });

  // Pi does not enforce an output schema, so a fenced JSON block is accepted too.
  const fenced = parseStructuredOutput('Here is the review:\n```json\n{"verdict":"approve"}\n```\n');
  assert.deepEqual(fenced.parsed, { verdict: "approve" });
  assert.equal(fenced.parseError, null);

  const invalid = parseStructuredOutput("no json here", { status: 0 });
  assert.equal(invalid.parsed, null);
  assert.match(invalid.parseError, /JSON/);
  assert.equal(invalid.status, 0);

  assert.equal(parseStructuredOutput("", { failureMessage: "401 invalid api key" }).parseError, "401 invalid api key");
  assert.equal(parseStructuredOutput("").parseError, "Pi did not return a final structured message.");
});

test("task session names are prefixed and shortened", () => {
  assert.equal(buildPersistentTaskThreadName("Fix the auth bug\nin login.ts"), "Pi Companion Task: Fix the auth bug in login.ts");
  assert.equal(buildPersistentTaskThreadName("x".repeat(100)), `Pi Companion Task: ${"x".repeat(53)}...`);
  assert.equal(buildPersistentTaskThreadName("   "), "Pi Companion Task");
});

test("Pi runs headlessly per command, with no shared runtime and no session listing", async () => {
  const runtime = getSessionRuntimeStatus();
  assert.equal(runtime.mode, "direct");
  assert.equal(runtime.label, "direct startup");
  assert.equal(await findLatestTaskThread(makeTempDir()), null);
});

test("readClaudeTranscriptMessages keeps user and assistant text from a Claude transcript", () => {
  const file = path.join(makeTempDir(), "session.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Why is the build failing?" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The lockfile is stale." },
            { type: "tool_use", name: "Bash", input: { command: "npm ci" } }
          ]
        }
      }),
      JSON.stringify({ type: "summary", summary: "ignored" }),
      "not json",
      ""
    ].join("\n")
  );

  assert.deepEqual(readClaudeTranscriptMessages(file), [
    { role: "user", text: "Why is the build failing?" },
    { role: "assistant", text: "The lockfile is stale." }
  ]);
});
