import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveCancelableJob, resolveResultJob } from "../plugins/pi/scripts/lib/job-control.mjs";
import { upsertJob } from "../plugins/pi/scripts/lib/state.mjs";

const SESSION_ENV = "PI_COMPANION_SESSION_ID";

function withEnv(overrides, fn) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  apply(overrides);
  try {
    return fn();
  } finally {
    apply(previous);
  }
}

// Each test gets its own plugin data dir and no inherited Claude session id.
function isolated(fn) {
  return () => withEnv({ CLAUDE_PLUGIN_DATA: makeTempDir(), [SESSION_ENV]: undefined }, fn);
}

function seedWorkspace(jobs) {
  const workspace = makeTempDir();
  for (const job of jobs) {
    upsertJob(workspace, job);
  }
  return workspace;
}

test(
  "resolveResultJob returns the newest finished job from the current Claude session",
  isolated(() => {
    const workspace = seedWorkspace([
      { id: "task-a", status: "completed", sessionId: "s1", updatedAt: "2026-11-06T10:00:00.000Z" },
      { id: "task-b", status: "failed", sessionId: "s1", updatedAt: "2026-11-06T11:00:00.000Z" },
      { id: "task-c", status: "completed", sessionId: "s2", updatedAt: "2026-11-06T12:00:00.000Z" },
      { id: "task-d", status: "running", sessionId: "s1", updatedAt: "2026-11-06T13:00:00.000Z" }
    ]);

    withEnv({ [SESSION_ENV]: "s1" }, () => {
      assert.equal(resolveResultJob(workspace, "").job.id, "task-b");
    });
    assert.equal(resolveResultJob(workspace, "").job.id, "task-c");
  })
);

test(
  "resolveResultJob resolves an explicit id or unique prefix from any session",
  isolated(() => {
    const workspace = seedWorkspace([
      { id: "task-other", status: "completed", sessionId: "s2", updatedAt: "2026-11-06T10:00:00.000Z" },
      { id: "review-mine", status: "completed", sessionId: "s1", updatedAt: "2026-11-06T11:00:00.000Z" }
    ]);

    withEnv({ [SESSION_ENV]: "s1" }, () => {
      assert.equal(resolveResultJob(workspace, "task-other").job.id, "task-other");
      assert.equal(resolveResultJob(workspace, "task-o").job.id, "task-other");
    });
  })
);

test(
  "resolveResultJob explains running, ambiguous, and missing jobs",
  isolated(() => {
    const running = seedWorkspace([{ id: "task-run1", status: "running", updatedAt: "2026-11-06T10:00:00.000Z" }]);
    assert.throws(
      () => resolveResultJob(running, ""),
      /Job task-run1 is still running\. Check \/pi:status and try again once it finishes\./
    );

    const finished = seedWorkspace([
      { id: "task-done1", status: "completed", updatedAt: "2026-11-06T09:00:00.000Z" },
      { id: "task-done2", status: "completed", updatedAt: "2026-11-06T08:00:00.000Z" }
    ]);
    assert.throws(() => resolveResultJob(finished, "task-done"), /Job reference "task-done" is ambiguous\. Use a longer job id\./);
    assert.throws(() => resolveResultJob(finished, "task-zzz"), /No job found for "task-zzz"\. Run \/pi:status to list known jobs\./);
    assert.throws(() => resolveResultJob(makeTempDir(), ""), /No finished Pi jobs found for this repository yet\./);
  })
);

test(
  "resolveCancelableJob picks the only active job in the current Claude session",
  isolated(() => {
    const workspace = seedWorkspace([
      { id: "task-mine", status: "running", sessionId: "s1", updatedAt: "2026-11-06T10:00:00.000Z" },
      { id: "task-theirs", status: "queued", sessionId: "s2", updatedAt: "2026-11-06T11:00:00.000Z" },
      { id: "task-old", status: "completed", sessionId: "s1", updatedAt: "2026-11-06T12:00:00.000Z" }
    ]);
    const s1 = { env: { [SESSION_ENV]: "s1" } };

    assert.equal(resolveCancelableJob(workspace, "", s1).job.id, "task-mine");
    assert.equal(resolveCancelableJob(workspace, "task-theirs", s1).job.id, "task-theirs");
    assert.throws(() => resolveCancelableJob(workspace, "task-old", s1), /No job found for "task-old"/);
  })
);

test(
  "resolveCancelableJob refuses to guess between active jobs and explains an empty queue",
  isolated(() => {
    const busy = seedWorkspace([
      { id: "task-1", status: "running", updatedAt: "2026-11-06T10:00:00.000Z" },
      { id: "task-2", status: "queued", updatedAt: "2026-11-06T11:00:00.000Z" }
    ]);
    assert.throws(() => resolveCancelableJob(busy, "", { env: {} }), /Multiple Pi jobs are active\. Pass a job id to \/pi:cancel\./);

    const idle = seedWorkspace([{ id: "task-3", status: "completed", sessionId: "s1", updatedAt: "2026-11-06T10:00:00.000Z" }]);
    assert.throws(
      () => resolveCancelableJob(idle, "", { env: { [SESSION_ENV]: "s1" } }),
      /No active Pi jobs to cancel for this session\./
    );
    assert.throws(() => resolveCancelableJob(idle, "", { env: {} }), /No active Pi jobs to cancel\./);
  })
);
