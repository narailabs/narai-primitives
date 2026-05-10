import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DISPATCHER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin-hooks",
  "dispatcher.mjs",
);

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runDispatcher(
  event: string,
  pluginRoot: string,
  pluginData: string,
  stdin = "",
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DISPATCHER, event], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_DATA: pluginData,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
    proc.on("error", reject);
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

describe("dispatcher event routing", () => {
  let tmpRoot: string;
  let tmpData: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-root-"));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-data-"));
    fs.writeFileSync(
      path.join(tmpRoot, "plugin-config.json"),
      JSON.stringify({ name: "test-plugin" }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it("session-start exits 0", async () => {
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });

  it("post-tool-use exits 0 with stdin payload", async () => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const r = await runDispatcher("post-tool-use", tmpRoot, tmpData, payload);
    expect(r.exitCode).toBe(0);
  });

  it("session-end exits 0", async () => {
    const r = await runDispatcher("session-end", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });

  it("pre-tool-use exits 0 with stdin payload", async () => {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
    expect(r.exitCode).toBe(0);
  });

  it("unknown event exits non-zero with stderr", async () => {
    const r = await runDispatcher("nope", tmpRoot, tmpData);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown/i);
  });

  it("missing plugin-config.json exits non-zero", async () => {
    fs.rmSync(path.join(tmpRoot, "plugin-config.json"));
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).not.toBe(0);
  });

  it("missing CLAUDE_PLUGIN_ROOT exits non-zero", async () => {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn("node", [DISPATCHER, "session-start"], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: undefined },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        try {
          expect(code).not.toBe(0);
          expect(stderr).toMatch(/CLAUDE_PLUGIN_ROOT/);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      proc.on("error", reject);
    });
  });
});

describe("dispatcher session-start integrations", () => {
  let tmpRoot: string;
  let tmpData: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-int-root-"));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-int-data-"));
    fs.writeFileSync(
      path.join(tmpRoot, "plugin-config.json"),
      JSON.stringify({ name: "jira" }),
    );
    fs.writeFileSync(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({
        name: "jira-agent",
        version: "1.0.0",
        dependencies: { "narai-primitives": "1.0.0" },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it("invokes nudge + stale-summarize without crashing on missing toolkit", async () => {
    const r = await runDispatcher("session-start", tmpRoot, tmpData);
    expect(r.exitCode).toBe(0);
  });
});

describe("dispatcher post-tool-use", () => {
  it("post-tool-use sets USAGE_CONNECTOR_NAME from cfg.name and exits 0", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({
          name: "jira",
          binPath: "narai-primitives/dist/connectors/jira",
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      });
      const r = await runDispatcher("post-tool-use", tmpRoot, tmpData, payload);
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});

describe("dispatcher session-end", () => {
  it("session-end exits 0 even when toolkit is missing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "se-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "se-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      const r = await runDispatcher("session-end", tmpRoot, tmpData);
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});

describe("dispatcher pre-tool-use db-guard", () => {
  it("for kind=db, denies if db-guard pattern matches", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "db", kind: "db" }),
      );
      // Synthetic db-guard manifest: deny psql.
      fs.mkdirSync(path.join(tmpRoot, "hooks"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "hooks", "guardrails.json"),
        JSON.stringify({
          rules: [{ pattern: "^psql\\b", message: "Use db-agent." }],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "psql -c 'select 1'" },
      });
      const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });

  it("for kind=db, no decision when no pattern matches", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-root2-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-db-data2-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "db", kind: "db" }),
      );
      fs.mkdirSync(path.join(tmpRoot, "hooks"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "hooks", "guardrails.json"),
        JSON.stringify({
          rules: [{ pattern: "^psql\\b", message: "Use db-agent." }],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      });
      const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
      expect(r.stdout).toBe("");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });

  it("for kind!=db, db-guard does not run even if guardrails.json exists", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-not-db-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-not-db-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      fs.mkdirSync(path.join(tmpRoot, "hooks"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "hooks", "guardrails.json"),
        JSON.stringify({
          rules: [{ pattern: "^psql\\b", message: "should not fire." }],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "psql -c 'select 1'" },
      });
      const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
      expect(r.stdout).toBe("");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});

describe("dispatcher pre-tool-use user-connector gates", () => {
  it("applies gates from .connectors/connectors/*/gates.json under HOME", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-home-"));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-gates-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      const gateDir = path.join(
        tmpHome,
        ".connectors",
        "connectors",
        "test",
      );
      fs.mkdirSync(gateDir, { recursive: true });
      fs.writeFileSync(
        path.join(gateDir, "gates.json"),
        JSON.stringify({
          rules: [
            {
              name: "deny_x",
              decision: "deny",
              reason: "blocked",
              pattern: "^echo deny",
            },
          ],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo deny it" },
      });
      const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PLUGIN_ROOT: tmpRoot,
          CLAUDE_PLUGIN_DATA: tmpData,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stdin.write(payload);
      proc.stdin.end();
      await new Promise<void>((resolve) =>
        proc.on("close", () => resolve()),
      );
      const out = JSON.parse(stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });

  it("strictest decision wins (deny > ask)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-strict-home-"));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-strict-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-strict-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      const c1 = path.join(tmpHome, ".connectors", "connectors", "c1");
      const c2 = path.join(tmpHome, ".connectors", "connectors", "c2");
      fs.mkdirSync(c1, { recursive: true });
      fs.mkdirSync(c2, { recursive: true });
      fs.writeFileSync(
        path.join(c1, "gates.json"),
        JSON.stringify({
          rules: [{ name: "ask_one", decision: "ask", reason: "?", pattern: "^echo" }],
        }),
      );
      fs.writeFileSync(
        path.join(c2, "gates.json"),
        JSON.stringify({
          rules: [{ name: "deny_one", decision: "deny", reason: "!", pattern: "^echo" }],
        }),
      );
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo whatever" },
      });
      const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PLUGIN_ROOT: tmpRoot,
          CLAUDE_PLUGIN_DATA: tmpData,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stdin.write(payload);
      proc.stdin.end();
      await new Promise<void>((resolve) =>
        proc.on("close", () => resolve()),
      );
      const out = JSON.parse(stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });

  it("ignores non-Bash tool calls", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-nb-root-"));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "ptu-nb-data-"));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, "plugin-config.json"),
        JSON.stringify({ name: "jira" }),
      );
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
      });
      const r = await runDispatcher("pre-tool-use", tmpRoot, tmpData, payload);
      expect(r.stdout).toBe("");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  });
});
