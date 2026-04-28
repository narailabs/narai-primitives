import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  hashScopeKey,
  resolveTierPaths,
} from "../../src/toolkit/hardship/scope.js";

describe("hashScopeKey", () => {
  it("is deterministic", () => {
    const a = hashScopeKey("https://acme.atlassian.net");
    const b = hashScopeKey("https://acme.atlassian.net");
    expect(a).toBe(b);
  });
  it("returns 16-char hex", () => {
    const h = hashScopeKey("anything");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it("differs between keys", () => {
    expect(hashScopeKey("a")).not.toBe(hashScopeKey("b"));
  });
});

describe("resolveTierPaths", () => {
  const cwd = "/tmp/fakeproj";
  const home = "/tmp/fakehome";

  it("returns 4 tiers in most→least specific order", () => {
    const tiers = resolveTierPaths({
      connector: "jira",
      scope: "acme.atlassian.net",
      cwd,
      home,
    });
    expect(tiers.map((t) => t.name)).toEqual([
      "project-tenant",
      "project-global",
      "user-tenant",
      "user-global",
    ]);
    const hash = hashScopeKey("acme.atlassian.net");
    expect(tiers[0]?.dir).toBe(
      path.join(cwd, ".claude/connectors/jira/tenants", hash),
    );
    expect(tiers[1]?.dir).toBe(
      path.join(cwd, ".claude/connectors/jira/global"),
    );
    expect(tiers[2]?.dir).toBe(
      path.join(home, ".claude/connectors/jira/tenants", hash),
    );
    expect(tiers[3]?.dir).toBe(
      path.join(home, ".claude/connectors/jira/global"),
    );
  });

  it("with null scope drops tenant tiers (returns 2)", () => {
    const tiers = resolveTierPaths({
      connector: "jira",
      scope: null,
      cwd,
      home,
    });
    expect(tiers.map((t) => t.name)).toEqual([
      "project-global",
      "user-global",
    ]);
  });
});
