import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/pi/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Pi returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Pi Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Pi Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput: '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Pi Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Pi session ID: thr_123/);
  // Pi delta: Pi reopens a session with `pi --session <id>`.
  assert.match(output, /Resume in Pi: pi --session thr_123/);
});

test("renderReviewResult lists findings by severity, then next steps", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Two issues.",
        findings: [
          {
            severity: "medium",
            title: "Crash on zero",
            body: "divide() throws when b is 0.",
            file: "calc.js",
            line_start: 4,
            line_end: 5,
            recommendation: "Guard the divisor."
          },
          {
            severity: "critical",
            title: "Eval of user input",
            body: "run() evals the request body.",
            file: "server.js",
            line_start: 9,
            line_end: 9,
            recommendation: ""
          }
        ],
        next_steps: ["Add a regression test."]
      },
      rawOutput: "{}",
      parseError: null
    },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );

  assert.equal(
    output,
    [
      "# Pi Adversarial Review",
      "",
      "Target: working tree diff",
      "Verdict: needs-attention",
      "",
      "Two issues.",
      "",
      "Findings:",
      "- [critical] Eval of user input (server.js:9)",
      "  run() evals the request body.",
      "- [medium] Crash on zero (calc.js:4-5)",
      "  divide() throws when b is 0.",
      "  Recommendation: Guard the divisor.",
      "",
      "Next steps:",
      "- Add a regression test.",
      ""
    ].join("\n")
  );
});

test("renderReviewResult shows the raw message when Pi returns no valid JSON", () => {
  const output = renderReviewResult(
    { parsed: null, rawOutput: "Looks fine to me.", parseError: "Unexpected token L" },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );

  assert.match(output, /^# Pi Adversarial Review\n\nPi did not return valid structured JSON\.\n\n- Parse error: Unexpected token L\n/);
  assert.match(output, /Raw final message:\n\n```text\nLooks fine to me\.\n```\n$/);
});

test("renderNativeReviewResult wraps Pi's plain-text review and keeps stderr", () => {
  assert.equal(
    renderNativeReviewResult(
      { status: 0, stdout: "No material findings.\n", stderr: "" },
      { reviewLabel: "Review", targetLabel: "working tree diff" }
    ),
    "# Pi Review\n\nTarget: working tree diff\n\nNo material findings.\n"
  );
  assert.match(
    renderNativeReviewResult(
      { status: 1, stdout: "", stderr: "401 invalid api key" },
      { reviewLabel: "Review", targetLabel: "branch diff against main" }
    ),
    /Pi review failed\.\n\nstderr:\n\n```text\n401 invalid api key\n```\n$/
  );
  assert.match(
    renderNativeReviewResult({ status: 0, stdout: "", stderr: "" }, { reviewLabel: "Review", targetLabel: "working tree diff" }),
    /Pi review completed without any stdout output\./
  );
});

test("renderTaskResult returns Pi's final message verbatim or the failure", () => {
  assert.equal(renderTaskResult({ rawOutput: "Done." }, {}), "Done.\n");
  assert.equal(renderTaskResult({ rawOutput: "Done.\n" }, {}), "Done.\n");
  assert.equal(renderTaskResult({ rawOutput: "", failureMessage: "401 invalid api key" }, {}), "401 invalid api key\n");
  assert.equal(renderTaskResult({ rawOutput: "" }, {}), "Pi did not return a final message.\n");
});

test("renderStoredJobResult appends the Pi session and resume command to a task answer", () => {
  assert.equal(
    renderStoredJobResult(
      { id: "task-1", status: "completed", title: "Pi Task", threadId: "sess-1" },
      { threadId: "sess-1", result: { rawOutput: "Handled the requested task." } }
    ),
    "Handled the requested task.\n\nPi session ID: sess-1\nResume in Pi: pi --session sess-1\n"
  );
});

test("renderSetupReport follows the upstream layout", () => {
  const output = renderSetupReport({
    ready: false,
    node: { detail: "v22.19.0" },
    npm: { detail: "10.9.0" },
    pi: { detail: "1.5.0" },
    auth: { detail: "credentials not configured (anthropic)" },
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: true,
    actionsTaken: ["Enabled the stop-time review gate for /repo."],
    nextSteps: ["Run `pi` in a separate terminal and use `/login` inside Pi to connect a provider."]
  });

  assert.equal(
    output,
    [
      "# Pi Setup",
      "",
      "Status: needs attention",
      "",
      "Checks:",
      "- node: v22.19.0",
      "- npm: 10.9.0",
      "- pi: 1.5.0",
      "- auth: credentials not configured (anthropic)",
      "- session runtime: direct startup",
      "- review gate: enabled",
      "",
      "Actions taken:",
      "- Enabled the stop-time review gate for /repo.",
      "",
      "Next steps:",
      "- Run `pi` in a separate terminal and use `/login` inside Pi to connect a provider.",
      ""
    ].join("\n")
  );
});

test("renderStatusReport shows active Pi jobs in the upstream table", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [
      {
        id: "task-1",
        kindLabel: "rescue",
        status: "running",
        phase: "investigating",
        elapsed: "12s",
        threadId: "sess-1",
        summary: "Investigate the flake",
        progressPreview: []
      }
    ],
    latestFinished: null,
    recent: [],
    needsReview: false
  });

  assert.match(output, /^# Pi Status\n\nSession runtime: direct startup\nReview gate: disabled\n/);
  assert.match(output, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Pi Session ID \| Summary \|\n/);
  assert.match(output, /\| task-1 \| rescue \| running \| investigating \| 12s \| sess-1 \| Investigate the flake \|\n/);
  // Claude Code prints HTML such as <br> literally, and a table cell cannot hold a line break,
  // so each follow-up command gets its own line below the table.
  assert.match(output, /\n\nActions:\n- `\/pi:status task-1`\n- `\/pi:cancel task-1`\n/);
  assert.doesNotMatch(output, /<br>/);
  assert.match(output, /Resume in Pi: pi --session sess-1/);
  assert.doesNotMatch(output, /No jobs recorded yet/);
});

test("renderStatusReport reports an empty queue and the enabled review gate", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: true },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: true
  });

  assert.match(output, /Review gate: enabled/);
  assert.match(output, /No jobs recorded yet\./);
  assert.match(output, /Ending the session will trigger a fresh Pi adversarial review and block if it finds issues\./);
});

test("renderCancelReport confirms the cancelled job", () => {
  assert.equal(
    renderCancelReport({ id: "task-1", title: "Pi Task", summary: "Investigate the flake" }),
    "# Pi Cancel\n\nCancelled task-1.\n\n- Title: Pi Task\n- Summary: Investigate the flake\n- Check `/pi:status` for the updated queue.\n"
  );
});
