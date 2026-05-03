import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveAgentCli } from "../../src/toolkit/agent_resolver.js";

let fakeHome: string;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tk-resolve-"));
});
afterEach(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

function touchPackageCli(dir: string): string {
  const cliPath = path.join(dir, "dist", "cli.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
  return cliPath;
}

describe("resolveAgentCli", () => {
  it("returns null when nothing exists anywhere", () => {
    const result = resolveAgentCli({
      name: "fake",
      homeOverride: fakeHome,
      envOverride: {},
      bundledSelfRoot: null,
    });
    expect(result).toBeNull();
  });

  it("env var path wins when present and existing", () => {
    const customCli = path.join(fakeHome, "custom", "cli.js");
    fs.mkdirSync(path.dirname(customCli), { recursive: true });
    fs.writeFileSync(customCli, "");
    const result = resolveAgentCli({
      name: "jira",
      homeOverride: fakeHome,
      envOverride: { JIRA_AGENT_CLI: customCli },
      bundledSelfRoot: null,
    });
    expect(result).not.toBeNull();
    expect(result?.source).toBe("env");
    expect(result?.command).toBe("node");
    expect(result?.args).toEqual([customCli]);
    expect(result?.resolvedPath).toBe(customCli);
  });

  it("env var name maps hyphens to underscores and uppercases", () => {
    // Sanity: a connector name like `db` produces DB_AGENT_CLI; `aws` → AWS_AGENT_CLI.
    const customCli = path.join(fakeHome, "x", "cli.js");
    fs.mkdirSync(path.dirname(customCli), { recursive: true });
    fs.writeFileSync(customCli, "");
    const result = resolveAgentCli({
      name: "db",
      homeOverride: fakeHome,
      envOverride: { DB_AGENT_CLI: customCli },
      bundledSelfRoot: null,
    });
    expect(result?.source).toBe("env");
  });

  it("ignores env var when the path doesn't exist", () => {
    const result = resolveAgentCli({
      name: "jira",
      homeOverride: fakeHome,
      envOverride: { JIRA_AGENT_CLI: path.join(fakeHome, "nope") },
      bundledSelfRoot: null,
    });
    expect(result).toBeNull();
  });

  it("plugin cache path wins when env var is absent", () => {
    const pluginDir = path.join(
      fakeHome,
      ".claude", "plugins", "cache",
      "jira-agent-plugin-1.2.3",
      "node_modules", "@narai", "jira-agent-connector",
    );
    const cliPath = touchPackageCli(pluginDir);
    const result = resolveAgentCli({
      name: "jira",
      homeOverride: fakeHome,
      envOverride: {},
      bundledSelfRoot: null,
    });
    expect(result?.source).toBe("plugin-cache");
    expect(result?.resolvedPath).toBe(cliPath);
  });

  it("CLAUDE_PLUGIN_DATA path is checked when plugin cache misses", () => {
    const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-data-"));
    try {
      const installDir = path.join(pluginData, "node_modules", "@narai", "jira-agent-connector");
      const cliPath = touchPackageCli(installDir);
      const result = resolveAgentCli({
        name: "jira",
        homeOverride: fakeHome,
        envOverride: { CLAUDE_PLUGIN_DATA: pluginData },
        bundledSelfRoot: null,
      });
      expect(result?.source).toBe("claude-plugin-data");
      expect(result?.resolvedPath).toBe(cliPath);
    } finally {
      fs.rmSync(pluginData, { recursive: true, force: true });
    }
  });

  it("dev fallback resolves at ~/src/connectors/<name>-agent-connector", () => {
    const devPkg = path.join(fakeHome, "src", "connectors", "jira-agent-connector");
    const cliPath = touchPackageCli(devPkg);
    const result = resolveAgentCli({
      name: "jira",
      homeOverride: fakeHome,
      envOverride: {},
      bundledSelfRoot: null,
    });
    expect(result?.source).toBe("dev-fallback");
    expect(result?.resolvedPath).toBe(cliPath);
  });

  it("custom devRoot is honored", () => {
    const customRoot = path.join(fakeHome, "elsewhere");
    const devPkg = path.join(customRoot, "jira-agent-connector");
    const cliPath = touchPackageCli(devPkg);
    const result = resolveAgentCli({
      name: "jira",
      homeOverride: fakeHome,
      envOverride: {},
      devRoot: customRoot,
      bundledSelfRoot: null,
    });
    expect(result?.resolvedPath).toBe(cliPath);
  });

  it("custom packageName / pluginNameContains / cliRelativePath compose", () => {
    const pluginDir = path.join(
      fakeHome,
      ".claude", "plugins", "cache",
      "myorg-thing-plugin-9",
      "node_modules", "@myorg", "thing",
    );
    const cliPath = path.join(pluginDir, "build", "main.js");
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, "");
    const result = resolveAgentCli({
      name: "thing",
      homeOverride: fakeHome,
      envOverride: {},
      pluginNameContains: "myorg-thing-plugin",
      packageName: "@myorg/thing",
      cliRelativePath: "build/main.js",
      bundledSelfRoot: null,
    });
    expect(result?.source).toBe("plugin-cache");
    expect(result?.resolvedPath).toBe(cliPath);
  });

  it("bundled-self resolves a CLI inside narai-primitives' own dist tree", () => {
    // Simulate the canonical 2.x bundled layout: narai-primitives' package
    // root contains dist/connectors/<name>/cli.js for every connector.
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "np-bundled-"));
    try {
      const cliPath = path.join(
        bundledRoot,
        "dist",
        "connectors",
        "github",
        "cli.js",
      );
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
      const result = resolveAgentCli({
        name: "github",
        homeOverride: fakeHome,
        envOverride: {},
        bundledSelfRoot: bundledRoot,
      });
      expect(result?.source).toBe("bundled-self");
      expect(result?.command).toBe("node");
      expect(result?.resolvedPath).toBe(cliPath);
    } finally {
      fs.rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

  it("bundled-self is preferred over plugin-cache when both exist", () => {
    // The bundled CLI ships with the package; plugin-cache is a legacy
    // fallback. When narai-primitives is installed normally, bundled-self
    // is the right answer.
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "np-bundled-"));
    try {
      const bundledCli = path.join(
        bundledRoot,
        "dist",
        "connectors",
        "jira",
        "cli.js",
      );
      fs.mkdirSync(path.dirname(bundledCli), { recursive: true });
      fs.writeFileSync(bundledCli, "");

      // Also set up a plugin-cache entry for the legacy package layout.
      const pluginDir = path.join(
        fakeHome,
        ".claude", "plugins", "cache",
        "jira-agent-plugin",
        "node_modules", "@narai", "jira-agent-connector",
      );
      touchPackageCli(pluginDir);

      const result = resolveAgentCli({
        name: "jira",
        homeOverride: fakeHome,
        envOverride: {},
        bundledSelfRoot: bundledRoot,
      });
      expect(result?.source).toBe("bundled-self");
      expect(result?.resolvedPath).toBe(bundledCli);
    } finally {
      fs.rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

  it("env-var override still wins over bundled-self", () => {
    // Operators must always be able to override with NAME_AGENT_CLI even
    // when narai-primitives' own bundled CLI is available.
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "np-bundled-"));
    try {
      const bundledCli = path.join(
        bundledRoot,
        "dist",
        "connectors",
        "jira",
        "cli.js",
      );
      fs.mkdirSync(path.dirname(bundledCli), { recursive: true });
      fs.writeFileSync(bundledCli, "");

      const customCli = path.join(fakeHome, "custom", "cli.js");
      fs.mkdirSync(path.dirname(customCli), { recursive: true });
      fs.writeFileSync(customCli, "");

      const result = resolveAgentCli({
        name: "jira",
        homeOverride: fakeHome,
        envOverride: { JIRA_AGENT_CLI: customCli },
        bundledSelfRoot: bundledRoot,
      });
      expect(result?.source).toBe("env");
      expect(result?.resolvedPath).toBe(customCli);
    } finally {
      fs.rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

  it("bundled-self gracefully degrades when the connector is not bundled", () => {
    // A name that has no built CLI under bundledSelfRoot should fall
    // through to the lower fallbacks instead of erroring.
    const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "np-bundled-empty-"));
    try {
      // Empty bundled root — no dist/connectors/<name>/cli.js inside.
      const pluginDir = path.join(
        fakeHome,
        ".claude", "plugins", "cache",
        "jira-agent-plugin",
        "node_modules", "@narai", "jira-agent-connector",
      );
      const pluginCli = touchPackageCli(pluginDir);
      const result = resolveAgentCli({
        name: "jira",
        homeOverride: fakeHome,
        envOverride: {},
        bundledSelfRoot: bundledRoot,
      });
      expect(result?.source).toBe("plugin-cache");
      expect(result?.resolvedPath).toBe(pluginCli);
    } finally {
      fs.rmSync(bundledRoot, { recursive: true, force: true });
    }
  });

  it("plugin cache is preferred over CLAUDE_PLUGIN_DATA when both exist", () => {
    const pluginDir = path.join(
      fakeHome,
      ".claude", "plugins", "cache",
      "jira-agent-plugin",
      "node_modules", "@narai", "jira-agent-connector",
    );
    const pluginCli = touchPackageCli(pluginDir);

    const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-data-"));
    try {
      const installDir = path.join(pluginData, "node_modules", "@narai", "jira-agent-connector");
      touchPackageCli(installDir);
      const result = resolveAgentCli({
        name: "jira",
        homeOverride: fakeHome,
        envOverride: { CLAUDE_PLUGIN_DATA: pluginData },
        bundledSelfRoot: null,
      });
      expect(result?.source).toBe("plugin-cache");
      expect(result?.resolvedPath).toBe(pluginCli);
    } finally {
      fs.rmSync(pluginData, { recursive: true, force: true });
    }
  });
});
