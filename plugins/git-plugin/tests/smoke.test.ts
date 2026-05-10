/**
 * smoke.test.ts — end-to-end subprocess tests for git_gate.mjs.
 *
 * Spawns the hook script as a real Node process, pipes a Claude Code
 * PreToolUse payload via stdin, and asserts on the JSON written to
 * stdout. Complements the pure-classifier unit tests in
 * `tests/plugins/git-plugin/rules.test.ts` by covering the parts those
 * tests skip: stdin reading, JSON parsing, env-var handling, config
 * file loading, and stdout shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "git_gate.mjs",
);

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<HookResult> {
  return new Promise<HookResult>((resolve, reject) => {
    const proc = spawn("node", [HOOK_PATH], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    proc.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
    proc.on("error", reject);
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function parseDecision(stdout: string): {
  permissionDecision: string;
  permissionDecisionReason: string;
} | null {
  if (stdout.trim().length === 0) return null;
  const parsed = JSON.parse(stdout);
  return parsed.hookSpecificOutput ?? null;
}

describe("smoke: deny path", () => {
  it("denies push to main with the expected JSON envelope", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const d = parseDecision(r.stdout);
    expect(d).not.toBeNull();
    expect(d!.permissionDecision).toBe("deny");
    expect(d!.permissionDecisionReason).toMatch(/main\/master/i);
  });
});

describe("smoke: ask path", () => {
  it("asks on plain push", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.exitCode).toBe(0);
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("ask");
  });

  it("asks on force push to a feature branch", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push --force origin feature" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("ask");
    expect(d!.permissionDecisionReason).toMatch(/force/i);
  });

  it("asks on git clean -fdx", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git clean -fdx" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(parseDecision(r.stdout)!.permissionDecision).toBe("ask");
  });
});

describe("smoke: no-decision path", () => {
  it("emits no decision for git status (safe)", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits no decision for non-git commands", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.stdout).toBe("");
  });

  it("ignores non-Bash tool calls", async () => {
    const r = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.stdout).toBe("");
  });
});

describe("smoke: graceful failure", () => {
  it("does not crash on malformed stdin", async () => {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn("node", [HOOK_PATH], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
      proc.on("close", (code) => {
        try {
          expect(code).toBe(0);
          expect(stdout).toBe("");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      proc.on("error", reject);
      proc.stdin.write("not valid json {");
      proc.stdin.end();
    });
  });

  it("does not crash when tool_input.command is missing", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: {},
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("smoke: env-var override", () => {
  it("GIT_GATE_DISABLE silences the named rule", async () => {
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push" },
        hook_event_name: "PreToolUse",
        cwd: "/tmp",
      },
      { GIT_GATE_DISABLE: "push" },
    );
    expect(r.stdout).toBe("");
  });

  it("disabling push_main allows main pushes to fall through to push (still asks)", async () => {
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        hook_event_name: "PreToolUse",
        cwd: "/tmp",
      },
      { GIT_GATE_DISABLE: "push_main" },
    );
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("ask");
  });
});

describe("smoke: config file override", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-gate-smoke-"));
    fs.mkdirSync(path.join(tmpHome, ".connectors"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("custom rule from ~/.connectors/git-gate.json fires", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".connectors", "git-gate.json"),
      JSON.stringify({
        rules: [
          {
            name: "deny_release",
            decision: "deny",
            reason: "release branches need SRE",
            pattern: "^git\\s+push\\s+\\S+\\s+release\\b",
          },
        ],
      }),
    );
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push origin release/v1" },
        hook_event_name: "PreToolUse",
        cwd: "/tmp",
      },
      { HOME: tmpHome },
    );
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("deny");
    expect(d!.permissionDecisionReason).toMatch(/release/i);
  });

  it("config-disabled rule is silenced", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".connectors", "git-gate.json"),
      JSON.stringify({ disabled: ["push"] }),
    );
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push" },
        hook_event_name: "PreToolUse",
        cwd: "/tmp",
      },
      { HOME: tmpHome },
    );
    expect(r.stdout).toBe("");
  });

  it("malformed config does not crash the hook", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".connectors", "git-gate.json"),
      "{ not valid json",
    );
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        hook_event_name: "PreToolUse",
        cwd: "/tmp",
      },
      { HOME: tmpHome },
    );
    // Hook ignores the bad config and falls back to defaults.
    expect(r.exitCode).toBe(0);
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("deny");
  });
});

describe("smoke: compound commands", () => {
  it("strictest decision wins across `&&` segments", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: {
        command: "git push origin feature && git push origin main",
      },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("deny");
  });

  it("env-var prefix on a chained git command still classifies", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "cd repo && FOO=bar git push --force" },
      hook_event_name: "PreToolUse",
      cwd: "/tmp",
    });
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("ask");
    expect(d!.permissionDecisionReason).toMatch(/force/i);
  });
});
