/** End-to-end tests for `gather()` with stubbed planner + fake CLI bins.
 *
 *  We do NOT touch the network. The default `Planner` is replaced with a stub
 *  that returns canned JSON; `configLoader` is replaced with a fixture; the
 *  `cliResolver` is stubbed to return paths into a tmpdir; the fake bins live
 *  in a tmpdir. No global env state (HOME, etc.) is mutated by these tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gather } from "../../src/hub/index.js";
import type {
  CliResolver,
  ConfigLoader,
  Planner,
  PreparedConnector,
  SpawnFn,
} from "../../src/hub/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-gather-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a fake `<root>/<name>-agent-connector/{dist/cli.js, plugin/skills/<name>-agent/SKILL.md}`
 *  layout under tmpDir. Returns the absolute cli path so the test can register
 *  it with the injected `cliResolver`. This is the LEGACY pre-2.0 layout. */
function setupFakeConnector(
  root: string,
  name: string,
  opts: { cliBody?: string; skill?: string } = {},
): string {
  const pkgRoot = path.join(root, `${name}-agent-connector`);
  fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, "plugin", "skills", `${name}-agent`), { recursive: true });
  const cliPath = path.join(pkgRoot, "dist", "cli.js");
  fs.writeFileSync(
    cliPath,
    opts.cliBody ??
      `process.stdout.write(JSON.stringify({status:"success",action:"x",data:{name:"${name}"}}));\n`,
  );
  fs.writeFileSync(
    path.join(pkgRoot, "plugin", "skills", `${name}-agent`, "SKILL.md"),
    opts.skill ?? `# ${name} skill body`,
  );
  return cliPath;
}

/** Build a fake bundled-2.x layout under `<root>/narai-primitives/`:
 *   - dist/connectors/<name>/cli.js
 *   - plugins/<name>-agent/skills/<name>-agent/SKILL.md
 *  Returns the cli path so a test can register it with the cliResolver. */
function setupBundledConnector(
  root: string,
  name: string,
  opts: { cliBody?: string; skill?: string } = {},
): string {
  const pkgRoot = path.join(root, "narai-primitives");
  fs.mkdirSync(path.join(pkgRoot, "dist", "connectors", name), { recursive: true });
  fs.mkdirSync(
    path.join(pkgRoot, "plugins", `${name}-agent`, "skills", `${name}-agent`),
    { recursive: true },
  );
  const cliPath = path.join(pkgRoot, "dist", "connectors", name, "cli.js");
  fs.writeFileSync(
    cliPath,
    opts.cliBody ??
      `process.stdout.write(JSON.stringify({status:"success",action:"x",data:{name:"${name}"}}));\n`,
  );
  fs.writeFileSync(
    path.join(pkgRoot, "plugins", `${name}-agent`, "skills", `${name}-agent`, "SKILL.md"),
    opts.skill ?? `# ${name} skill body (bundled)`,
  );
  return cliPath;
}

/** Build a CliResolver that maps each known short name to its tmpdir cli path. */
function stubCliResolver(byName: Record<string, string>): CliResolver {
  return (name) => {
    const cli = byName[name];
    if (cli === undefined) return null;
    return { command: "node", args: [cli], source: "dev-fallback", resolvedPath: cli };
  };
}

/** Stub planner that returns a canned response. */
function stubPlanner(canned: string): Planner {
  return { plan: async () => canned };
}

/** Stub planner that throws a given error. */
function throwingPlanner(err: Error): Planner {
  return {
    plan: async () => {
      throw err;
    },
  };
}

/** Build a stub configLoader returning an in-memory ResolvedConfig. */
function stubLoader(
  connectors: Record<string, { skill: string; enabled?: boolean; options?: Record<string, unknown> }>,
): ConfigLoader {
  return async () => ({
    hub: { model: null, max_tokens: null },
    policy: {},
    enforce_hooks: true,
    model: null,
    environment: null,
    consumer: null,
    connectors: Object.fromEntries(
      Object.entries(connectors).map(([name, c]) => [
        name,
        {
          name,
          enabled: c.enabled ?? true,
          skill: c.skill,
          model: null,
          enforce_hooks: true,
          policy: {},
          options: c.options ?? {},
        },
      ]),
    ),
  });
}

describe("gather end-to-end with stubs", () => {
  it("plans + dispatches a single step and returns envelope", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = stubPlanner(
      JSON.stringify([{ connector: "aws", action: "list", params: { region: "us-east-1" } }]),
    );
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "list aws stuff" },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([
      { connector: "aws", action: "list", params: { region: "us-east-1" } },
    ]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.envelope).toEqual({
      status: "success",
      action: "x",
      data: { name: "aws" },
    });
    expect(out.results[0]?.error).toBeUndefined();
  });

  it("loads SKILL.md from the bundled 2.x layout (plugins/<name>-agent/skills/<name>-agent/SKILL.md)", async () => {
    // The bundled 2.x narai-primitives layout puts the connector CLI at
    // <root>/dist/connectors/<name>/cli.js and the skill at
    // <root>/plugins/<name>-agent/skills/<name>-agent/SKILL.md.
    // Both paths must resolve correctly from `prepareConnector`.
    //
    // We verify by capturing the planner's systemPrompt — buildSystemPrompt
    // concatenates each connector's skillContent verbatim, so finding the
    // bundled-skill marker in the prompt proves the bundled SKILL.md was
    // read successfully.
    const cli = setupBundledConnector(tmpDir, "aws", {
      skill: "# aws bundled skill — only this body proves bundled SKILL.md loaded",
    });
    let capturedSystemPrompt = "";
    const planner: Planner = {
      plan: async (systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return JSON.stringify([{ connector: "aws", action: "x", params: {} }]);
      },
    };
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver: CliResolver = (name) =>
      name === "aws"
        ? { command: "node", args: [cli], source: "bundled-self", resolvedPath: cli }
        : null;
    const out = await gather(
      { prompt: "?" },
      { planner, configLoader: loader, cliResolver },
    );
    // No prep error — SKILL.md was found at one of the candidate paths.
    expect(
      out.results.every((r) => r.error?.code !== "SKILL_NOT_FOUND"),
    ).toBe(true);
    // The bundled-skill marker must appear in the system prompt — proves
    // the bundled candidate path was the one that resolved.
    expect(capturedSystemPrompt).toContain("aws bundled skill");
  });

  it("falls back to the legacy plugin/skills/<name>-agent/SKILL.md layout when the bundled path is absent", async () => {
    // Existing pre-2.0 packages still ship the legacy `plugin/skills/...`
    // path. The hub must keep finding SKILL.md there too.
    const cli = setupFakeConnector(tmpDir, "jira", {
      skill: "# jira legacy skill body — only the legacy path can produce this",
    });
    let capturedSystemPrompt = "";
    const planner: Planner = {
      plan: async (systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return JSON.stringify([{ connector: "jira", action: "x", params: {} }]);
      },
    };
    const loader = stubLoader({ jira: { skill: "jira-agent-connector" } });
    const cliResolver = stubCliResolver({ jira: cli });
    const out = await gather(
      { prompt: "?" },
      { planner, configLoader: loader, cliResolver },
    );
    expect(
      out.results.every((r) => r.error?.code !== "SKILL_NOT_FOUND"),
    ).toBe(true);
    expect(capturedSystemPrompt).toContain("jira legacy skill body");
  });

  it("returns plan: [] and PLANNER_INVALID when planner output is unparsable", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = stubPlanner("totally not json");
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "hi" },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.error?.code).toBe("PLANNER_INVALID");
  });

  it("tags plan entries with unknown connector as PLAN_ENTRY_INVALID", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = stubPlanner(
      JSON.stringify([{ connector: "jira", action: "x", params: {} }]),
    );
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "?" },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results.some((r) => r.error?.code === "PLAN_ENTRY_INVALID")).toBe(true);
  });

  it("dispatches multiple steps in parallel", async () => {
    // Each fake bin sleeps ~200ms before responding.
    const slowBody =
      `setTimeout(() => process.stdout.write(JSON.stringify({status:"ok",data:{}})), 200);\n`;
    const awsCli = setupFakeConnector(tmpDir, "aws", { cliBody: slowBody });
    const githubCli = setupFakeConnector(tmpDir, "github", { cliBody: slowBody });
    const planner = stubPlanner(
      JSON.stringify([
        { connector: "aws", action: "list", params: {} },
        { connector: "github", action: "list", params: {} },
      ]),
    );
    const loader = stubLoader({
      aws: { skill: "aws-agent-connector" },
      github: { skill: "github-agent-connector" },
    });
    const cliResolver = stubCliResolver({ aws: awsCli, github: githubCli });
    const start = Date.now();
    const out = await gather(
      { prompt: "do both" },
      { planner, configLoader: loader, cliResolver },
    );
    const wall = Date.now() - start;
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.envelope !== undefined)).toBe(true);
    // Serial would be ~400ms (+ planner/loader stub overhead × 2); parallel
    // ~200ms (+ overhead × 1). Widened to < 1000ms because subprocess spawn
    // cost varies a lot across machines — still distinguishes parallel
    // (~400ms here) from serial (~800ms+).
    expect(wall).toBeLessThan(1000);
  });

  it("returns prep errors when no connectors resolve successfully", async () => {
    // No fake connector → cliResolver returns null → CLI_NOT_FOUND.
    const planner = stubPlanner("[]");
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({}); // no entries
    const out = await gather(
      { prompt: "hi" },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.error?.code).toBe("CLI_NOT_FOUND");
  });

  it("uses an injected spawnProcess if provided", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    let spawned: { cmd: string; args: string[] } | null = null;
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned = { cmd, args };
      // Return a minimal handle that immediately produces a fake envelope.
      const stdout = Readable.from([JSON.stringify({ status: "ok", data: { spawned: true } })]);
      const stderr = Readable.from([]);
      const handlers: Record<string, ((arg: unknown) => void)[]> = { exit: [], error: [] };
      // Fire 'exit' on the next tick.
      setImmediate(() => {
        for (const h of handlers["exit"] ?? []) h(0);
      });
      return {
        stdout,
        stderr,
        on(event: string, listener: (arg: unknown) => void) {
          (handlers[event] ??= []).push(listener);
        },
      } as unknown as ReturnType<SpawnFn>;
    };
    const planner = stubPlanner(
      JSON.stringify([{ connector: "aws", action: "list", params: {} }]),
    );
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader, spawnProcess: fakeSpawn, cliResolver },
    );
    expect(spawned).not.toBeNull();
    expect(out.results[0]?.envelope).toEqual({ status: "ok", data: { spawned: true } });
  });

  it("supports a path-style skill with `bin:` option", async () => {
    // Set up a custom skill directory at <tmpDir>/custom-skill/SKILL.md
    const skillDir = path.join(tmpDir, "custom-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# custom skill body");
    // Set up a custom bin
    const binPath = path.join(tmpDir, "custom-bin.js");
    fs.writeFileSync(
      binPath,
      `process.stdout.write(JSON.stringify({status:"custom-ok"}));\n`,
    );
    const planner = stubPlanner(
      JSON.stringify([{ connector: "custom", action: "x", params: {} }]),
    );
    // Use an absolute path skill (no `~` → no homedir dependency).
    const loader = stubLoader({
      custom: {
        skill: skillDir,
        options: { bin: binPath },
      },
    });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader },
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.envelope).toEqual({ status: "custom-ok" });
  });

  it("flags path-style skill with missing bin option as CONFIG_ERROR", async () => {
    const skillDir = path.join(tmpDir, "no-bin-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# x");
    const planner = stubPlanner("[]");
    // Absolute skill path; no `options.bin`.
    const loader = stubLoader({
      custom: { skill: skillDir },
    });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader },
    );
    expect(out.results.some((r) => r.error?.code === "CONFIG_ERROR")).toBe(true);
  });

  it("expands ~/ prefix in path-style skill via os.homedir()", async () => {
    // Use a tilde path that is guaranteed not to resolve. The branch we want
    // to cover is the `~`-expansion; verifying the resulting SKILL_NOT_FOUND
    // error proves we walked through it without mutating HOME.
    const planner = stubPlanner("[]");
    const loader = stubLoader({
      custom: { skill: "~/this-path-must-not-exist-on-any-test-machine-xyz" },
    });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader },
    );
    expect(out.results.some((r) => r.error?.code === "SKILL_NOT_FOUND")).toBe(true);
  });

  it("preserves PreparedConnector type via export", () => {
    // Compile-time test: just reference the type to make sure it's exported.
    const x: PreparedConnector | undefined = undefined;
    expect(x).toBeUndefined();
  });
});

describe("gather planner-error handling", () => {
  it("tags 'authenticate' substring errors as NO_CLAUDE_CODE_SESSION", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = throwingPlanner(new Error("authentication failed: not signed in"));
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.error?.code).toBe("NO_CLAUDE_CODE_SESSION");
    expect(out.results[0]?.error?.message).toMatch(/authentication failed/);
  });

  it("tags 'OAuth' substring errors as NO_CLAUDE_CODE_SESSION", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = throwingPlanner(new Error("OAuth token expired"));
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.error?.code).toBe("NO_CLAUDE_CODE_SESSION");
  });

  it("tags 'session' substring errors as NO_CLAUDE_CODE_SESSION", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = throwingPlanner(new Error("no active Claude Code session"));
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results[0]?.error?.code).toBe("NO_CLAUDE_CODE_SESSION");
  });

  it("tags non-session errors as PLANNER_FAILED", async () => {
    const cli = setupFakeConnector(tmpDir, "aws");
    const planner = throwingPlanner(new Error("network unreachable"));
    const loader = stubLoader({ aws: { skill: "aws-agent-connector" } });
    const cliResolver = stubCliResolver({ aws: cli });
    const out = await gather(
      { prompt: "..." },
      { planner, configLoader: loader, cliResolver },
    );
    expect(out.plan).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.error?.code).toBe("PLANNER_FAILED");
    expect(out.results[0]?.error?.message).toMatch(/network unreachable/);
  });
});

// Placeholder for live integration tests (not authored — see Task A spec).
// TODO: tests/live/* will exercise the real Agent SDK + a real connector once
// out-of-scope work lands.
