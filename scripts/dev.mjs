#!/usr/bin/env node
// dev.mjs — bind/unbind the local plugin checkout with Claude Code for development.
//
//   node scripts/dev.mjs bind      register this checkout as a local marketplace + install
//   node scripts/dev.mjs unbind    uninstall the plugin + remove the local marketplace
//   node scripts/dev.mjs status    show whether the local binding exists and where it points
//
// The marketplace name and plugin name come from .claude-plugin/marketplace.json, so this
// script stays correct if they change.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARKETPLACE_FILE = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireClaude() {
  try {
    execFileSync(CLAUDE_BIN, ["--version"], { stdio: "ignore" });
  } catch {
    die(
      `Claude Code CLI ("${CLAUDE_BIN}") not found on PATH.\n` +
        "Install it from https://claude.com/download, or set CLAUDE_BIN to its path."
    );
  }
}

function readManifest() {
  if (!fs.existsSync(MARKETPLACE_FILE)) {
    die(`Marketplace manifest not found: ${MARKETPLACE_FILE}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MARKETPLACE_FILE, "utf8"));
  const marketplaceName = manifest.name;
  const pluginEntry = manifest.plugins?.find((entry) => entry.source === "./plugins/pi") ?? manifest.plugins?.[0];
  if (!marketplaceName || !pluginEntry?.name) {
    die("Marketplace manifest is missing `name` or a plugin entry.");
  }
  return { marketplaceName, pluginName: pluginEntry.name, installId: `${pluginEntry.name}@${marketplaceName}` };
}

function claude(args, { allowFailure = false } = {}) {
  try {
    return execFileSync(CLAUDE_BIN, args, { encoding: "utf8", cwd: REPO_ROOT });
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    die(output || `claude ${args.join(" ")} failed`);
  }
}

function listMarketplaces() {
  const out = claude(["plugin", "marketplace", "list"], { allowFailure: true });
  if (!out) {
    return [];
  }
  return String(out)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function marketplaceBoundLines(lines, marketplaceName, repoRoot) {
  return lines.filter((line) => line.includes(marketplaceName) || line.includes(repoRoot));
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/dev.mjs <command>",
      "",
      "Commands:",
      "  bind      Register this checkout as a local marketplace and install the plugin.",
      "  unbind    Uninstall the plugin and remove the local marketplace binding.",
      "  status    Show the current local binding status.",
      "",
      "Environment:",
      "  CLAUDE_BIN  Path to the claude CLI (default: claude on PATH).",
      ""
    ].join("\n")
  );
}

function cmdBind() {
  const { marketplaceName, installId } = readManifest();

  const existing = marketplaceBoundLines(listMarketplaces(), marketplaceName, REPO_ROOT);
  if (existing.length > 0) {
    // Re-point the binding at the current checkout in case it moved.
    claude(["plugin", "marketplace", "remove", marketplaceName]);
  }

  claude(["plugin", "marketplace", "add", REPO_ROOT]);
  claude(["plugin", "install", installId]);

  // Verify the binding actually landed; the CLI returns success before user settings
  // settle in rare cases, and a silent half-bind is much harder to debug later.
  const bound = marketplaceBoundLines(listMarketplaces(), marketplaceName, REPO_ROOT);
  if (bound.length === 0) {
    die(
      `Marketplace ${marketplaceName} did not register correctly. Run \`claude plugin marketplace list\` to inspect, then retry \`node scripts/dev.mjs bind\`.`
    );
  }

  process.stdout.write(
    [
      `Bound ${installId} to this checkout:`,
      ...bound.map((line) => `  ${line}`),
      "",
      "Reload plugins inside Claude Code (/reload-plugins) or start a new session,",
      "then verify with: /pi:setup and /agents (look for pi:pi-rescue).",
      ""
    ].join("\n")
  );
}

function cmdUnbind() {
  const { marketplaceName, installId } = readManifest();

  claude(["plugin", "uninstall", installId], { allowFailure: true });
  claude(["plugin", "marketplace", "remove", marketplaceName]);

  process.stdout.write(`Unbound ${installId} and removed marketplace ${marketplaceName}.\n`);
}

function cmdStatus() {
  const { marketplaceName, installId } = readManifest();
  const lines = listMarketplaces();
  const bound = marketplaceBoundLines(lines, marketplaceName, REPO_ROOT);

  if (bound.length === 0) {
    process.stdout.write(
      [
        `No local binding found for marketplace "${marketplaceName}".`,
        `Run \`node scripts/dev.mjs bind\` from ${REPO_ROOT} to bind this checkout.`,
        ""
      ].join("\n")
    );
    return;
  }

  process.stdout.write(
    [
      `Local binding active: ${installId}`,
      ...bound.map((line) => `  ${line}`),
      "",
      "If the checkout moved, re-run `node scripts/dev.mjs bind` to re-point it.",
      ""
    ].join("\n")
  );
}

function main() {
  const command = process.argv[2];
  switch (command) {
    case "bind":
      requireClaude();
      cmdBind();
      break;
    case "unbind":
      requireClaude();
      cmdUnbind();
      break;
    case "status":
      requireClaude();
      cmdStatus();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main();
