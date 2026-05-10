import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "create-connector",
  "skills",
  "create-connector",
  "assets",
  "templates",
  "_runtime",
  "connector-gate.mjs.tmpl",
);

function stampGate(scope: string): string {
  const gatePath = path.join(scope, ".connectors", "connector-gate.mjs");
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, fs.readFileSync(TEMPLATE, "utf-8"));
  return gatePath;
}

async function runGate(
  scopeRoot: string,
  payload: object,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const gatePath = stampGate(scopeRoot);
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [gatePath], {
      env: { ...process.env, NARAI_GATE_SCOPE: scopeRoot },
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
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

describe("connector-gate template", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "gate-scope-"));
    fs.mkdirSync(path.join(scope, ".connectors", "connectors"), {
      recursive: true,
    });
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("emits no decision when no connectors exist", async () => {
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits deny when a connector's gates.json matches", async () => {
    const dir = path.join(scope, ".connectors", "connectors", "test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gates.json"),
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
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo deny it" },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("ignores non-Bash tools", async () => {
    const r = await runGate(scope, {
      tool_name: "Read",
      tool_input: { file_path: "/foo" },
    });
    expect(r.stdout).toBe("");
  });

  it("strictest decision wins across multiple connectors", async () => {
    const c1 = path.join(scope, ".connectors", "connectors", "c1");
    const c2 = path.join(scope, ".connectors", "connectors", "c2");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.writeFileSync(
      path.join(c1, "gates.json"),
      JSON.stringify({
        rules: [
          { name: "ask", decision: "ask", reason: "?", pattern: "^echo" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(c2, "gates.json"),
      JSON.stringify({
        rules: [
          { name: "deny", decision: "deny", reason: "!", pattern: "^echo" },
        ],
      }),
    );
    const r = await runGate(scope, {
      tool_name: "Bash",
      tool_input: { command: "echo whatever" },
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
