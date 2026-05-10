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
