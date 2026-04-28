/**
 * Tests for G-DB-AUDIT — non-query audit events.
 *
 * Verifies the four non-query events listed in v2 §4 are emitted by their
 * respective call sites: `pool_created` (connection.ts), `policy_deny`
 * (policy.ts), `grant_added` (policy.ts), and `grant_expired` (policy.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { disableAudit, enableAudit } from "../../../src/connectors/db/lib/audit.js";
import { Policy } from "../../../src/connectors/db/lib/policy.js";
import { getConnection, releaseConnection } from "../../../src/connectors/db/lib/connection.js";
import { registerEnvironment, clearEnvironments } from "../../../src/connectors/db/lib/environments.js";
import "../../../src/connectors/db/lib/drivers/register.js";
import { cleanupTmpPath, makeTmpPath } from "./fixtures.js";

interface AuditRecord {
  event_type: string;
  details?: { reason?: string; op?: string; grant_type?: string; ttl_seconds?: number; env?: string; driver?: string };
}

function readAudit(logPath: string): AuditRecord[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe("G-DB-AUDIT — non-query events", () => {
  let tmpPath: string;
  let logPath: string;

  beforeEach(() => {
    disableAudit();
    clearEnvironments();
    tmpPath = makeTmpPath("wiki-db-non-query-");
    logPath = path.join(tmpPath, "audit.jsonl");
  });
  afterEach(() => {
    disableAudit();
    clearEnvironments();
    cleanupTmpPath(tmpPath);
  });

  describe("policy_deny", () => {
    it("ADMIN deny emits policy_deny with op=admin (under explicit admin: deny rule)", () => {
      enableAudit(logPath);
      // V2.0 default for admin is "present", so override to deny here.
      const p = new Policy("auto", {
        read: "allow",
        write: "escalate",
        delete: "present",
        admin: "deny",
        privilege: "deny",
        unbounded_select: "escalate",
      });
      const result = p.checkQuery("DROP TABLE users");
      expect(result.decision).toBe("deny");
      const records = readAudit(logPath);
      const deny = records.find((r) => r.event_type === "policy_deny");
      expect(deny).toBeDefined();
      expect(deny?.details?.op).toBe("admin");
    });

    it("PRIVILEGE deny emits policy_deny with op=privilege", () => {
      enableAudit(logPath);
      const p = new Policy("auto");
      p.checkQuery("GRANT SELECT ON t TO u");
      const records = readAudit(logPath);
      const deny = records.find(
        (r) => r.event_type === "policy_deny" && r.details?.op === "privilege",
      );
      expect(deny).toBeDefined();
    });

    it("empty SQL deny emits policy_deny with no op", () => {
      enableAudit(logPath);
      const p = new Policy("auto");
      p.checkQuery("");
      const records = readAudit(logPath);
      const deny = records.find((r) => r.event_type === "policy_deny");
      expect(deny).toBeDefined();
      expect(deny?.details?.op).toBeUndefined();
    });

    it("audit disabled → no event written", () => {
      // (audit not enabled)
      const p = new Policy("auto");
      p.checkQuery("DROP TABLE users");
      expect(fs.existsSync(logPath)).toBe(false);
    });

    it("grant_required deny emits policy_deny", () => {
      enableAudit(logPath);
      const p = new Policy("grant_required");
      // No grant active → READ is denied
      p.checkQuery("SELECT 1");
      const records = readAudit(logPath);
      const deny = records.find((r) => r.event_type === "policy_deny");
      expect(deny).toBeDefined();
      expect(deny?.details?.reason).toMatch(/grant/i);
    });

    // V2.0: under DEFAULT_POLICY (admin: present), a compound mixing
    // SELECT + ADMIN no longer denies. Switch to admin: deny to keep the
    // shape of the test.
    it("compound statement with an ADMIN part emits policy_deny tagged op=admin (admin: deny)", () => {
      enableAudit(logPath);
      const p = new Policy("auto", {
        read: "allow",
        write: "escalate",
        delete: "present",
        admin: "deny",
        privilege: "deny",
        unbounded_select: "escalate",
      });
      p.checkQuery("SELECT 1; DROP TABLE users;");
      const records = readAudit(logPath);
      const deny = records.find((r) => r.event_type === "policy_deny");
      expect(deny).toBeDefined();
      expect(deny?.details?.op).toBe("admin");
      expect(deny?.details?.reason?.toLowerCase()).toMatch(/admin|never allowed/);
    });

    it("compound with a privilege part emits policy_deny tagged op=privilege", () => {
      enableAudit(logPath);
      const p = new Policy("auto");
      p.checkQuery("SELECT 1; GRANT SELECT ON t TO u");
      const records = readAudit(logPath);
      const deny = records.find((r) => r.event_type === "policy_deny");
      expect(deny).toBeDefined();
      expect(deny?.details?.op).toBe("privilege");
    });
  });

  describe("policy_escalate", () => {
    it("WRITE escalate emits policy_escalate with op=write", () => {
      enableAudit(logPath);
      const p = new Policy("auto", {
        read: "allow",
        write: "escalate",
        delete: "present",
        admin: "present",
        privilege: "deny",
        unbounded_select: "escalate",
      });
      const r = p.checkQuery("INSERT INTO users (name) VALUES ('x')");
      expect(r.decision).toBe("escalate");
      const records = readAudit(logPath);
      const esc = records.find((r) => r.event_type === "policy_escalate");
      expect(esc).toBeDefined();
      expect(esc?.details?.op).toBe("write");
    });

    it("unbounded SELECT under auto mode emits policy_escalate with op=read", () => {
      enableAudit(logPath);
      const p = new Policy("auto");
      const r = p.checkQuery("SELECT * FROM users");
      expect(r.decision).toBe("escalate");
      const records = readAudit(logPath);
      const esc = records.find((r) => r.event_type === "policy_escalate");
      expect(esc).toBeDefined();
      expect(esc?.details?.op).toBe("read");
      expect(esc?.details?.reason?.toLowerCase()).toContain("unbounded");
    });

    it("confirm_each mode emits policy_escalate for every read", () => {
      enableAudit(logPath);
      const p = new Policy("confirm_each");
      p.checkQuery("SELECT id FROM users WHERE id = 1");
      const records = readAudit(logPath);
      const esc = records.find((r) => r.event_type === "policy_escalate");
      expect(esc).toBeDefined();
      expect(esc?.details?.op).toBe("read");
    });

    it("audit disabled → no escalate event", () => {
      // (audit not enabled)
      const p = new Policy("auto", {
        read: "allow",
        write: "escalate",
        delete: "present",
        admin: "present",
        privilege: "deny",
        unbounded_select: "escalate",
      });
      p.checkQuery("INSERT INTO users (name) VALUES ('x')");
      expect(fs.existsSync(logPath)).toBe(false);
    });
  });

  describe("grant_added", () => {
    it("addGrant emits grant_added with type and TTL", () => {
      enableAudit(logPath);
      const p = new Policy("grant_required");
      p.addGrant("read", 7200);
      const records = readAudit(logPath);
      const added = records.find((r) => r.event_type === "grant_added");
      expect(added).toBeDefined();
      expect(added?.details?.grant_type).toBe("read");
      expect(added?.details?.ttl_seconds).toBe(7200);
    });
  });

  describe("grant_expired", () => {
    it("emitted exactly once on first expired check, then suppressed", () => {
      enableAudit(logPath);
      const p = new Policy("grant_required");
      p.addGrant("read", 0); // immediately expired
      // Three checks → exactly one grant_expired event
      p.isGrantActive("read");
      p.isGrantActive("read");
      p.isGrantActive("read");
      const records = readAudit(logPath);
      const expiredEvents = records.filter(
        (r) => r.event_type === "grant_expired",
      );
      expect(expiredEvents.length).toBe(1);
      expect(expiredEvents[0]?.details?.grant_type).toBe("read");
    });

    it("not emitted for never-granted types", () => {
      enableAudit(logPath);
      const p = new Policy("grant_required");
      p.isGrantActive("never_added");
      const records = readAudit(logPath);
      expect(
        records.filter((r) => r.event_type === "grant_expired").length,
      ).toBe(0);
    });
  });

  describe("pool_created", () => {
    it("emitted on first getConnection per env", async () => {
      enableAudit(logPath);
      registerEnvironment("test_pool", {
        host: "",
        port: 0,
        database: ":memory:",
        schema: "",
        approval_mode: "auto",
        driver: "sqlite",
      });
      const conn = await getConnection("test_pool");
      try {
        const records = readAudit(logPath);
        const created = records.filter(
          (r) => r.event_type === "pool_created" && r.details?.env === "test_pool",
        );
        expect(created.length).toBe(1);
        expect(created[0]?.details?.driver).toBe("sqlite");
      } finally {
        releaseConnection("test_pool", conn);
      }
    });

    it("not emitted on second getConnection for same env", async () => {
      enableAudit(logPath);
      registerEnvironment("test_pool2", {
        host: "",
        port: 0,
        database: ":memory:",
        schema: "",
        approval_mode: "auto",
        driver: "sqlite",
      });
      const c1 = await getConnection("test_pool2");
      const c2 = await getConnection("test_pool2");
      try {
        const records = readAudit(logPath);
        const created = records.filter(
          (r) => r.event_type === "pool_created" && r.details?.env === "test_pool2",
        );
        expect(created.length).toBe(1);
      } finally {
        releaseConnection("test_pool2", c1);
        releaseConnection("test_pool2", c2);
      }
    });
  });

  // A5: connection_released emitted by releaseConnection so the audit
  // trail closes cleanly after every checkout.
  describe("connection_released (A5)", () => {
    it("emitted once per release on a real pool", async () => {
      enableAudit(logPath);
      registerEnvironment("test_release", {
        host: "",
        port: 0,
        database: ":memory:",
        schema: "",
        approval_mode: "auto",
        driver: "sqlite",
      });
      const conn = await getConnection("test_release");
      releaseConnection("test_release", conn);
      const records = readAudit(logPath);
      const released = records.filter(
        (r) =>
          r.event_type === "connection_released" &&
          r.details?.env === "test_release",
      );
      expect(released.length).toBe(1);
    });

    it("audit shape for a checkout-then-release is [pool_created, connection_released]", async () => {
      enableAudit(logPath);
      registerEnvironment("test_lifecycle", {
        host: "",
        port: 0,
        database: ":memory:",
        schema: "",
        approval_mode: "auto",
        driver: "sqlite",
      });
      const conn = await getConnection("test_lifecycle");
      releaseConnection("test_lifecycle", conn);
      const events = readAudit(logPath)
        .filter((r) => r.details?.env === "test_lifecycle")
        .map((r) => r.event_type);
      expect(events).toEqual(["pool_created", "connection_released"]);
    });

    it("not emitted for an unknown env (releaseConnection no-ops)", () => {
      enableAudit(logPath);
      releaseConnection("never_registered", {
        envName: "never_registered",
        native: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        driver: {} as any,
      });
      const records = readAudit(logPath);
      const released = records.filter(
        (r) => r.event_type === "connection_released",
      );
      expect(released.length).toBe(0);
    });
  });
});
