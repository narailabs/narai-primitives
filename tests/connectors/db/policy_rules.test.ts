/**
 * Tests for the PolicyRules-driven branch of Policy.checkQuery (V2.0 vocab).
 * The default-policy path is in `policy.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { Decision, Policy } from "../../../src/connectors/db/lib/policy.js";
import {
  DEFAULT_POLICY,
  mergePolicy,
  type PolicyRules,
} from "../../../src/connectors/db/lib/plugin_config.js";

function policy(rules: Partial<PolicyRules>, mode = "auto"): Policy {
  const merged = mergePolicy(DEFAULT_POLICY, rules);
  return new Policy(mode, merged);
}

describe("PolicyRules: WRITE overrides", () => {
  it("write: allow returns decision=allow on INSERT", () => {
    const result = policy({ write: "allow" }).checkQuery(
      "INSERT INTO users (name) VALUES ('x')",
    );
    expect(result.decision).toBe(Decision.ALLOW);
    expect(result.reason).toBe("WRITE allowed by policy");
  });

  it("write: escalate (default) asks for approval on UPDATE", () => {
    const result = policy({}).checkQuery(
      "UPDATE users SET name='y' WHERE id=1",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
    expect(result.reason).toContain("WRITE");
  });

  it("write: deny blocks INSERT with a clear reason", () => {
    const result = policy({ write: "deny" }).checkQuery(
      "INSERT INTO t (a) VALUES (1)",
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reason).toContain("WRITE");
  });

  it("write: present echoes formatted SQL", () => {
    const result = policy({ write: "present" }).checkQuery(
      "insert into t (a) values (1)",
    );
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    if (result.decision === "present_only") {
      expect(result.formatted_sql).toMatch(/^INSERT /);
    }
  });
});

describe("PolicyRules: DELETE overrides", () => {
  it("delete: present (default) echoes formatted SQL on DELETE", () => {
    const result = policy({}).checkQuery("delete from t where id = 1");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    if (result.decision === "present_only") {
      expect(result.formatted_sql).toMatch(/^DELETE /);
    }
  });

  // V2.0: TRUNCATE is now classified as DELETE (was DDL/admin).
  it("delete: present applies to TRUNCATE", () => {
    const result = policy({}).checkQuery("TRUNCATE TABLE t");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
  });

  it("delete: deny blocks DELETE with a clear reason", () => {
    const result = policy({ delete: "deny" }).checkQuery(
      "DELETE FROM t WHERE id=1",
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reason).toContain("DELETE");
  });

  it("delete: allow returns decision=allow on DELETE", () => {
    const result = policy({ delete: "allow" }).checkQuery(
      "DELETE FROM t WHERE id=1",
    );
    expect(result.decision).toBe(Decision.ALLOW);
  });
});

describe("PolicyRules: ADMIN overrides (safety floor permits escalate/present)", () => {
  it("admin: present (default) echoes formatted SQL on DROP", () => {
    const result = policy({}).checkQuery("DROP TABLE users");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    if (result.decision === "present_only") {
      expect(result.formatted_sql).toMatch(/^DROP /);
    }
  });

  it("admin: deny blocks CREATE with the legacy reason string", () => {
    const result = policy({ admin: "deny" }).checkQuery(
      "CREATE TABLE tmp (id INT)",
    );
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reason).toBe("ADMIN statements are never allowed");
  });

  it("admin: escalate asks for approval", () => {
    const result = policy({ admin: "escalate" }).checkQuery(
      "ALTER TABLE t ADD COLUMN x INT",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });
});

describe("PolicyRules: PRIVILEGE overrides", () => {
  it("privilege: deny (default) blocks GRANT with legacy reason", () => {
    const result = policy({}).checkQuery("GRANT SELECT ON t TO u");
    expect(result.decision).toBe(Decision.DENY);
    expect(result.reason).toBe("PRIVILEGE statements are never allowed");
  });

  it("privilege: escalate asks for approval on REVOKE", () => {
    const result = policy({ privilege: "escalate" }).checkQuery(
      "REVOKE ALL ON t FROM u",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });
});

describe("PolicyRules: READ overrides", () => {
  it("read: deny blocks SELECT even under auto approval", () => {
    const result = policy({ read: "deny" }).checkQuery(
      "SELECT id FROM users WHERE id = 1",
    );
    expect(result.decision).toBe(Decision.DENY);
  });

  it("read: escalate asks for approval on every SELECT", () => {
    const result = policy({ read: "escalate" }).checkQuery(
      "SELECT id FROM users WHERE id = 1",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("read: present echoes a formatted SELECT without executing", () => {
    const result = policy({ read: "present" }).checkQuery(
      "select id from users where id = 1",
    );
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    if (result.decision === "present_only") {
      expect(result.formatted_sql).toMatch(/^SELECT /);
    }
  });

  it("read: allow retains approval-mode semantics (confirm_each escalates)", () => {
    const result = policy({ read: "allow" }, "confirm_each").checkQuery(
      "SELECT id FROM users WHERE id = 1",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("read: allow retains unbounded-SELECT escalation", () => {
    const result = policy({ read: "allow" }).checkQuery(
      "SELECT * FROM users",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });
});

describe("PolicyRules: defaults preserve V2.0 behaviour", () => {
  it("no rules passed → DEFAULT_POLICY → matches V2.0 hard-coded flow", () => {
    const p = new Policy("auto");
    expect(p.checkQuery("DROP TABLE users").decision).toBe(Decision.PRESENT_ONLY);
    expect(
      p.checkQuery("GRANT SELECT ON t TO u").decision,
    ).toBe(Decision.DENY);
    expect(
      p.checkQuery("INSERT INTO t (a) VALUES (1)").decision,
    ).toBe(Decision.ESCALATE);
    expect(
      p.checkQuery("DELETE FROM t WHERE id=1").decision,
    ).toBe(Decision.PRESENT_ONLY);
    expect(
      p.checkQuery("SELECT id FROM users WHERE id = 1").decision,
    ).toBe(Decision.ALLOW);
  });
});
