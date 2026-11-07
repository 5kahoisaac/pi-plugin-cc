import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/pi/scripts/lib/process.mjs";

function esrchError() {
  return Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree signals the whole process group on POSIX", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });

  assert.deepEqual(calls, [[-1234, "SIGTERM"]]);
  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "process-group" });
});

test("terminateProcessTree falls back to the pid when it leads no process group", () => {
  // Pi delta: a foreground companion run is not a process-group leader. Pi has no
  // turn-interrupt RPC, so signalling that pid is how cancel stops the run; the companion's
  // SIGTERM handler then stops its Pi child.
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        throw esrchError();
      }
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.deepEqual(outcome, { attempted: true, delivered: true, method: "process" });
});

test("terminateProcessTree reports a process that already exited", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      throw esrchError();
    }
  });

  assert.deepEqual(outcome, { attempted: true, delivered: false, method: "process" });
});

test("terminateProcessTree ignores a missing pid", () => {
  assert.deepEqual(terminateProcessTree(Number.NaN), { attempted: false, delivered: false, method: null });
});
