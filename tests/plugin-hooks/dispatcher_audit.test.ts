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

function runPreToolUse(opts: {
  pluginRoot: string;
  auditPath?: string;
  stdin: string;
}): Promise<Result> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "au-data-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "au-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "au-cwd-"));
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: opts.pluginRoot,
    CLAUDE_PLUGIN_DATA: data,
    HOME: home,
  };
  if (opts.auditPath !== undefined) env.NARAI_AUDIT_PATH = opts.auditPath;
  else delete env.NARAI_AUDIT_PATH;
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    proc.on("error", reject);
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  });
}

function makeRootWithDenyGate(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "au-root-"));
  fs.writeFileSync(
    path.join(root, "plugin-config.json"),
    JSON.stringify({ name: "test-plugin" }),
  );
  fs.writeFileSync(
    path.join(root, "gates.json"),
    JSON.stringify({
      rules: [{ name: "psql", decision: "deny", reason: "blocked", pattern: "psql" }],
    }),
  );
  return root;
}

const BASH = (command: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

describe("dispatcher — audit of hook decisions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("writes a guardrail_deny record when a command is denied and NARAI_AUDIT_PATH is set", async () => {
    const root = makeRootWithDenyGate();
    roots.push(root);
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "au-log-"));
    roots.push(auditDir);
    const auditPath = path.join(auditDir, "events.jsonl");
    const res = await runPreToolUse({
      pluginRoot: root,
      auditPath,
      stdin: BASH("psql mydb"),
    });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(fs.existsSync(auditPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(auditPath, "utf-8").trim());
    expect(record.event_type).toBe("guardrail_deny");
    expect(record.details.reason).toBe("blocked");
    expect(record.details.command).toBe("psql mydb");
  });

  it("does not write an audit record when NARAI_AUDIT_PATH is unset", async () => {
    const root = makeRootWithDenyGate();
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("psql mydb") });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    // No NARAI_AUDIT_PATH -> nothing to assert beyond the decision; ensure no crash.
    expect(res.exitCode).toBe(0);
  });

  it("does not write an audit record for an allowed command", async () => {
    const root = makeRootWithDenyGate();
    roots.push(root);
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "au-log-"));
    roots.push(auditDir);
    const auditPath = path.join(auditDir, "events.jsonl");
    const res = await runPreToolUse({
      pluginRoot: root,
      auditPath,
      stdin: BASH("echo hi"),
    });
    expect(res.stdout.trim()).toBe("");
    expect(fs.existsSync(auditPath)).toBe(false);
  });
});
