import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  effectiveEnforcement,
  applyGatesManifest,
} from "../../plugin-hooks/dispatcher.mjs";

const DISPATCHER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugin-hooks",
  "dispatcher.mjs",
);

// ── unit: effectiveEnforcement ──
describe("effectiveEnforcement", () => {
  const orig = process.env.NARAI_GATE_ENFORCEMENT;
  afterEach(() => {
    if (orig === undefined) delete process.env.NARAI_GATE_ENFORCEMENT;
    else process.env.NARAI_GATE_ENFORCEMENT = orig;
  });

  it("defaults to fail_open with no env and no manifest field", () => {
    delete process.env.NARAI_GATE_ENFORCEMENT;
    expect(effectiveEnforcement(undefined)).toBe("fail_open");
  });

  it("is fail_closed when env is fail_closed", () => {
    process.env.NARAI_GATE_ENFORCEMENT = "fail_closed";
    expect(effectiveEnforcement(undefined)).toBe("fail_closed");
  });

  it("is fail_closed when the manifest field is fail_closed", () => {
    delete process.env.NARAI_GATE_ENFORCEMENT;
    expect(effectiveEnforcement("fail_closed")).toBe("fail_closed");
  });

  it("ignores an unrecognized env value (stays fail_open)", () => {
    process.env.NARAI_GATE_ENFORCEMENT = "nope";
    expect(effectiveEnforcement(undefined)).toBe("fail_open");
  });
});

// ── unit: applyGatesManifest regex-compile failure ──
describe("applyGatesManifest — uncompilable pattern", () => {
  const orig = process.env.NARAI_GATE_ENFORCEMENT;
  afterEach(() => {
    if (orig === undefined) delete process.env.NARAI_GATE_ENFORCEMENT;
    else process.env.NARAI_GATE_ENFORCEMENT = orig;
  });

  const badManifest = {
    enforcement: "fail_closed",
    rules: [{ name: "bad", decision: "deny", pattern: "([unclosed" }],
  };

  it("denies on an uncompilable pattern under fail_closed (via manifest field)", () => {
    delete process.env.NARAI_GATE_ENFORCEMENT;
    const decisions: { decision: string; reason: string }[] = [];
    applyGatesManifest(badManifest, "test", "echo hi", new Set(), decisions);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("deny");
  });

  it("skips (no decision) on an uncompilable pattern under fail_open", () => {
    delete process.env.NARAI_GATE_ENFORCEMENT;
    const decisions: { decision: string; reason: string }[] = [];
    const openManifest = { rules: badManifest.rules };
    applyGatesManifest(openManifest, "test", "echo hi", new Set(), decisions);
    expect(decisions).toHaveLength(0);
  });
});

// ── unit: applyGatesManifest pattern flags / ignore_case ──
describe("applyGatesManifest — pattern flags", () => {
  const run = (
    rule: Record<string, unknown>,
    text: string,
    enforcement?: string,
  ) => {
    const decisions: { decision: string; reason: string }[] = [];
    applyGatesManifest({ enforcement, rules: [rule] }, "test", text, new Set(), decisions);
    return decisions;
  };

  it("ignore_case folds in 'i' (matches uppercase)", () => {
    const r = run(
      { name: "imp", decision: "deny", pattern: "import\\s+psycopg2", ignore_case: true },
      "IMPORT psycopg2",
    );
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe("deny");
  });

  it("explicit flags:'i' matches case-insensitively", () => {
    expect(
      run({ name: "p", decision: "ask", pattern: "post", flags: "i" }, "send POST"),
    ).toHaveLength(1);
  });

  it("backward compatible: no flags stays case-sensitive (no match)", () => {
    expect(run({ name: "p", decision: "deny", pattern: "import" }, "IMPORT")).toHaveLength(0);
  });

  it("denies an unknown flag under fail_closed", () => {
    const r = run(
      { name: "bad", decision: "deny", pattern: "a", flags: "z" },
      "echo hi",
      "fail_closed",
    );
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe("deny");
  });

  it("skips (no decision) an unknown flag under fail_open", () => {
    expect(run({ name: "bad", decision: "deny", pattern: "a", flags: "z" }, "echo hi")).toHaveLength(0);
  });

  it("rejects the 'g' flag (lastIndex footgun) as unknown under fail_closed", () => {
    const r = run(
      { name: "bad", decision: "deny", pattern: "a", flags: "g" },
      "echo hi",
      "fail_closed",
    );
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe("deny");
  });

  it("rejects the 'y' flag as unknown under fail_closed", () => {
    const r = run(
      { name: "bad", decision: "deny", pattern: "a", flags: "y" },
      "echo hi",
      "fail_closed",
    );
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe("deny");
  });
});

// ── integration: subprocess ──
interface Result { stdout: string; stderr: string; exitCode: number }

function runPreToolUse(opts: {
  pluginRoot: string;
  enforcement?: string;
  stdin: string;
}): Promise<Result> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "fc-data-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fc-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cwd-"));
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: opts.pluginRoot,
    CLAUDE_PLUGIN_DATA: data,
    HOME: home,
  };
  if (opts.enforcement !== undefined) env.NARAI_GATE_ENFORCEMENT = opts.enforcement;
  else delete env.NARAI_GATE_ENFORCEMENT;
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

function makeRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc-root-"));
  fs.writeFileSync(
    path.join(root, "plugin-config.json"),
    JSON.stringify({ name: "test-plugin" }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const BASH = (command: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

describe("dispatcher gates — fail-closed (subprocess)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("denies a malformed gates.json under fail_closed", async () => {
    const root = makeRoot({ "gates.json": "{ this is not json" });
    roots.push(root);
    const res = await runPreToolUse({
      pluginRoot: root,
      enforcement: "fail_closed",
      stdin: BASH("echo hi"),
    });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows (no output) a malformed gates.json under default fail_open", async () => {
    const root = makeRoot({ "gates.json": "{ this is not json" });
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("echo hi") });
    expect(res.stdout.trim()).toBe("");
  });

  it("denies an uncompilable rule when the manifest declares fail_closed", async () => {
    const root = makeRoot({
      "gates.json": JSON.stringify({
        enforcement: "fail_closed",
        rules: [{ name: "bad", decision: "deny", pattern: "([unclosed" }],
      }),
    });
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("echo hi") });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("does not over-deny: a valid non-matching manifest under fail_closed allows", async () => {
    const root = makeRoot({
      "gates.json": JSON.stringify({
        enforcement: "fail_closed",
        rules: [{ name: "psql", decision: "deny", pattern: "psql" }],
      }),
    });
    roots.push(root);
    const res = await runPreToolUse({
      pluginRoot: root,
      enforcement: "fail_closed",
      stdin: BASH("echo hi"),
    });
    expect(res.stdout.trim()).toBe("");
  });
});

function makeDbRoot(guardrailsContent: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc-dbroot-"));
  fs.writeFileSync(
    path.join(root, "plugin-config.json"),
    JSON.stringify({ name: "db", kind: "db" }),
  );
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "guardrails.json"), guardrailsContent);
  return root;
}

describe("dispatcher db-guard — fail-closed (subprocess)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("denies when guardrails.json will not load under fail_closed", async () => {
    const root = makeDbRoot("{ not valid json");
    roots.push(root);
    const res = await runPreToolUse({
      pluginRoot: root,
      enforcement: "fail_closed",
      stdin: BASH("psql mydb"),
    });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows (no output) a broken guardrails.json under default fail_open", async () => {
    const root = makeDbRoot("{ not valid json");
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("psql mydb") });
    expect(res.stdout.trim()).toBe("");
  });
});

describe("dispatcher — fail-closed on unparseable input (FIX 1a)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("denies non-JSON stdin under fail_closed", async () => {
    const root = makeRoot({});
    roots.push(root);
    const res = await runPreToolUse({
      pluginRoot: root,
      enforcement: "fail_closed",
      stdin: "this is not json {",
    });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows (no output) non-JSON stdin under default fail_open", async () => {
    const root = makeRoot({});
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: "this is not json {" });
    expect(res.stdout.trim()).toBe("");
  });

  it("still allows a valid-but-unmatched command under fail_closed", async () => {
    const root = makeRoot({
      "gates.json": JSON.stringify({
        rules: [{ name: "psql", decision: "deny", pattern: "psql" }],
      }),
    });
    roots.push(root);
    const res = await runPreToolUse({
      pluginRoot: root,
      enforcement: "fail_closed",
      stdin: BASH("echo hello world"),
    });
    expect(res.stdout.trim()).toBe("");
  });
});

describe("dispatcher db-guard — honors manifest enforcement field (FIX 1b)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  // Valid JSON (so `enforcement` is readable) but an invalid manifest shape
  // (version 2) so loadGuardrailManifest throws — exercising the engine-throw
  // path while the manifest's own fail_closed field is available.
  it("denies via the manifest enforcement field with NO env var set", async () => {
    const root = makeDbRoot(
      JSON.stringify({ version: 2, name: "x", enforcement: "fail_closed", rules: [] }),
    );
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("psql mydb") });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows (no output) the same manifest shape when it declares fail_open", async () => {
    const root = makeDbRoot(
      JSON.stringify({ version: 2, name: "x", enforcement: "fail_open", rules: [] }),
    );
    roots.push(root);
    const res = await runPreToolUse({ pluginRoot: root, stdin: BASH("psql mydb") });
    expect(res.stdout.trim()).toBe("");
  });
});

describe("dispatcher — config-declared enforcement default (ITEM 2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  // Full control over plugin-config enforcement, the plugin-root gates.json,
  // a user/cwd gates.json, the env var, and stdin — so all three "no manifest
  // available" sites can be driven with NO NARAI_GATE_ENFORCEMENT set.
  function run(opts: {
    enforcement?: "fail_open" | "fail_closed";
    pluginGates?: string;
    userGates?: string;
    env?: boolean;
    stdin: string;
  }): Promise<Result> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-root-"));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-data-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cwd-"));
    dirs.push(root, data, home, cwd);
    const cfg: Record<string, string> = { name: "test-plugin" };
    if (opts.enforcement !== undefined) cfg.enforcement = opts.enforcement;
    fs.writeFileSync(path.join(root, "plugin-config.json"), JSON.stringify(cfg));
    if (opts.pluginGates !== undefined) {
      fs.writeFileSync(path.join(root, "gates.json"), opts.pluginGates);
    }
    if (opts.userGates !== undefined) {
      const gd = path.join(home, ".connectors", "connectors", "x");
      fs.mkdirSync(gd, { recursive: true });
      fs.writeFileSync(path.join(gd, "gates.json"), opts.userGates);
    }
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
      HOME: home,
    };
    if (opts.env) env.NARAI_GATE_ENFORCEMENT = "fail_closed";
    else delete env.NARAI_GATE_ENFORCEMENT;
    return new Promise((resolve, reject) => {
      const proc = spawn("node", [DISPATCHER, "pre-tool-use"], {
        env, cwd, stdio: ["pipe", "pipe", "pipe"],
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

  const deny = (res: Result) =>
    JSON.parse(res.stdout).hookSpecificOutput.permissionDecision;

  // ── with config default fail_closed and NO env var: all three sites deny ──
  it("site 1 (unparseable stdin) denies via config default, no env var", async () => {
    const res = await run({ enforcement: "fail_closed", stdin: "not json {" });
    expect(deny(res)).toBe("deny");
  });

  it("site 2 (malformed plugin-root gates.json) denies via config default", async () => {
    const res = await run({
      enforcement: "fail_closed",
      pluginGates: "{ broken",
      stdin: BASH("echo hi"),
    });
    expect(deny(res)).toBe("deny");
  });

  it("site 3 (malformed user/cwd gates.json) denies via config default", async () => {
    const res = await run({
      enforcement: "fail_closed",
      userGates: "{ broken",
      stdin: BASH("echo hi"),
    });
    expect(deny(res)).toBe("deny");
  });

  // ── with no config default and no env var: all three still allow ──
  it("site 1 allows with neither env nor config default", async () => {
    const res = await run({ stdin: "not json {" });
    expect(res.stdout.trim()).toBe("");
  });

  it("site 2 allows with neither env nor config default", async () => {
    const res = await run({ pluginGates: "{ broken", stdin: BASH("echo hi") });
    expect(res.stdout.trim()).toBe("");
  });

  it("site 3 allows with neither env nor config default", async () => {
    const res = await run({ userGates: "{ broken", stdin: BASH("echo hi") });
    expect(res.stdout.trim()).toBe("");
  });

  // ── config fail_open does not weaken; env var still forces fail-closed ──
  it("config fail_open keeps default (malformed gates allowed)", async () => {
    const res = await run({
      enforcement: "fail_open",
      pluginGates: "{ broken",
      stdin: BASH("echo hi"),
    });
    expect(res.stdout.trim()).toBe("");
  });

  it("env var forces fail-closed even when config says fail_open", async () => {
    const res = await run({
      enforcement: "fail_open",
      env: true,
      pluginGates: "{ broken",
      stdin: BASH("echo hi"),
    });
    expect(deny(res)).toBe("deny");
  });
});
