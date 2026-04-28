/** End-to-end integration test for plugin/hooks/guardrails.mjs.
 *
 *  Builds a tmpdir-backed HOME with:
 *   - ~/.connectors/config.yaml enabling a `db` connector,
 *   - ~/src/connectors/db-agent-connector/plugin/hooks/guardrails.json that
 *     blocks `psql`,
 *  spawns the hook with a Bash payload, and asserts deny output. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "..", "..", "plugin", "hooks", "guardrails.mjs");
const HUB_ROOT = path.resolve(__dirname, "..", "..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-guard-hook-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runHook(stdin: string, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [HOOK], {
      env: { ...process.env, ...env },
      cwd: tmp, // ensure no repo-level ./.connectors/config.yaml leaks in
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function setupFixture() {
  // ~/.connectors/config.yaml enabling the `db` connector.
  fs.mkdirSync(path.join(tmp, ".connectors"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".connectors", "config.yaml"),
    [
      "enforce_hooks: true",
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    enforce_hooks: true",
      "",
    ].join("\n"),
  );

  // dev-fallback: ~/src/connectors/db-agent-connector/plugin/hooks/guardrails.json
  const dbHooks = path.join(tmp, "src", "connectors", "db-agent-connector", "plugin", "hooks");
  fs.mkdirSync(dbHooks, { recursive: true });
  fs.writeFileSync(
    path.join(dbHooks, "guardrails.json"),
    JSON.stringify({
      version: 1,
      name: "db-agent-connector",
      rules: [
        {
          block_first_token_basename: ["psql"],
          redirect: "Use db-agent --env <name> --sql instead.",
        },
      ],
    }),
  );
}

describe("plugin/hooks/guardrails.mjs", () => {
  it("denies a blocked command (psql) when an enabled connector ships a matching manifest", async () => {
    setupFixture();
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "psql -V" },
    });
    const result = await runHook(payload, {
      HOME: tmp,
      CLAUDE_PLUGIN_DATA: HUB_ROOT, // points at hub's node_modules/@narai/connector-toolkit
    });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    // Confirm both the matched token AND the source connector's name flowed
    // through the toolkit's defaultDenyMessage — catches wiring regressions
    // where matching works but the message gets mangled.
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(
      /db-agent.*psql|psql.*db-agent/i,
    );
  });

  it("denies when a blocked token is nested inside `bash -c \"...\"` (toolkit recursion plumbed through)", async () => {
    setupFixture();
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'bash -c "psql -V"' },
    });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies blocked command when config uses tab indentation (regression: indent-agnostic YAML scan)", async () => {
    // Tab-indented config — the original 2-space-only regex would silently
    // miss the connector entry and fail open.
    fs.mkdirSync(path.join(tmp, ".connectors"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".connectors", "config.yaml"),
      [
        "enforce_hooks: true",
        "connectors:",
        "\tdb:",
        "\t\tskill: db-agent-connector",
        "\t\tenforce_hooks: true",
        "",
      ].join("\n"),
    );
    const dbHooks = path.join(tmp, "src", "connectors", "db-agent-connector", "plugin", "hooks");
    fs.mkdirSync(dbHooks, { recursive: true });
    fs.writeFileSync(
      path.join(dbHooks, "guardrails.json"),
      JSON.stringify({
        version: 1,
        name: "db-agent-connector",
        rules: [{ block_first_token_basename: ["psql"] }],
      }),
    );
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "psql -V" },
    });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("is silent (exit 0, empty stdout) for non-Bash tools", async () => {
    setupFixture();
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("is silent when the command is allowed (no matching rule)", async () => {
    setupFixture();
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("respects per-connector enforce_hooks: false (skips that connector's manifest)", async () => {
    setupFixture();
    // Override config to disable hook enforcement for db.
    fs.writeFileSync(
      path.join(tmp, ".connectors", "config.yaml"),
      [
        "enforce_hooks: true",
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    enforce_hooks: false",
        "",
      ].join("\n"),
    );
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "psql -V" },
    });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open (exit 0, empty stdout) when no config files exist", async () => {
    // No fixture; tmp is bare.
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "psql -V" },
    });
    const result = await runHook(payload, { HOME: tmp, CLAUDE_PLUGIN_DATA: HUB_ROOT });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});
