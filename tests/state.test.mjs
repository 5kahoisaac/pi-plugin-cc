import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  upsertJob
} from "../plugins/pi/scripts/lib/state.mjs";

function withPluginDataDir(value, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  if (value == null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = value;
  }
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  withPluginDataDir(null, () => {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(os.tmpdir(), "pi-companion")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  });
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const pluginDataDir = makeTempDir();
  withPluginDataDir(pluginDataDir, () => {
    const workspace = makeTempDir();
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  });
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  withPluginDataDir(makeTempDir(), () => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    const jobs = Array.from({ length: 51 }, (_, index) => {
      const jobId = `job-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
      return { id: jobId, status: "completed", logFile, updatedAt, createdAt: updatedAt };
    });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
      "utf8"
    );

    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });

    const prunedJobFile = resolveJobFile(workspace, "job-0");
    const jobsDir = path.dirname(prunedJobFile);

    assert.equal(fs.existsSync(resolveJobFile(workspace, "job-50")), true);
    assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-50")), true);

    const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(savedState.jobs.length, 50);
    assert.deepEqual(
      savedState.jobs.map((job) => job.id),
      Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
    );
    assert.deepEqual(
      fs.readdirSync(jobsDir).sort(),
      Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
        .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
        .sort()
    );
  });
});

test("saveState replaces the state file atomically and leaves no temp file", () => {
  withPluginDataDir(makeTempDir(), () => {
    const workspace = makeTempDir();
    saveState(workspace, { config: { stopReviewGate: true }, jobs: [] });

    const stateFile = resolveStateFile(workspace);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), {
      version: 1,
      config: { stopReviewGate: true },
      jobs: []
    });
    assert.deepEqual(
      fs.readdirSync(path.dirname(stateFile)).filter((name) => name.endsWith(".tmp")),
      []
    );
  });
});

test("setConfig updates one key and keeps the recorded jobs", () => {
  withPluginDataDir(makeTempDir(), () => {
    const workspace = makeTempDir();
    upsertJob(workspace, { id: "task-1", status: "completed" });

    setConfig(workspace, "stopReviewGate", true);
    assert.equal(getConfig(workspace).stopReviewGate, true);
    setConfig(workspace, "stopReviewGate", false);
    assert.equal(getConfig(workspace).stopReviewGate, false);
    assert.deepEqual(
      listJobs(workspace).map((job) => job.id),
      ["task-1"]
    );
  });
});

test("upsertJob merges a patch into the existing job", () => {
  withPluginDataDir(makeTempDir(), () => {
    const workspace = makeTempDir();
    upsertJob(workspace, { id: "task-1", status: "queued", title: "Pi Task" });
    upsertJob(workspace, { id: "task-1", status: "running", pid: 42 });

    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "running");
    assert.equal(jobs[0].title, "Pi Task");
    assert.equal(jobs[0].pid, 42);
  });
});

test("job files and logs live in the jobs dir as <id>.json and <id>.log", () => {
  withPluginDataDir(makeTempDir(), () => {
    const workspace = makeTempDir();
    assert.match(resolveJobFile(workspace, "task-abc"), /[\\/]jobs[\\/]task-abc\.json$/);
    assert.match(resolveJobLogFile(workspace, "task-abc"), /[\\/]jobs[\\/]task-abc\.log$/);
    assert.match(generateJobId("review"), /^review-[a-z0-9]+-[a-z0-9]*$/);
  });
});
