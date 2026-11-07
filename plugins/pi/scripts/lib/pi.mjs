// Pi runtime adapter: the Pi-side equivalent of codex-plugin-cc's lib/codex.mjs.
//
// Upstream drives Codex through a long-lived app-server. Pi has no app-server, so every turn
// runs headlessly: `pi -p --mode json ...`, streaming JSONL events from stdout. This module
// translates those events into the same progress messages, phases, and result shape that
// upstream's runAppServerTurn returns, so the rest of the plugin stays a line-for-line port.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, runCommand } from "./process.mjs";

export const PI_BINARY = "pi";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

// Pi has no OS sandbox, so "read-only" means: only Pi's non-mutating built-in tools, and no
// MCP tools (MCP servers can perform writes).
export const READ_ONLY_TOOLS = "read,grep,find,ls";

const TASK_SESSION_PREFIX = "Pi Companion Task";
// Pi's documented npm install (docs/quickstart.md). Pi itself needs Node.js 22.19 or newer.
export const PI_INSTALL_COMMAND = "npm install -g --ignore-scripts @earendil-works/pi-coding-agent";
const NOT_INSTALLED_MESSAGE = `Pi CLI is not installed or is not runnable. Install it with \`${PI_INSTALL_COMMAND}\`, then rerun \`/pi:setup\`.`;
// Linux rejects any single argv string over 128 KiB (E2BIG); larger prompts go through a file.
const MAX_INLINE_PROMPT_BYTES = 96 * 1024;
const PROMPT_FILE_MESSAGE = "Follow the instructions in the attached file.";
const MAX_STDERR_BYTES = 1024 * 1024;
const FILE_MUTATION_TOOLS = new Set(["edit", "write"]);
const TERMINATION_EXIT_CODES = { SIGTERM: 143, SIGINT: 130 };

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

// ---------------------------------------------------------------------------
// Availability, auth, runtime status
// ---------------------------------------------------------------------------

export function getPiAvailability(cwd) {
  return binaryAvailable(PI_BINARY, ["--version"], { cwd });
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Pi runs headlessly per command; there is no shared runtime to reuse.",
    endpoint: null
  };
}

// Pi's agent directory, resolved the way Pi does it (dist/config.js getAgentDir).
function resolvePiAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (!envDir) {
    return path.join(os.homedir(), ".pi", "agent");
  }
  if (envDir === "~") {
    return os.homedir();
  }
  return envDir.startsWith("~/") ? path.join(os.homedir(), envDir.slice(2)) : envDir;
}

function readSettingString(settings, key) {
  const value = settings?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPiDefaults() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(resolvePiAgentDir(), "settings.json"), "utf8"));
    return { provider: readSettingString(settings, "defaultProvider"), model: readSettingString(settings, "defaultModel") };
  } catch {
    return { provider: null, model: null };
  }
}

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0];
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getPiAuthStatus(cwd) {
  const availability = getPiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      provider: null,
      model: null
    };
  }

  // Mirror Pi's startup model choice (dist/core/model-resolver.js): the saved default provider
  // and model when both are set and authenticated, otherwise the first model Pi has credentials for.
  const defaults = readPiDefaults();
  let defaultDetail = null;
  if (defaults.provider && defaults.model) {
    const defaultStatus = checkDefaultModelAuth(cwd, defaults);
    if (defaultStatus.loggedIn) {
      return defaultStatus;
    }
    defaultDetail = defaultStatus.detail;
  }
  return checkAvailableModels(cwd, defaults, defaultDetail);
}

function checkDefaultModelAuth(cwd, defaults) {
  const result = runCommand(
    PI_BINARY,
    ["auth", "check", "--provider", defaults.provider, "--model", defaults.model, "--json"],
    { cwd }
  );
  const parsed = parseJsonOrNull(result.stdout);
  const loggedIn = !result.error && result.status === 0 && (parsed?.status ?? "ready") === "ready";
  const provider = typeof parsed?.provider === "string" ? parsed.provider : defaults.provider;

  let detail;
  if (loggedIn) {
    const via = [provider, parsed?.authType].filter(Boolean).join(", ");
    detail = via ? `ready (${via})` : "ready";
  } else if (typeof parsed?.reason === "string" && parsed.reason) {
    detail = `${parsed.reason.replace(/_/g, " ")} (${provider})`;
  } else {
    detail = firstLine(result.error?.message || result.stderr || result.stdout) || "no configured provider credentials";
  }

  return {
    available: true,
    loggedIn,
    detail,
    source: "pi auth check",
    provider,
    model: defaults.model
  };
}

// `pi --list-models` lists only models whose provider has credentials. It exits 0 even when the
// list is empty ("No models available. Use /login ..."), so readiness comes from its output.
function checkAvailableModels(cwd, defaults, defaultDetail) {
  const result = runCommand(PI_BINARY, ["--offline", "--list-models"], { cwd });
  const rows = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  const headerIndex = rows.findIndex((row) => /^provider\s+model\b/.test(row));
  const modelCount = headerIndex === -1 ? 0 : rows.length - headerIndex - 1;
  const loggedIn = !result.error && result.status === 0 && modelCount > 0;

  let detail;
  if (loggedIn) {
    const available = `${modelCount} ${modelCount === 1 ? "model" : "models"} available`;
    detail = defaultDetail
      ? `ready (${available}; default ${defaults.provider}/${defaults.model}: ${defaultDetail})`
      : `ready (${available})`;
  } else {
    detail = defaultDetail ?? (firstLine(result.error?.message) || "no models available");
  }

  return {
    available: true,
    loggedIn,
    detail,
    source: "pi --list-models",
    provider: null,
    model: null
  };
}

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

function buildSandboxArgs(sandbox) {
  switch (sandbox ?? "read-only") {
    case "read-only":
      return ["--tools", READ_ONLY_TOOLS, "--no-mcp"];
    case "workspace-write":
      return [];
    case "none":
      return ["--no-tools"];
    default:
      throw new Error(`Unsupported Pi sandbox mode "${sandbox}".`);
  }
}

export function buildPiArgs(options = {}) {
  const args = ["-p", "--mode", "json"];
  if (options.sessionId) {
    // Pi resumes the cwd's session with this id, creating it when it does not exist yet.
    args.push("--session-id", options.sessionId);
  } else {
    args.push("--no-session");
  }
  if (options.sessionName) {
    args.push("--name", options.sessionName);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }
  args.push(...buildSandboxArgs(options.sandbox));
  return args;
}

function preparePromptArgs(prompt) {
  // A prompt that is too large for argv, or that Pi would parse as a flag (-) or a file
  // reference (@), is delivered as an attached file instead.
  const needsFile =
    Buffer.byteLength(prompt, "utf8") > MAX_INLINE_PROMPT_BYTES || prompt.startsWith("-") || prompt.startsWith("@");
  if (!needsFile) {
    return { promptArgs: [prompt], cleanup: () => {} };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-prompt-"));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, prompt, "utf8");
  return {
    promptArgs: [`@${file}`, PROMPT_FILE_MESSAGE],
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

// ---------------------------------------------------------------------------
// Event stream -> upstream progress messages
// ---------------------------------------------------------------------------

export function createPiTurnState(options = {}) {
  return {
    onProgress: options.onProgress ?? null,
    threadId: options.threadId ?? null,
    turnStarted: false,
    lastAgentMessage: "",
    errorMessage: null,
    usage: null,
    touchedFiles: new Set(),
    // Pi's tool_execution_end carries no args (docs/json.md), so each call's start args are
    // kept by toolCallId for its end message.
    toolArgs: new Map()
  };
}

function toolArgsFromEvent(event) {
  return event.args && typeof event.args === "object" ? event.args : {};
}

// Pi's bash tool reports its exit status as result.structuredContent.exit_code.
function bashExitCode(event) {
  const exitCode = event.result?.structuredContent?.exit_code;
  return Number.isInteger(exitCode) ? exitCode : "?";
}

function textFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function describeToolStart(state, event) {
  const args = toolArgsFromEvent(event);
  if (typeof event.toolCallId === "string") {
    state.toolArgs.set(event.toolCallId, args);
  }
  if (event.toolName === "bash") {
    const command = String(args.command ?? "");
    return {
      message: `Running command: ${shorten(command, 96)}`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (FILE_MUTATION_TOOLS.has(event.toolName)) {
    const filePath = args.path ?? args.file_path ?? null;
    if (typeof filePath === "string" && filePath) {
      state.touchedFiles.add(filePath);
    }
    return { message: "Applying 1 file change(s).", phase: "editing" };
  }
  return { message: `Running tool: ${event.toolName}.`, phase: "investigating" };
}

function describeToolEnd(state, event) {
  const status = event.isError === true ? "failed" : "completed";
  const args = state.toolArgs.get(event.toolCallId) ?? toolArgsFromEvent(event);
  state.toolArgs.delete(event.toolCallId);
  if (event.toolName === "bash") {
    const command = String(args.command ?? "");
    return {
      message: `Command ${status}: ${shorten(command, 96)} (exit ${bashExitCode(event)})`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (FILE_MUTATION_TOOLS.has(event.toolName)) {
    return { message: `File changes ${status}.`, phase: "editing" };
  }
  return { message: `Tool ${event.toolName} ${status}.`, phase: "investigating" };
}

export function handlePiEvent(state, event) {
  if (!event || typeof event !== "object") {
    return;
  }

  switch (event.type) {
    case "session": {
      const extra = state.threadId ? { threadId: state.threadId } : {};
      emitProgress(state.onProgress, `Session ready (${state.threadId ?? "ephemeral"}).`, "starting", extra);
      break;
    }
    case "turn_start":
      // Pi emits one turn per model call; upstream reports the user-visible turn once.
      if (!state.turnStarted) {
        state.turnStarted = true;
        emitProgress(state.onProgress, "Turn started.", "starting");
      }
      break;
    case "tool_execution_start": {
      const update = describeToolStart(state, event);
      emitProgress(state.onProgress, update.message, update.phase);
      break;
    }
    case "tool_execution_end": {
      const update = describeToolEnd(state, event);
      emitProgress(state.onProgress, update.message, update.phase);
      break;
    }
    case "turn_end": {
      const message = event.message;
      if (message?.role !== "assistant") {
        break;
      }
      const text = textFromContent(message.content);
      if (text) {
        state.lastAgentMessage = text;
      }
      if (message.usage) {
        state.usage = message.usage;
      }
      if (message.stopReason === "error") {
        state.errorMessage = String(message.errorMessage || "Pi reported a provider error.");
        emitProgress(state.onProgress, `Pi error: ${state.errorMessage}`, "failed");
      } else {
        // Pi retries failed provider calls on its own (auto_retry_*); a later clean turn means it
        // recovered, so an earlier error must not fail the run.
        state.errorMessage = null;
      }
      break;
    }
    case "auto_retry_start": {
      const attempt =
        Number.isInteger(event.attempt) && Number.isInteger(event.maxAttempts)
          ? ` (attempt ${event.attempt}/${event.maxAttempts})`
          : "";
      emitProgress(state.onProgress, `Retrying after Pi error${attempt}.`, "running");
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

function createLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        onLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) {
        onLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    }
  };
}

function spawnPiProcess(cwd, args, options = {}) {
  return new Promise((resolve) => {
    // stdin must not be a pipe: `pi -p` waits for a pipe that never closes.
    const child = spawn(PI_BINARY, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    let settled = false;
    let timedOut = false;

    // /pi:cancel and SessionEnd signal the companion process (or its process group). Stop the
    // Pi child too and exit right away, so the "cancelled" job record is not overwritten.
    const forwardTermination = (signal) => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child already exited.
      }
      process.exit(TERMINATION_EXIT_CODES[signal] ?? 143);
    };
    process.once("SIGTERM", forwardTermination);
    process.once("SIGINT", forwardTermination);

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      process.off("SIGTERM", forwardTermination);
      process.off("SIGINT", forwardTermination);
      resolve(result);
    };

    // Pi's JSONL must be decoded as one UTF-8 stream, since a character can span two chunks,
    // and split on LF only (docs/json.md). setEncoding gives a stateful decoder.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const stdoutSplitter = createLineSplitter((line) => options.onStdoutLine?.(line));
    child.stdout.on("data", (chunk) => stdoutSplitter.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk;
      }
    });
    child.on("error", (error) => finish({ code: null, signal: null, stderr, error, timedOut }));
    child.on("close", (code, signal) => {
      stdoutSplitter.flush();
      finish({ code, signal, stderr, error: null, timedOut });
    });
  });
}

function resolveTurnStatus(exit, state) {
  if (exit.error || exit.timedOut || exit.code === null) {
    return 1;
  }
  if (exit.code !== 0) {
    return exit.code;
  }
  return state.errorMessage ? 1 : 0;
}

function resolveTurnError(exit, state, timeoutMs) {
  if (exit.error) {
    return exit.error;
  }
  if (exit.timedOut) {
    return new Error(`Pi timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }
  if (exit.code === null) {
    return new Error(`Pi was terminated by ${exit.signal ?? "a signal"}.`);
  }
  return state.errorMessage ? new Error(state.errorMessage) : null;
}

export async function runPiTurn(cwd, options = {}) {
  const availability = getPiAvailability(cwd);
  if (!availability.available) {
    throw new Error(NOT_INSTALLED_MESSAGE);
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Pi run.");
  }

  let threadId = null;
  if (options.resumeThreadId) {
    emitProgress(options.onProgress, `Resuming session ${options.resumeThreadId}.`, "starting");
    threadId = options.resumeThreadId;
  } else {
    emitProgress(options.onProgress, options.startMessage ?? "Starting Pi task session.", "starting");
    // Persisted runs get their id up front so status can show it while Pi is still working.
    threadId = options.persistThread ? randomUUID() : null;
  }

  const args = buildPiArgs({
    sessionId: threadId,
    sessionName: options.persistThread && !options.resumeThreadId ? options.threadName : null,
    model: options.model,
    thinking: options.thinking,
    sandbox: options.sandbox
  });
  const state = createPiTurnState({ onProgress: options.onProgress, threadId });
  const { promptArgs, cleanup } = preparePromptArgs(prompt);

  let exit;
  try {
    exit = await spawnPiProcess(cwd, [...args, ...promptArgs], {
      timeoutMs: options.timeoutMs,
      onStdoutLine: (line) => handlePiEvent(state, parseJsonOrNull(line))
    });
  } finally {
    cleanup();
  }

  const status = resolveTurnStatus(exit, state);
  emitProgress(options.onProgress, `Turn ${status === 0 ? "completed" : "failed"}.`, "finalizing");

  return {
    status,
    threadId,
    turnId: null,
    finalMessage: state.lastAgentMessage,
    reasoningSummary: [],
    error: resolveTurnError(exit, state, options.timeoutMs),
    stderr: exit.stderr.trim(),
    usage: state.usage,
    touchedFiles: [...state.touchedFiles]
  };
}

// Upstream asks Codex's app-server (`thread/list`) for the newest companion thread when no
// Claude session id is known. Pi has no headless session-listing command (only the interactive
// /resume picker). Its session files are on disk, but their location moves with `sessionDir` /
// PI_CODING_AGENT_SESSION_DIR, so the plugin does not couple to that store and relies on its
// tracked job list instead.
export async function findLatestTaskThread() {
  return null;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Pi did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  // Codex enforces the output schema; Pi does not, so also accept a fenced JSON block.
  const candidates = [rawOutput.trim()];
  const fenced = rawOutput.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return {
        parsed: JSON.parse(candidate),
        parseError: null,
        rawOutput,
        ...fallback
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    parsed: null,
    parseError: lastError.message,
    rawOutput,
    ...fallback
  };
}

// ---------------------------------------------------------------------------
// Claude session transfer
// ---------------------------------------------------------------------------

export function readClaudeTranscriptMessages(sourcePath) {
  const messages = [];
  for (const line of fs.readFileSync(sourcePath, "utf8").split("\n")) {
    const entry = parseJsonOrNull(line);
    const message = entry?.message ?? entry;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : textFromContent(message.content);
    if (text) {
      messages.push({ role, text });
    }
  }
  return messages;
}

function buildTransferPrompt(messages) {
  return [
    "The following is the turn history of a Claude Code session, transferred so the work can continue in Pi.",
    "Read it and reply with a brief summary of where things stand. Do not start new work until the next instruction.",
    "",
    "<transcript>",
    messages.map((message) => `[${message.role}]: ${message.text}`).join("\n\n"),
    "</transcript>"
  ].join("\n");
}

export async function importClaudeSession(cwd, options = {}) {
  const messages = readClaudeTranscriptMessages(options.sourcePath);
  if (messages.length === 0) {
    throw new Error(`No user or assistant messages found in ${options.sourcePath}.`);
  }

  emitProgress(options.onProgress, "Importing Claude session into Pi.", "transferring");
  const result = await runPiTurn(cwd, {
    prompt: buildTransferPrompt(messages),
    persistThread: true,
    threadName: `Claude session ${path.basename(options.sourcePath, ".jsonl")}`,
    sandbox: "none"
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || "Pi could not import the Claude session.");
  }

  emitProgress(options.onProgress, `Claude session imported (${result.threadId}).`, "completed", {
    threadId: result.threadId
  });
  return { threadId: result.threadId };
}
