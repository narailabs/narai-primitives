import { describe, it, expect, afterEach } from "vitest";
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

interface Result { stdout: string; stderr: string; exitCode: number }

function run(pluginRoot: string, stdin: string): Promise<Result> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "cs-data-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cs-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cs-cwd-"));
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: data, HOME: home },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    proc.on("error", reject);
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function makeRoot(rules: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-root-"));
  fs.writeFileSync(path.join(root, "plugin-config.json"), JSON.stringify({ name: "test-plugin" }));
  fs.writeFileSync(path.join(root, "gates.json"), JSON.stringify({ rules }));
  return root;
}

const JDBC_RULE = {
  name: "conn_string",
  decision: "deny",
  reason: "connection string",
  pattern: "jdbc:postgresql://",
  applies_to: ["Bash", "Write", "Edit"],
};

describe("dispatcher — Write/Edit content scanning", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("denies a Write whose content matches an applies_to rule", async () => {
    const root = makeRoot([JDBC_RULE]);
    roots.push(root);
    const res = await run(root, JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "app.properties", content: "db.url=jdbc:postgresql://h/db\nname=x" },
    }));
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies an Edit whose new_string matches; ignores old_string", async () => {
    const root = makeRoot([JDBC_RULE]);
    roots.push(root);
    const deny = await run(root, JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "f", old_string: "x", new_string: "jdbc:postgresql://h/db" },
    }));
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const allow = await run(root, JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "f", old_string: "jdbc:postgresql://h/db", new_string: "removed" },
    }));
    expect(allow.stdout.trim()).toBe("");
  });

  it("does NOT scan Write content for a rule without applies_to (default Bash-only)", async () => {
    const root = makeRoot([{ name: "bash_only", decision: "deny", reason: "r", pattern: "jdbc:postgresql://" }]);
    roots.push(root);
    const res = await run(root, JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "f", content: "jdbc:postgresql://h/db" },
    }));
    expect(res.stdout.trim()).toBe("");
  });

  it("still scans Bash commands for the same rule", async () => {
    const root = makeRoot([JDBC_RULE]);
    roots.push(root);
    const res = await run(root, JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "java -jar app --url jdbc:postgresql://h/db" },
    }));
    expect(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("ignores tools that are neither Bash, Write, nor Edit", async () => {
    const root = makeRoot([JDBC_RULE]);
    roots.push(root);
    const res = await run(root, JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "jdbc:postgresql://h/db" },
    }));
    expect(res.stdout.trim()).toBe("");
  });
});
