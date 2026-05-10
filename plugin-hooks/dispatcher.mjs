#!/usr/bin/env node
/**
 * Shared PreToolUse / PostToolUse / SessionStart / SessionEnd dispatcher
 * for narai-primitives builtin Claude Code plugins.
 *
 * Usage:
 *   node dispatcher.mjs <event>
 *
 * Where <event> is one of: session-start, pre-tool-use, post-tool-use,
 * session-end. Reads ${CLAUDE_PLUGIN_ROOT}/plugin-config.json for the
 * plugin's identity and routes to the appropriate handler.
 *
 * Best-effort: handler-internal failures are logged to stderr but do not
 * block tool execution. Argument / configuration errors exit with a
 * non-zero code so Claude Code surfaces them to the operator.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePluginConfig } from "./plugin-config.mjs";

const VALID_EVENTS = new Set([
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "session-end",
]);

main().catch((err) => {
  process.stderr.write(`dispatcher: ${err?.message ?? err}\n`);
  process.exit(1);
});

async function main() {
  const event = process.argv[2];
  if (!VALID_EVENTS.has(event)) {
    process.stderr.write(
      `dispatcher: unknown event '${event}' (expected one of ${[...VALID_EVENTS].join(", ")})\n`,
    );
    process.exit(2);
  }

  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) {
    process.stderr.write("dispatcher: CLAUDE_PLUGIN_ROOT not set\n");
    process.exit(2);
  }

  const cfgPath = path.join(root, "plugin-config.json");
  if (!fs.existsSync(cfgPath)) {
    process.stderr.write(`dispatcher: missing ${cfgPath}\n`);
    process.exit(2);
  }
  const cfg = parsePluginConfig(fs.readFileSync(cfgPath, "utf-8"));

  switch (event) {
    case "session-start":
      await onSessionStart(cfg);
      break;
    case "pre-tool-use":
      await onPreToolUse(cfg);
      break;
    case "post-tool-use":
      await onPostToolUse(cfg);
      break;
    case "session-end":
      await onSessionEnd(cfg);
      break;
  }
  process.exit(0);
}

/**
 * Walk siblings of `pluginDataDir` looking for a `node_modules/narai-primitives`
 * at `wantedVersion`. Returns the matched node_modules path, or null if no
 * usable sibling found. Used to skip redundant npm install when N builtin
 * plugins are loaded in the same Claude Code session.
 */
export function findSiblingInstall(pluginDataDir, wantedVersion) {
  const parent = path.dirname(pluginDataDir);
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(parent, entry.name);
    if (candidate === pluginDataDir) continue;
    const pkgJson = path.join(
      candidate,
      "node_modules",
      "narai-primitives",
      "package.json",
    );
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      if (meta.version === wantedVersion) {
        return path.join(candidate, "node_modules");
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function onSessionStart(cfg) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginRoot || !pluginData) return;

  const rootPkg = path.join(pluginRoot, "package.json");
  if (!fs.existsSync(rootPkg)) return;
  const rootMeta = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
  const wantVersion = rootMeta.dependencies?.["narai-primitives"]
    ?? rootMeta.version;

  fs.mkdirSync(pluginData, { recursive: true });

  const myInstall = path.join(pluginData, "node_modules", "narai-primitives");
  if (fs.existsSync(myInstall)) {
    try {
      const installed = JSON.parse(
        fs.readFileSync(path.join(myInstall, "package.json"), "utf-8"),
      );
      if (installed.version === wantVersion) {
        // Already installed at the right version; skip.
        return;
      }
    } catch {
      // Fall through to re-install.
    }
  }

  const sibling = findSiblingInstall(pluginData, wantVersion);
  if (sibling !== null) {
    try {
      const myNodeModules = path.join(pluginData, "node_modules");
      if (fs.existsSync(myNodeModules)) {
        fs.rmSync(myNodeModules, { recursive: true, force: true });
      }
      fs.symlinkSync(sibling, myNodeModules, "dir");
      return;
    } catch {
      // Fall through to install.
    }
  }

  fs.copyFileSync(rootPkg, path.join(pluginData, "package.json"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: pluginData,
    stdio: "inherit",
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function onPreToolUse(cfg) { /* Task 7 */ }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function onPostToolUse(cfg) { /* Task 5 */ }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function onSessionEnd(cfg) { /* Task 6 */ }
