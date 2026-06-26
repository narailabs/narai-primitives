/**
 * FIX 2: confirm_once must persist across short-lived CLI invocations.
 *
 * Approval under confirm_once issues a short-TTL "session" grant in the
 * shared file store; a fresh Policy in a later process honors it (no
 * re-escalation) until it expires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FileGrantStore,
  shouldIssueReadGrant,
  shouldIssueSessionGrant,
} from "../../../src/connectors/db/lib/grant-store.js";
import { Policy } from "../../../src/connectors/db/lib/policy.js";
import { DEFAULT_POLICY } from "../../../src/connectors/db/lib/plugin_config.js";

describe("confirm_once persistence (FIX 2)", () => {
  let dir: string;
  let storePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-once-"));
    storePath = path.join(dir, "grants.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a fresh process is allowed after an earlier process approved", () => {
    // Process A approves: issue a session grant into the shared store.
    const a = new Policy("confirm_once", DEFAULT_POLICY, new FileGrantStore(storePath));
    a.addGrant("session", 300);

    // Process B: brand-new Policy + new store at the same path.
    const b = new Policy("confirm_once", DEFAULT_POLICY, new FileGrantStore(storePath));
    expect(b.checkQuery("SELECT 1").decision).toBe("allow");
  });

  it("escalates when no prior approval exists (default unchanged)", () => {
    const p = new Policy("confirm_once", DEFAULT_POLICY, new FileGrantStore(storePath));
    expect(p.checkQuery("SELECT 1").decision).toBe("escalate");
  });

  it("escalates again after the session grant has expired", () => {
    // Write an already-expired session grant directly.
    fs.writeFileSync(storePath, JSON.stringify({ session: Date.now() - 1000 }));
    const p = new Policy("confirm_once", DEFAULT_POLICY, new FileGrantStore(storePath));
    expect(p.checkQuery("SELECT 1").decision).toBe("escalate");
  });

  it("shouldIssueSessionGrant only fires for confirm_once + approval", () => {
    expect(shouldIssueSessionGrant("confirm_once", true)).toBe(true);
    expect(shouldIssueSessionGrant("confirm_once", false)).toBe(false);
    expect(shouldIssueSessionGrant("grant_required", true)).toBe(false);
    expect(shouldIssueSessionGrant("auto", true)).toBe(false);
    // And the read-grant helper is unaffected.
    expect(shouldIssueReadGrant("confirm_once", true)).toBe(false);
  });
});
