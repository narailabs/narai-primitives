/**
 * smoke.test.ts — end-to-end test of the git-connector gates via the shared
 * dispatcher. Spawns dispatcher.mjs as a subprocess with the real
 * `plugins/git-connector/` directory as CLAUDE_PLUGIN_ROOT so plugin-config.json
 * and gates.json are loaded from the actual plugin artifact.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DISPATCHER = path.join(REPO_ROOT, "plugin-hooks", "dispatcher.mjs");
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "git-connector");

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(
  payload: unknown | string,
  env: Record<string, string | undefined> = {},
): Promise<Result> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-smoke-home-"));
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "git-smoke-data-"));
  try {
    return await new Promise<Result>((resolve, reject) => {
      const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          CLAUDE_PLUGIN_DATA: tmpData,
          ...env,
        },
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
      const body =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      proc.stdin.write(body);
      proc.stdin.end();
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
}

function parseDecision(stdout: string): {
  permissionDecision: string;
  permissionDecisionReason: string;
} | null {
  if (stdout.trim().length === 0) return null;
  return JSON.parse(stdout).hookSpecificOutput ?? null;
}

describe("smoke: deny path", () => {
  it("denies push to main with the expected envelope", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      hook_event_name: "PreToolUse",
    });
    expect(r.exitCode).toBe(0);
    const d = parseDecision(r.stdout);
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
    });
    expect(parseDecision(r.stdout)!.permissionDecision).toBe("ask");
  });

  it("asks on force push to a feature branch", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push --force origin feature" },
      hook_event_name: "PreToolUse",
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
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits no decision for non-git commands", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      hook_event_name: "PreToolUse",
    });
    expect(r.stdout).toBe("");
  });

  it("ignores non-Bash tool calls", async () => {
    const r = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo" },
      hook_event_name: "PreToolUse",
    });
    expect(r.stdout).toBe("");
  });
});

describe("smoke: graceful failure", () => {
  it("does not crash on malformed stdin", async () => {
    const r = await runHook("not valid json {");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("does not crash when tool_input.command is missing", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: {},
      hook_event_name: "PreToolUse",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("smoke: NARAI_GATE_DISABLE", () => {
  it("silences a rule by name", async () => {
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push" },
        hook_event_name: "PreToolUse",
      },
      { NARAI_GATE_DISABLE: "push" },
    );
    expect(r.stdout).toBe("");
  });

  it("disabling push_main lets the push (ask) rule still fire", async () => {
    const r = await runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        hook_event_name: "PreToolUse",
      },
      { NARAI_GATE_DISABLE: "push_main" },
    );
    expect(parseDecision(r.stdout)!.permissionDecision).toBe("ask");
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
    });
    expect(parseDecision(r.stdout)!.permissionDecision).toBe("deny");
  });

  it("env-var prefix on a chained git command still classifies", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "cd repo && FOO=bar git push --force" },
      hook_event_name: "PreToolUse",
    });
    const d = parseDecision(r.stdout);
    expect(d!.permissionDecision).toBe("ask");
    expect(d!.permissionDecisionReason).toMatch(/force/i);
  });
});

describe("smoke: user-gate composability", () => {
  it("a user gate (~/.connectors/connectors/x/gates.json) can layer on top", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-overlay-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "git-overlay-data-"));
    try {
      const gateDir = path.join(
        tmpHome,
        ".connectors",
        "connectors",
        "release",
      );
      fs.mkdirSync(gateDir, { recursive: true });
      fs.writeFileSync(
        path.join(gateDir, "gates.json"),
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
      const r = await new Promise<Result>((resolve, reject) => {
        const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
          env: {
            ...process.env,
            HOME: tmpHome,
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
            CLAUDE_PLUGIN_DATA: tmpData,
          },
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
        proc.stdin.write(
          JSON.stringify({
            tool_name: "Bash",
            tool_input: { command: "git push origin release/v1" },
            hook_event_name: "PreToolUse",
          }),
        );
        proc.stdin.end();
      });
      const d = parseDecision(r.stdout);
      expect(d!.permissionDecision).toBe("deny");
      expect(d!.permissionDecisionReason).toMatch(/release/i);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});
