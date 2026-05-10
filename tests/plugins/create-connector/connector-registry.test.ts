import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerConnector } from "../../../plugins/create-connector/skills/create-connector/lib/connector-registry.mjs";

describe("connector-registry", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
    fs.mkdirSync(path.join(scope, ".connectors"), { recursive: true });
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("creates config.yaml when missing", () => {
    registerConnector(scope, "stripe", {
      skill: "/abs/path/to/stripe",
      bin: "/abs/path/to/stripe/bin/stripe",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toContain("stripe:");
    expect(cfg).toContain("/abs/path/to/stripe");
  });

  it("appends to existing config.yaml without duplicating", () => {
    fs.writeFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "connectors:\n  existing:\n    skill: /old\n    enabled: true\n",
    );
    registerConnector(scope, "stripe", {
      skill: "/new/path",
      bin: "/new/bin",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toContain("existing:");
    expect(cfg).toContain("stripe:");
    expect(cfg).toContain("/new/path");
  });

  it("is idempotent — running twice does not duplicate the entry", () => {
    registerConnector(scope, "stripe", {
      skill: "/abs/path",
      bin: "/abs/bin",
    });
    registerConnector(scope, "stripe", {
      skill: "/abs/path",
      bin: "/abs/bin",
    });
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    const matches = cfg.match(/^\s+stripe:/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});
