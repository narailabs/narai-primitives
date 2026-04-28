#!/usr/bin/env node
// Toolkit-shipped PostToolUse hook. Appends one JSONL line per Bash call
// that invoked this plugin's connector CLI. Fail-soft: errors exit 0.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

async function main() {
  if (process.env["USAGE_TRACKING_ENABLED"] === "0") return;

  const connector = process.env["USAGE_CONNECTOR_NAME"];
  const hint = process.env["USAGE_BIN_HINT"];
  if (!connector || !hint) return;

  // Read hook payload from stdin (Claude Code sends JSON on stdin).
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    return;
  }
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (payload.tool_name !== "Bash") return;

  const command =
    (payload.tool_input && typeof payload.tool_input.command === "string"
      ? payload.tool_input.command
      : "") || "";
  if (!command.includes(hint)) return;

  const stdout =
    (payload.tool_response &&
      typeof payload.tool_response.stdout === "string" &&
      payload.tool_response.stdout) ||
    "";
  const response_bytes = Buffer.byteLength(stdout, "utf-8");
  // Tokenizer: heuristic by default, gpt-4o when opted in. Never throws.
  let estimated_tokens = Math.ceil(response_bytes / 4);
  let token_method = "heuristic";
  const tokenizer = process.env["USAGE_TOKENIZER"];
  if (tokenizer && tokenizer !== "heuristic") {
    try {
      if (tokenizer === "gpt-4o") {
        const mod = await import("gpt-tokenizer").catch(() => null);
        if (mod && typeof mod.encode === "function") {
          estimated_tokens = mod.encode(stdout).length;
          token_method = "gpt-4o";
        }
      }
      // Unknown methods fall through; heuristic already set.
    } catch {
      // fallback already in place
    }
  }

  // Parse --action from command.
  const actionMatch = command.match(/--action\s+([A-Za-z0-9_-]+)/);
  const action = actionMatch ? actionMatch[1] : "unknown";

  // Parse envelope status.
  let status = "unparseable";
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.status === "string") status = env.status;
  } catch {
    // status stays "unparseable"
  }

  const execution_time_ms =
    typeof payload.execution_time_ms === "number"
      ? payload.execution_time_ms
      : undefined;

  const record = {
    ts: new Date().toISOString(),
    session_id: String(payload.session_id ?? "unknown"),
    connector,
    action,
    status,
    response_bytes,
    estimated_tokens,
    token_method,
    ...(execution_time_ms !== undefined ? { execution_time_ms } : {}),
  };

  const baseDir =
    process.env["USAGE_STORAGE_DIR"] ||
    join(process.cwd(), ".claude", "connectors", connector, "usage");
  const file = join(baseDir, `${record.session_id}.jsonl`);

  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // swallow
  }
}

try {
  await main();
} catch {
  // never propagate
}
process.exit(0);
