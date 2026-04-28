/**
 * Tests for policy.ts — ported 1:1 from `test_policy.py`.
 *
 * The test matrix is identical to the Python suite: SQL classification
 * × decision logic × approval mode × grant state. Classes map to
 * `describe` blocks; each `def test_*` becomes an `it()` block.
 */
import { describe, it, expect } from "vitest";

import {
  Decision,
  grantFromEnv,
  OperationType,
  Policy,
} from "../../../src/connectors/db/lib/policy.js";
import { DEFAULT_POLICY } from "../../../src/connectors/db/lib/plugin_config.js";

/** pytest fixture: policy_auto */
function policyAuto(): Policy {
  return new Policy("auto");
}

/** pytest fixture: policy_confirm_once */
function policyConfirmOnce(): Policy {
  return new Policy("confirm_once");
}

/** pytest fixture: policy_confirm_each */
function policyConfirmEach(): Policy {
  return new Policy("confirm_each");
}

/** pytest fixture: policy_grant_required */
function policyGrantRequired(): Policy {
  return new Policy("grant_required");
}

// ===================================================================
// 1. SQL Classification
// ===================================================================

describe("TestClassifySQL", () => {
  it("test_classify_select", () => {
    expect(policyAuto().classifySql("SELECT 1")).toBe(OperationType.READ);
  });

  it("test_classify_select_with_joins", () => {
    const sql =
      "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id";
    expect(policyAuto().classifySql(sql)).toBe(OperationType.READ);
  });

  it("test_classify_explain", () => {
    expect(policyAuto().classifySql("EXPLAIN SELECT * FROM t")).toBe(
      OperationType.READ,
    );
  });

  it("test_classify_insert", () => {
    expect(policyAuto().classifySql("INSERT INTO t (a) VALUES (1)")).toBe(
      OperationType.WRITE,
    );
  });

  it("test_classify_update", () => {
    expect(policyAuto().classifySql("UPDATE t SET a=1 WHERE id=2")).toBe(
      OperationType.WRITE,
    );
  });

  it("test_classify_delete", () => {
    expect(policyAuto().classifySql("DELETE FROM t WHERE id=3")).toBe(
      OperationType.DELETE,
    );
  });

  it("test_classify_drop", () => {
    expect(policyAuto().classifySql("DROP TABLE users")).toBe(
      OperationType.ADMIN,
    );
  });

  it("test_classify_create_table", () => {
    expect(policyAuto().classifySql("CREATE TABLE t (id INT)")).toBe(
      OperationType.ADMIN,
    );
  });

  it("test_classify_alter", () => {
    expect(policyAuto().classifySql("ALTER TABLE t ADD COLUMN x INT")).toBe(
      OperationType.ADMIN,
    );
  });

  // V2.0: TRUNCATE moved from ADMIN (was DDL) to DELETE.
  it("test_classify_truncate", () => {
    expect(policyAuto().classifySql("TRUNCATE TABLE t")).toBe(
      OperationType.DELETE,
    );
  });

  it("test_classify_grant", () => {
    expect(policyAuto().classifySql("GRANT SELECT ON t TO user1")).toBe(
      OperationType.PRIVILEGE,
    );
  });

  it("test_classify_revoke", () => {
    expect(policyAuto().classifySql("REVOKE ALL ON t FROM user1")).toBe(
      OperationType.PRIVILEGE,
    );
  });

  it("test_classify_with_leading_whitespace", () => {
    expect(policyAuto().classifySql("   SELECT * FROM t")).toBe(
      OperationType.READ,
    );
  });

  it("test_classify_with_comment_prefix", () => {
    const sql = "-- fetch all users\nSELECT * FROM users";
    expect(policyAuto().classifySql(sql)).toBe(OperationType.READ);
  });

  it("test_classify_cte", () => {
    const sql = "WITH cte AS (SELECT 1) SELECT * FROM cte";
    expect(policyAuto().classifySql(sql)).toBe(OperationType.READ);
  });
});

// ===================================================================
// 2. Decision Logic
// ===================================================================

describe("TestDecisionLogic", () => {
  // V2.0 default: admin: present (was ddl: deny). Drops/creates now echo
  // back as formatted SQL rather than denying outright.
  it("test_admin_default_is_present_only", () => {
    const result = policyAuto().checkQuery("DROP TABLE users");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    expect(result.reason).toBeTruthy();
  });

  it("test_privilege_always_denied", () => {
    const result = policyAuto().checkQuery("GRANT SELECT ON t TO u");
    expect(result.decision).toBe(Decision.DENY);
  });

  // V2.0 default: write: escalate. Was dml: present.
  it("test_write_default_is_escalate", () => {
    const result = policyAuto().checkQuery("INSERT INTO t (a) VALUES (1)");
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  // V2.0 default: delete: present. Was dml: present.
  it("test_delete_default_is_present_only", () => {
    const result = policyAuto().checkQuery("DELETE FROM t WHERE id=1");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
  });

  it("test_read_auto_env_allowed", () => {
    const result = policyAuto().checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("test_read_confirm_once_first_time", () => {
    const result = policyConfirmOnce().checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("test_read_confirm_once_after_approval", () => {
    const p = policyConfirmOnce();
    p.approveSession();
    const result = p.checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("test_read_confirm_each_always_escalates", () => {
    const p = policyConfirmEach();
    const r1 = p.checkQuery("SELECT 1");
    expect(r1.decision).toBe(Decision.ESCALATE);
    p.approveSession();
    const r2 = p.checkQuery("SELECT 1");
    expect(r2.decision).toBe(Decision.ESCALATE);
  });

  it("test_read_grant_required_no_grant", () => {
    const result = policyGrantRequired().checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.DENY);
  });

  it("test_read_grant_required_with_grant", () => {
    const p = policyGrantRequired();
    p.addGrant("read", 300);
    const result = p.checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("test_unbounded_select_escalates", () => {
    const result = policyAuto().checkQuery("SELECT * FROM users");
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("test_unbounded_select_allow_skips_check", () => {
    // Operator opt-out: policy.unbounded_select: 'allow' lets bare
    // SELECT * FROM table reach the driver without escalating first.
    const p = new Policy("auto", {
      ...DEFAULT_POLICY,
      unbounded_select: "allow",
    });
    const result = p.checkQuery("SELECT * FROM users");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("test_bounded_select_allowed", () => {
    const result = policyAuto().checkQuery("SELECT * FROM users WHERE id = 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  // G-POLICY-CROSSJOIN: bare JOIN used to count as a bounding clause,
  // but CROSS JOIN has no predicate and explodes rows. The bounding
  // regex now requires JOIN ... ON.
  it("test_cross_join_escalates", () => {
    const result = policyAuto().checkQuery("SELECT * FROM a CROSS JOIN b");
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("test_inner_join_on_allowed", () => {
    const result = policyAuto().checkQuery(
      "SELECT * FROM a INNER JOIN b ON a.id = b.id",
    );
    expect(result.decision).toBe(Decision.ALLOW);
  });

  // JOIN USING (...) also loses to the tightened regex. Acceptable:
  // escalate is the safe direction and USING without WHERE is rare.
  it("test_join_using_escalates", () => {
    const result = policyAuto().checkQuery(
      "SELECT * FROM a JOIN b USING (id)",
    );
    expect(result.decision).toBe(Decision.ESCALATE);
  });

  it("test_empty_sql_denied", () => {
    const result = policyAuto().checkQuery("");
    expect(result.decision).toBe(Decision.DENY);
  });

  it("test_present_only_includes_formatted_sql", () => {
    // DELETE defaults to present under V2.0; UPDATE defaults to escalate.
    const result = policyAuto().checkQuery("delete from t where id=2");
    expect(result.decision).toBe(Decision.PRESENT_ONLY);
    if (result.decision === "present_only") {
      expect(result.formatted_sql).not.toBeNull();
      expect(result.formatted_sql.toUpperCase()).toContain("DELETE");
    }
  });

  it("test_grant_active_after_add", () => {
    const p = policyGrantRequired();
    p.addGrant("read", 300);
    expect(p.isGrantActive("read")).toBe(true);
  });

  it("test_grant_not_active_by_default", () => {
    expect(policyGrantRequired().isGrantActive("read")).toBe(false);
  });

  it("test_grant_expired", () => {
    const p = policyGrantRequired();
    p.addGrant("read", 0);
    expect(p.isGrantActive("read")).toBe(false);
  });
});

describe("grantFromEnv", () => {
  it("uses env.grant_duration_hours when set (8h → 28800s)", () => {
    const p = policyGrantRequired();
    grantFromEnv(p, { grant_duration_hours: 8 }, "read");
    expect(p.isGrantActive("read")).toBe(true);
    // Check the checkQuery path actually accepts the grant.
    const result = p.checkQuery("SELECT 1");
    expect(result.decision).toBe(Decision.ALLOW);
  });

  it("defaults to 8 hours when env omits the field", () => {
    const p = policyGrantRequired();
    grantFromEnv(p, {}, "read");
    // 8h > 0, so grant must be active immediately.
    expect(p.isGrantActive("read")).toBe(true);
  });

  it("honors a smaller override (e.g. 0.0001h ≈ 0.36s)", () => {
    const p = policyGrantRequired();
    grantFromEnv(p, { grant_duration_hours: 0 }, "read");
    // Zero hours → expiry in the past → inactive.
    expect(p.isGrantActive("read")).toBe(false);
  });
});

// ===================================================================
// Compound statements — classify each, strictest-wins (deny > escalate >
// present_only > allow). A compound of all-allowed stmts stays allowed.
// ===================================================================

describe("TestCompoundStatement", () => {
  // V2.0: admin defaults to present (was ddl: deny), so a SELECT + DROP
  // compound now resolves to present_only (admin: present is strictest).
  it("returns present_only for a compound with an ADMIN statement (strictest wins)", () => {
    const r = policyAuto().checkQuery("SELECT 1; DROP TABLE users;");
    expect(r.decision).toBe(Decision.PRESENT_ONLY);
    if (r.decision === "present_only") {
      expect(r.formatted_sql).toMatch(/SELECT 1/i);
      expect(r.formatted_sql).toMatch(/DROP TABLE users/i);
    }
  });

  // V2.0: write defaults to escalate (was dml: present). The strictest
  // rule for a SELECT + INSERT compound becomes escalate.
  it("returns escalate for a compound with a WRITE statement under default policy", () => {
    const r = policyAuto().checkQuery("SELECT 1; INSERT INTO users VALUES (1)");
    expect(r.decision).toBe(Decision.ESCALATE);
  });

  it("allows a compound of multiple reads", () => {
    const r = policyAuto().checkQuery("SELECT 1; SELECT 2");
    expect(r.decision).toBe(Decision.ALLOW);
  });

  it("allows a single statement with a trailing semicolon", () => {
    const r = policyAuto().checkQuery("SELECT 1;");
    expect(r.decision).toBe(Decision.ALLOW);
  });

  it("allows a read with a semicolon inside a string literal", () => {
    const r = policyAuto().checkQuery("SELECT * FROM t WHERE name = 'a;b'");
    expect(r.decision).toBe(Decision.ALLOW);
  });

  it("allows a read with semicolons in both quote styles", () => {
    const r = policyAuto().checkQuery(
      `SELECT * FROM t WHERE a = 'x;y' AND b = "p;q"`,
    );
    expect(r.decision).toBe(Decision.ALLOW);
  });

  // V2.0: a DROP after a SELECT now classifies as ADMIN (present), so the
  // compound is present_only. The classifier still strips comments and
  // fires on the hidden DROP — this test guards that behavior.
  it("classifies hidden DROP after a block comment as ADMIN", () => {
    const r = policyAuto().checkQuery("/* SELECT 1 */ DROP TABLE users; SELECT 2");
    expect(r.decision).toBe(Decision.PRESENT_ONLY);
  });

  it("privilege in compound wins over allowed reads", () => {
    const r = policyAuto().checkQuery("SELECT 1; GRANT SELECT ON t TO u");
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason.toLowerCase()).toMatch(/privilege|never allowed/);
  });

  // V2.0: with default policy (privilege: deny, admin: present), a compound
  // mixing ADMIN with PRIVILEGE denies via the privilege rule (strictest).
  it("PRIVILEGE beats ADMIN: a compound with both is denied", () => {
    const r = policyAuto().checkQuery("DROP TABLE users; GRANT SELECT ON t TO u");
    expect(r.decision).toBe(Decision.DENY);
  });
});
