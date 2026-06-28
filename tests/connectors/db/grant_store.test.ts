/**
 * Tests for grant-store.ts and Policy grant persistence.
 *
 * Covers the cross-process persistence guarantee that the in-process Map
 * could not provide: a grant written by one Policy instance (simulating
 * CLI invocation A) is visible to a second Policy instance pointed at the
 * same file (invocation B), so a read is allowed without re-prompting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FileGrantStore,
  MemoryGrantStore,
  grantStorePathFor,
  shouldIssueReadGrant,
} from "../../../src/connectors/db/lib/grant-store.js";
import { Decision, Policy } from "../../../src/connectors/db/lib/policy.js";
import { DEFAULT_POLICY } from "../../../src/connectors/db/lib/plugin_config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-grant-store-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("FileGrantStore", () => {
  it("persists a value across two instances at the same path", () => {
    const p = path.join(tmpDir, "grants.json");
    const expiry = Date.now() + 60_000;
    const writer = new FileGrantStore(p);
    writer.set("read", expiry);

    // A second, independent instance (simulating a fresh process) reads it.
    const reader = new FileGrantStore(p);
    expect(reader.get("read")).toBe(expiry);
  });

  it("creates parent directories on demand", () => {
    const p = path.join(tmpDir, "nested", "deeper", "grants.json");
    const store = new FileGrantStore(p);
    store.set("read", Date.now() + 1000);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("treats a missing file as empty (no grant)", () => {
    const store = new FileGrantStore(path.join(tmpDir, "absent.json"));
    expect(store.get("read")).toBeUndefined();
  });

  it("treats a corrupt file as empty (no grant), without throwing", () => {
    const p = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(p, "{not valid json", "utf-8");
    const store = new FileGrantStore(p);
    expect(() => store.get("read")).not.toThrow();
    expect(store.get("read")).toBeUndefined();
  });

  it("does not leave temp files behind after an atomic write", () => {
    const p = path.join(tmpDir, "grants.json");
    const store = new FileGrantStore(p);
    store.set("read", Date.now() + 1000);
    store.set("read", Date.now() + 2000);
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("Policy with injected FileGrantStore", () => {
  it("sees a grant added by a separate Policy at the same path (cross-process)", () => {
    const p = path.join(tmpDir, "grants.json");

    // Process A: grant_required, issue a read grant, then exit.
    const policyA = new Policy(
      "grant_required",
      DEFAULT_POLICY,
      new FileGrantStore(p),
    );
    policyA.addGrant("read", 300);

    // Process B: fresh Policy, fresh FileGrantStore, same path. With the old
    // in-process Map (or performance.now()) this would deny; persistence +
    // wall-clock epoch make it allow.
    const policyB = new Policy(
      "grant_required",
      DEFAULT_POLICY,
      new FileGrantStore(p),
    );
    const result = policyB.checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("denies when the persisted grant is already expired", () => {
    const p = path.join(tmpDir, "grants.json");
    const store = new FileGrantStore(p);
    // Write an expiry firmly in the past.
    store.set("read", Date.now() - 60_000);

    const policy = new Policy("grant_required", DEFAULT_POLICY, store);
    const result = policy.checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.DENY);
  });

  it("denies when the backing file is corrupt (fail-safe)", () => {
    const p = path.join(tmpDir, "grants.json");
    fs.writeFileSync(p, "garbage", "utf-8");
    const policy = new Policy(
      "grant_required",
      DEFAULT_POLICY,
      new FileGrantStore(p),
    );
    expect(policy.checkQuery("SELECT 1").decision).toBe(Decision.DENY);
  });

  it("never lets a grant allow an ADMIN statement", () => {
    const p = path.join(tmpDir, "grants.json");
    const policyA = new Policy(
      "grant_required",
      DEFAULT_POLICY,
      new FileGrantStore(p),
    );
    // Even if someone tries to grant admin/privilege, the rule for admin is
    // 'present' and never reaches the grant gate.
    policyA.addGrant("read", 300);
    policyA.addGrant("admin", 300);
    policyA.addGrant("privilege", 300);

    const policyB = new Policy(
      "grant_required",
      DEFAULT_POLICY,
      new FileGrantStore(p),
    );
    expect(policyB.checkQuery("DROP TABLE users").decision).not.toBe(
      Decision.ALLOW,
    );
    expect(policyB.checkQuery("GRANT SELECT ON t TO u").decision).not.toBe(
      Decision.ALLOW,
    );
  });
});

describe("grantStorePathFor", () => {
  // Redirect ~/.config by overriding HOME so the path helpers resolve under a
  // throwaway home, isolated from the real one and from the legacy dir.
  let homeDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-grant-home-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("keys distinct servers to distinct files (no cross-target leakage)", () => {
    expect(grantStorePathFor("staging")).not.toBe(grantStorePathFor("prod"));
  });

  it("sanitizes unsafe server names so they cannot escape the grants dir", () => {
    const p = grantStorePathFor("../../etc/passwd");
    // The filename must contain no path separators or traversal segments, so
    // it stays inside the grants directory regardless of the input.
    const base = path.basename(p);
    expect(base).not.toContain(path.sep);
    expect(base).not.toContain("/");
    expect(
      path.dirname(p).endsWith(path.join("narai", "db", "grants")),
    ).toBe(true);
  });

  it("uses the neutral default dir when no legacy dir exists", () => {
    const p = grantStorePathFor("prod");
    expect(p.endsWith(path.join("narai", "db", "grants", "prod.json"))).toBe(
      true,
    );
  });

  it("falls back to the legacy dir when ~/.config/wiki_db exists", () => {
    fs.mkdirSync(path.join(homeDir, ".config", "wiki_db"), {
      recursive: true,
    });
    const p = grantStorePathFor("prod");
    expect(p.endsWith(path.join("wiki_db", "grants", "prod.json"))).toBe(true);
  });

  it("honors an explicit base dir override", () => {
    const p = grantStorePathFor("prod", "/custom/base");
    expect(p).toBe(path.join("/custom/base", "grants", "prod.json"));
  });
});

describe("shouldIssueReadGrant", () => {
  it("issues only under grant_required with explicit approval", () => {
    expect(shouldIssueReadGrant("grant_required", true)).toBe(true);
  });

  it("never issues without the explicit approval flag (gate preserved)", () => {
    expect(shouldIssueReadGrant("grant_required", false)).toBe(false);
  });

  it("never issues outside grant_required", () => {
    expect(shouldIssueReadGrant("auto", true)).toBe(false);
    expect(shouldIssueReadGrant("confirm_once", true)).toBe(false);
  });
});

describe("MemoryGrantStore (default) preserves single-process behavior", () => {
  it("holds a grant within one Policy instance", () => {
    const policy = new Policy("grant_required", DEFAULT_POLICY);
    expect(policy.checkQuery("SELECT 1").decision).toBe(Decision.DENY);
    policy.addGrant("read", 300);
    expect(policy.checkQuery("SELECT 1").decision).toBe(Decision.ALLOW);
  });

  it("does not share grants across two separate Policy instances", () => {
    const a = new Policy("grant_required", DEFAULT_POLICY, new MemoryGrantStore());
    a.addGrant("read", 300);
    const b = new Policy("grant_required", DEFAULT_POLICY, new MemoryGrantStore());
    // Distinct memory stores: B has no grant.
    expect(b.checkQuery("SELECT 1").decision).toBe(Decision.DENY);
  });
});
