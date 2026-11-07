import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeExecutable } from "./helpers.mjs";

const FAKE_PI_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.cjs");

// The provider/model Pi starts with comes from its agent-dir settings.json.
export const DEFAULT_PI_SETTINGS = { defaultProvider: "fake", defaultModel: "fake-model" };

export function installFakePi(binDir, scenario = "ok", options = {}) {
  const source = fs.readFileSync(FAKE_PI_SOURCE, "utf8");
  writeExecutable(path.join(binDir, "pi"), `#!/usr/bin/env node\nconst SCENARIO = ${JSON.stringify(scenario)};\n${source}`);

  const agentDir = path.join(binDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const settings = options.settings === undefined ? DEFAULT_PI_SETTINGS : options.settings;
  if (settings) {
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

export function readFakePiCalls(binDir) {
  const file = path.join(binDir, "fake-pi-calls.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Headless turns only (`pi -p --mode json ...`), oldest first.
export function readFakePiRuns(binDir) {
  return readFakePiCalls(binDir).filter((call) => call.argv.includes("-p"));
}

export function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function buildEnv(binDir, extra = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    PI_CODING_AGENT_DIR: path.join(binDir, "agent"),
    // Job state lives in the test's temp dir, not the host's Claude plugin data.
    CLAUDE_PLUGIN_DATA: path.join(binDir, "plugin-data")
  };
  // Keep the host's Claude session out of the companion's job filtering.
  delete env.PI_COMPANION_SESSION_ID;
  delete env.PI_COMPANION_TRANSCRIPT_PATH;
  return { ...env, ...extra };
}
