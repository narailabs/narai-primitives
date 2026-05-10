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
import { fileURLToPath } from "node:url";
import { parsePluginConfig } from "./plugin-config.mjs";

const VALID_EVENTS = new Set([
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "session-end",
]);

// Only run main() when invoked as a CLI, not when imported by tests.
const isMainScript =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMainScript) {
  main().catch((err) => {
    process.stderr.write(`dispatcher: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

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

async function loadToolkit() {
  const { existsSync } = fs;
  const { homedir } = await import("node:os");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 1. Bundled: dispatcher at narai-primitives/plugin-hooks/; toolkit at narai-primitives/dist/toolkit/guardrail.js
    path.join(__dirname, "..", "dist", "toolkit", "guardrail.js"),
    // 2. Claude Code plugin install
    process.env.CLAUDE_PLUGIN_DATA
      ? path.join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "toolkit", "guardrail.js")
      : null,
  ].filter((p) => p !== null);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch {
      // try next
    }
  }
  return null;
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

  // Best-effort: emit nudge banner if the toolkit is reachable.
  try {
    const reminderPath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "dist",
      "toolkit",
      "plugin",
      "reminder.js",
    );
    if (fs.existsSync(reminderPath)) {
      const mod = await import(reminderPath);
      const decision = mod.evaluateNudge({ connectors: [cfg.name] });
      if (decision.nudge) process.stdout.write(decision.banner + "\n");
    }
  } catch (err) {
    process.stderr.write(`dispatcher: nudge failed (${err.message})\n`);
  }

  // Best-effort: stale-summarize.
  try {
    const stalePath = path.join(
      pluginData,
      "node_modules",
      "narai-primitives",
      "plugin-hooks",
      "stale-summarize.mjs",
    );
    if (fs.existsSync(stalePath)) {
      process.env.USAGE_CONNECTOR_NAME = cfg.name;
      await import(stalePath);
    }
  } catch (err) {
    process.stderr.write(`dispatcher: stale-summarize failed (${err.message})\n`);
  }
}

async function onPreToolUse(cfg) {
  const stdin = await readStdin();
  if (!stdin) return;
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }
  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return;

  const decisions = [];

  // 1. db-guard (only if kind=db)
  if (cfg.kind === "db") {
    const guardrailsPath = path.join(
      process.env.CLAUDE_PLUGIN_ROOT,
      "hooks",
      "guardrails.json",
    );
    if (fs.existsSync(guardrailsPath)) {
      try {
        const toolkit = await loadToolkit();
        if (toolkit) {
          const { findBlockingRule, defaultDenyMessage, loadGuardrailManifest } = toolkit;
          if (typeof findBlockingRule === "function") {
            const manifest = loadGuardrailManifest(guardrailsPath);
            const match = findBlockingRule(command, [manifest]);
            if (match) {
              decisions.push({
                decision: "deny",
                reason: defaultDenyMessage(match),
              });
            }
          }
        }
      } catch (err) {
        process.stderr.write(`dispatcher: db-guard failed (${err.message})\n`);
      }
    }
  }

  // 2. user-connector gates from $HOME and cwd
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  for (const root of [home, cwd]) {
    if (!root) continue;
    const gatesDir = path.join(root, ".connectors", "connectors");
    if (!fs.existsSync(gatesDir)) continue;
    let slugs;
    try {
      slugs = fs
        .readdirSync(gatesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const gatesFile = path.join(gatesDir, slug, "gates.json");
      if (!fs.existsSync(gatesFile)) continue;
      try {
        const gateCfg = JSON.parse(fs.readFileSync(gatesFile, "utf-8"));
        for (const rule of gateCfg.rules ?? []) {
          if (
            !["deny", "ask", "allow"].includes(rule.decision) ||
            typeof rule.pattern !== "string"
          ) continue;
          let re;
          try { re = new RegExp(rule.pattern); } catch { continue; }
          if (re.test(command)) {
            decisions.push({
              decision: rule.decision,
              reason: rule.reason ?? `${slug} gate: ${rule.name ?? "rule"}`,
            });
          }
        }
      } catch (err) {
        process.stderr.write(
          `dispatcher: gate scan failed for ${gatesFile} (${err.message})\n`,
        );
      }
    }
  }

  if (decisions.length === 0) return;
  const rank = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision] - rank[a.decision]);
  const winner = decisions[0];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: winner.decision,
      permissionDecisionReason: winner.reason,
    },
  }));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}
async function onPostToolUse(cfg) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const usagePath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "usage-record.mjs",
  );
  if (!fs.existsSync(usagePath)) return;
  process.env.USAGE_CONNECTOR_NAME = cfg.name;
  if (cfg.binPath) process.env.USAGE_BIN_HINT = cfg.binPath;
  try {
    await import(usagePath);
  } catch (err) {
    process.stderr.write(`dispatcher: usage-record failed (${err.message})\n`);
  }
}
async function onSessionEnd(cfg) {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return;
  const summaryPath = path.join(
    pluginData,
    "node_modules",
    "narai-primitives",
    "plugin-hooks",
    "session-summary.mjs",
  );
  if (!fs.existsSync(summaryPath)) return;
  process.env.USAGE_CONNECTOR_NAME = cfg.name;
  try {
    await import(summaryPath);
  } catch (err) {
    process.stderr.write(`dispatcher: session-summary failed (${err.message})\n`);
  }
}
