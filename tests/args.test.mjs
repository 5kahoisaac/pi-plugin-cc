import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, splitRawArgumentString } from "../plugins/pi/scripts/lib/args.mjs";

test("parseArgs splits value options, booleans, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--cwd", "/tmp/x", "--json", "--base", "main", "review", "this"],
    {
      valueOptions: ["cwd", "base"],
      booleanOptions: ["json"]
    }
  );
  assert.deepEqual(options, { cwd: "/tmp/x", json: true, base: "main" });
  assert.deepEqual(positionals, ["review", "this"]);
});

test("parseArgs supports --key=value inline syntax", () => {
  const { options } = parseArgs(["--cwd=/tmp/y", "--json=false"], {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  assert.deepEqual(options, { cwd: "/tmp/y", json: false });
});

test("parseArgs keeps '=' inside inline values", () => {
  const { options } = parseArgs(["--base=refs/x=y"], { valueOptions: ["base"] });
  assert.deepEqual(options, { base: "refs/x=y" });
});

test("parseArgs passes unknown flags through as positionals", () => {
  const { positionals } = parseArgs(["--unknown", "value"], {});
  assert.deepEqual(positionals, ["--unknown", "value"]);
});

test("splitRawArgumentString respects quotes", () => {
  assert.deepEqual(splitRawArgumentString(`--base main "focus text here"`), [
    "--base",
    "main",
    "focus text here"
  ]);
});
