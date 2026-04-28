import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(here, "..", "..", "..", "plugin-hooks");

let workDir: string;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "usage-hooks-")); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

function runHook(script: string, env: Record<string, string>, stdin: string) {
  return spawnSync("node", [join(hooksDir, script)], {
    env: { ...process.env, ...env, USAGE_STORAGE_DIR: join(workDir, "usage") },
    input: stdin,
    encoding: "utf-8",
  });
}

describe("usage-record.mjs", () => {
  it("writes one JSONL line for a matching Bash command", () => {
    const payload = JSON.stringify({
      session_id: "sess1",
      tool_name: "Bash",
      tool_input: { command: "npx narai-primitives/github --action repo_info" },
      tool_response: { stdout: JSON.stringify({ status: "success", data: {} }) },
    });
    const res = runHook("usage-record.mjs", {
      USAGE_CONNECTOR_NAME: "github",
      USAGE_BIN_HINT: "narai-primitives/github",
    }, payload);
    expect(res.status).toBe(0);
    const file = join(workDir, "usage", "sess1.jsonl");
    expect(existsSync(file)).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(line.connector).toBe("github");
    expect(line.action).toBe("repo_info");
    expect(line.status).toBe("success");
    expect(line.response_bytes).toBeGreaterThan(0);
  });

  it("ignores non-Bash tool_name", () => {
    const res = runHook("usage-record.mjs", {
      USAGE_CONNECTOR_NAME: "github",
      USAGE_BIN_HINT: "narai-primitives/github",
    }, JSON.stringify({ session_id: "s", tool_name: "Read" }));
    expect(res.status).toBe(0);
    expect(existsSync(join(workDir, "usage", "s.jsonl"))).toBe(false);
  });

  it("ignores Bash commands that don't contain the hint", () => {
    const payload = JSON.stringify({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: { stdout: "" },
    });
    const res = runHook("usage-record.mjs", {
      USAGE_CONNECTOR_NAME: "github",
      USAGE_BIN_HINT: "narai-primitives/github",
    }, payload);
    expect(res.status).toBe(0);
    expect(existsSync(join(workDir, "usage", "s.jsonl"))).toBe(false);
  });

  it("exits 0 on malformed stdin", () => {
    const res = runHook("usage-record.mjs", {
      USAGE_CONNECTOR_NAME: "github",
      USAGE_BIN_HINT: "narai-primitives/github",
    }, "not json");
    expect(res.status).toBe(0);
  });
});

describe("session-summary.mjs", () => {
  it("produces a summary json and md from an existing jsonl", () => {
    // Seed a jsonl file in the expected location
    const dir = join(workDir, "usage");
    mkdirSync(dir, { recursive: true });
    const records = [
      { ts: "2026-04-23T12:00:00.000Z", session_id: "S", connector: "github", action: "repo_info", status: "success", response_bytes: 100, estimated_tokens: 25 },
      { ts: "2026-04-23T12:01:00.000Z", session_id: "S", connector: "github", action: "get_file", status: "success", response_bytes: 300, estimated_tokens: 75 },
    ];
    writeFileSync(join(dir, "S.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");

    const res = runHook("session-summary.mjs", {
      USAGE_CONNECTOR_NAME: "github",
    }, JSON.stringify({ session_id: "S" }));
    expect(res.status).toBe(0);
    const summaryJson = JSON.parse(readFileSync(join(dir, "summary-S.json"), "utf-8"));
    expect(summaryJson.total_calls).toBe(2);
    expect(summaryJson.by_action.repo_info.calls).toBe(1);
    const md = readFileSync(join(dir, "summary-S.md"), "utf-8");
    expect(md).toContain("# github usage — session S");
  });

  it("is idempotent (skips if summary already exists)", () => {
    const dir = join(workDir, "usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "S.jsonl"), JSON.stringify({ ts: "2026-04-23T12:00:00.000Z", session_id: "S", connector: "github", action: "x", status: "success", response_bytes: 1, estimated_tokens: 1 }) + "\n");
    writeFileSync(join(dir, "summary-S.json"), `{"marker":"preexisting"}`);
    runHook("session-summary.mjs", { USAGE_CONNECTOR_NAME: "github" }, JSON.stringify({ session_id: "S" }));
    expect(JSON.parse(readFileSync(join(dir, "summary-S.json"), "utf-8")).marker).toBe("preexisting");
  });
});

describe("stale-summarize.mjs", () => {
  it("summarizes a stale orphan jsonl and skips fresh ones", () => {
    const dir = join(workDir, "usage");
    mkdirSync(dir, { recursive: true });
    // Stale orphan
    const staleJsonl = join(dir, "OLD.jsonl");
    writeFileSync(staleJsonl, JSON.stringify({ ts: "2026-04-23T12:00:00.000Z", session_id: "OLD", connector: "github", action: "x", status: "success", response_bytes: 1, estimated_tokens: 1 }) + "\n");
    const oldTime = Date.now() / 1000 - 24 * 60 * 60;
    utimesSync(staleJsonl, oldTime, oldTime);

    // Fresh orphan
    const freshJsonl = join(dir, "NEW.jsonl");
    writeFileSync(freshJsonl, JSON.stringify({ ts: "2026-04-23T12:00:00.000Z", session_id: "NEW", connector: "github", action: "x", status: "success", response_bytes: 1, estimated_tokens: 1 }) + "\n");

    const res = runHook("stale-summarize.mjs", {
      USAGE_CONNECTOR_NAME: "github",
      USAGE_SUMMARY_STALE_HOURS: "1",
    }, "");
    expect(res.status).toBe(0);
    expect(existsSync(join(dir, "summary-OLD.json"))).toBe(true);
    expect(existsSync(join(dir, "summary-NEW.json"))).toBe(false);
  });
});
