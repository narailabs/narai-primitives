#!/usr/bin/env node
// hooks/db-guard.mjs — db-agent-connector PreToolUse guardrail.
//
// V2.0: thin stub. Loads `plugin/hooks/guardrails.json` and delegates to
// the toolkit's `findBlockingRule`. The hub's unified `guardrails.mjs`
// reads the same manifest when the hub is installed; this file is the
// standalone fallback when only db-agent is installed.
//
// V2.0 regression: deny-event audit logging is no longer written from
// this hook (the toolkit's matcher doesn't log). The audit module still
// records executed-query events.
//
// Best-effort, not a security boundary. Fails open on any error.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "guardrails.json");

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

async function loadToolkit() {
  const candidates = [
    // 1. Bundle: db-guard at narai-primitives/plugins/db-agent/hooks/;
    //    toolkit at narai-primitives/dist/toolkit/guardrail.js (3 ups)
    join(__dirname, "..", "..", "..", "dist", "toolkit", "guardrail.js"),
    // 2. Bundle installed as a Claude Code plugin
    process.env.CLAUDE_PLUGIN_DATA
      ? join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "narai-primitives", "dist", "toolkit", "guardrail.js")
      : null,
    // 3. Legacy plugin install
    process.env.CLAUDE_PLUGIN_DATA
      ? join(process.env.CLAUDE_PLUGIN_DATA, "node_modules", "@narai", "connector-toolkit", "dist", "guardrail.js")
      : null,
    join(homedir(), "src", "connectors", "connector-toolkit", "dist", "guardrail.js"),
    // 4. Local resolution from this file's nearest node_modules (dev sandbox).
    join(__dirname, "..", "..", "node_modules", "@narai", "connector-toolkit", "dist", "guardrail.js"),
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

async function main() {
  const raw = readStdin();
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (payload?.tool_name !== "Bash") return;
  if (process.env.DB_AGENT_GUARDRAILS === "off") return;

  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return;

  if (!existsSync(MANIFEST_PATH)) return;

  const toolkit = await loadToolkit();
  if (!toolkit) return;
  const { findBlockingRule, defaultDenyMessage, loadGuardrailManifest } = toolkit;
  if (typeof findBlockingRule !== "function") return;

  let manifest;
  try {
    manifest = loadGuardrailManifest(MANIFEST_PATH);
  } catch {
    return;
  }

  const match = findBlockingRule(command, [manifest]);
  if (!match) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: defaultDenyMessage(match),
      },
    }),
  );
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`db-guard: fail-open (${(err && err.message) || err})\n`);
  process.exit(0);
}
