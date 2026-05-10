#!/usr/bin/env node
/**
 * git_gate.mjs — PreToolUse hook entry point.
 *
 * Reads Claude Code's hook payload from stdin, classifies the bash command
 * via rules.mjs, and writes a permission decision to stdout. Emits no
 * decision (exit 0, empty stdout) if the command is not a git command or
 * no rule matches — letting the default permission flow continue.
 *
 * Output shape:
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                           permissionDecision: "allow"|"deny"|"ask",
 *                           permissionDecisionReason: "..." } }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decide } from "./rules.mjs";

main().catch((err) => {
  // Best-effort: never crash Claude Code on a hook failure.
  process.stderr.write(`git-gate hook error: ${err?.message ?? err}\n`);
  process.exit(0);
});

async function main() {
  const payload = await readStdinJson();
  if (payload === null) return;

  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return;

  const config = loadConfig();
  const disabled = mergeDisabled(config?.disabled);
  const extraRules = compileExtraRules(config?.rules);

  const rule = decide(command, { disabled, extraRules });
  if (rule === null) return;

  emit(rule.decision, rule.reason);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function emit(permissionDecision, permissionDecisionReason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

/**
 * Read optional config from `~/.connectors/git-gate.json`.
 *
 * Shape:
 *   {
 *     "disabled": ["push", "force_push"],
 *     "rules": [
 *       { "name": "deny_push_to_release",
 *         "decision": "deny",
 *         "reason": "Pushing to release branches needs SRE approval.",
 *         "pattern": "^git\\s+push\\s+\\S+\\s+release\\b" }
 *     ]
 *   }
 *
 * Pattern is a JS regex source. v1 supports JSON only — YAML may come later
 * if there is demand. Keeps the hook dependency-free.
 */
function loadConfig() {
  const home = os.homedir();
  const file = path.join(home, ".connectors", "git-gate.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function mergeDisabled(fromConfig) {
  const fromEnv = (process.env["GIT_GATE_DISABLE"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromCfg = Array.isArray(fromConfig)
    ? fromConfig.filter((s) => typeof s === "string")
    : [];
  return new Set([...fromEnv, ...fromCfg]);
}

function compileExtraRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const out = [];
  for (const r of rawRules) {
    if (
      typeof r?.name !== "string" ||
      !["deny", "ask", "allow"].includes(r?.decision) ||
      typeof r?.reason !== "string" ||
      typeof r?.pattern !== "string"
    ) {
      continue;
    }
    let re;
    try {
      re = new RegExp(r.pattern);
    } catch {
      continue;
    }
    out.push({
      name: r.name,
      decision: r.decision,
      reason: r.reason,
      match: (s) => re.test(s),
    });
  }
  return out;
}
