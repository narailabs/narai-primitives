import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  deepMerge,
  loadFile,
  loadBaseConfig,
  loadResolvedConfig,
  userConfigPath,
  repoConfigPath,
} from "../../src/config/load.js";

describe("path helpers", () => {
  it("userConfigPath points at ~/.connectors/config.yaml", () => {
    expect(userConfigPath()).toBe(path.join(os.homedir(), ".connectors", "config.yaml"));
  });

  it("repoConfigPath joins under cwd", () => {
    expect(repoConfigPath("/tmp/proj")).toBe("/tmp/proj/.connectors/config.yaml");
  });
});

describe("loadFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-load-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns {} when the file does not exist", () => {
    expect(loadFile(path.join(tmp, "missing.yaml"))).toEqual({});
  });

  it("parses a valid mapping", () => {
    const p = path.join(tmp, "ok.yaml");
    fs.writeFileSync(p, "model: claude-opus-4-7\nenforce_hooks: true\n");
    expect(loadFile(p)).toEqual({ model: "claude-opus-4-7", enforce_hooks: true });
  });

  it("returns {} for an empty file", () => {
    const p = path.join(tmp, "empty.yaml");
    fs.writeFileSync(p, "");
    expect(loadFile(p)).toEqual({});
  });

  it("throws on malformed YAML", () => {
    const p = path.join(tmp, "bad.yaml");
    fs.writeFileSync(p, "model: [unclosed\n");
    expect(() => loadFile(p)).toThrow(/Failed to parse YAML/);
  });

  it("throws when the top-level value is an array", () => {
    const p = path.join(tmp, "arr.yaml");
    fs.writeFileSync(p, "- one\n- two\n");
    expect(() => loadFile(p)).toThrow(/Expected YAML mapping/);
  });
});

describe("deepMerge", () => {
  it("merges scalar overlay over scalar base", () => {
    expect(deepMerge("a", "b")).toBe("b");
    expect(deepMerge(1, 2)).toBe(2);
  });

  it("returns base unchanged when overlay is undefined", () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("returns overlay when base is undefined", () => {
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it("recursively merges plain objects", () => {
    const base = { a: 1, nested: { b: 2, c: 3 } };
    const overlay = { nested: { c: 99, d: 4 } };
    expect(deepMerge(base, overlay)).toEqual({
      a: 1,
      nested: { b: 2, c: 99, d: 4 },
    });
  });

  it("replaces arrays wholesale (does not concatenate)", () => {
    expect(deepMerge([1, 2, 3], [4, 5])).toEqual([4, 5]);
  });

  it("scalar overlay wins over object base", () => {
    expect(deepMerge({ a: 1 }, "scalar")).toBe("scalar");
  });
});

describe("loadBaseConfig", () => {
  let tmpHome: string;
  let tmpCwd: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cwd-"));
    process.env["HOME"] = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("returns {} when both files are missing", () => {
    expect(loadBaseConfig(tmpCwd)).toEqual({});
  });

  it("returns user config when only user file is present", () => {
    fs.mkdirSync(path.join(tmpHome, ".connectors"));
    fs.writeFileSync(path.join(tmpHome, ".connectors", "config.yaml"), "model: a\n");
    expect(loadBaseConfig(tmpCwd)).toEqual({ model: "a" });
  });

  it("returns repo config when only repo file is present", () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(path.join(tmpCwd, ".connectors", "config.yaml"), "model: b\n");
    expect(loadBaseConfig(tmpCwd)).toEqual({ model: "b" });
  });

  it("repo wins on conflict; non-conflicting keys merge", () => {
    fs.mkdirSync(path.join(tmpHome, ".connectors"));
    fs.writeFileSync(
      path.join(tmpHome, ".connectors", "config.yaml"),
      "model: user-model\nenforce_hooks: false\n",
    );
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      "model: repo-model\n",
    );
    expect(loadBaseConfig(tmpCwd)).toEqual({
      model: "repo-model",
      enforce_hooks: false,
    });
  });
});

describe("loadResolvedConfig (integration)", () => {
  let tmpHome: string;
  let tmpCwd: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cwd-"));
    process.env["HOME"] = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("loads + resolves an end-to-end config", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `model: claude-opus-4-7
enforce_hooks: true
connectors:
  jira:
    skill: jira-agent-connector
    atlassian-api-key: env:ATLASSIAN_KEY
`,
    );
    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    expect(resolved.model).toBe("claude-opus-4-7");
    expect(resolved.connectors["jira"]?.skill).toBe("jira-agent-connector");
    expect(resolved.connectors["jira"]?.options["atlassian-api-key"]).toBe("env:ATLASSIAN_KEY");
  });

  it("propagates env.NAME validation errors", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `connectors:
  jira:
    skill: jira-agent-connector
    atlassian-api-key: env.WRONG
`,
    );
    await expect(loadResolvedConfig({ cwd: tmpCwd })).rejects.toThrow(/env:NAME/);
  });
});

describe("NARAI_ENV", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origCwd: string;
  let origNaraiEnv: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narai-env-"));
    origHome = process.env["HOME"];
    origCwd = process.cwd();
    origNaraiEnv = process.env["NARAI_ENV"];
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".connectors"), { recursive: true });
    process.env["HOME"] = home;
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    if (origNaraiEnv === undefined) delete process.env["NARAI_ENV"];
    else process.env["NARAI_ENV"] = origNaraiEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeUserConfig(body: string): void {
    fs.writeFileSync(path.join(process.env["HOME"]!, ".connectors", "config.yaml"), body);
  }

  it("applies NARAI_ENV when opts.environment is not set", async () => {
    writeUserConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    servers:",
      "      orders: { driver: sqlite, database: base.db }",
      "environments:",
      "  prod:",
      "    connectors:",
      "      db:",
      "        servers:",
      "          orders: { driver: sqlite, database: prod.db }",
      "",
    ].join("\n"));
    process.env["NARAI_ENV"] = "prod";
    const resolved = await loadResolvedConfig();
    expect(resolved.environment).toBe("prod");
    expect((resolved.connectors["db"]!.options["servers"] as Record<string, { database: string }>).orders.database).toBe("prod.db");
  });

  it("opts.environment wins over NARAI_ENV", async () => {
    writeUserConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    servers:",
      "      orders: { driver: sqlite, database: base.db }",
      "environments:",
      "  prod: { connectors: { db: { servers: { orders: { driver: sqlite, database: prod.db } } } } }",
      "  staging: { connectors: { db: { servers: { orders: { driver: sqlite, database: staging.db } } } } }",
      "",
    ].join("\n"));
    process.env["NARAI_ENV"] = "prod";
    const resolved = await loadResolvedConfig({ environment: "staging" });
    expect(resolved.environment).toBe("staging");
  });

  it("treats NARAI_ENV='' (empty string) as unset", async () => {
    writeUserConfig([
      "connectors:",
      "  db: { skill: db-agent-connector, servers: { orders: { driver: sqlite, database: base.db } } }",
      "environments:",
      "  default: prod",
      "  prod: { connectors: { db: { servers: { orders: { driver: sqlite, database: prod.db } } } } }",
      "",
    ].join("\n"));
    process.env["NARAI_ENV"] = "";
    const resolved = await loadResolvedConfig();
    // Falls back to environments.default, which is "prod"
    expect(resolved.environment).toBe("prod");
  });

  it("errors when NARAI_ENV names an unknown environment", async () => {
    writeUserConfig([
      "connectors:",
      "  db: { skill: db-agent-connector, servers: { orders: { driver: sqlite, database: base.db } } }",
      "environments:",
      "  prod: { connectors: { db: {} } }",
      "",
    ].join("\n"));
    process.env["NARAI_ENV"] = "ghost";
    await expect(loadResolvedConfig()).rejects.toThrow(/Environment 'ghost' not found/);
  });
});
