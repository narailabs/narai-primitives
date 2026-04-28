import { describe, expect, it } from "vitest";
import { checkPolicy, combineDecisions } from "../../src/toolkit/policy/gate.js";
import type { Classification, PolicyRules } from "../../src/toolkit/policy/types.js";
import { DEFAULT_POLICY, DECISION_RANK } from "../../src/toolkit/policy/types.js";

const noApproval = { sessionApproved: false, hasActiveGrant: () => false };

describe("checkPolicy — kind rules", () => {
  it("read with auto approval returns success", () => {
    const d = checkPolicy({ kind: "read" }, DEFAULT_POLICY, "auto", noApproval);
    expect(d.status).toBe("success");
    expect(d.reason).toBe("auto-approved");
  });

  it("write with default policy (=present) returns escalate", () => {
    const d = checkPolicy({ kind: "write" }, DEFAULT_POLICY, "auto", noApproval);
    expect(d.status).toBe("escalate");
  });

  it("admin with default policy (=denied) returns denied", () => {
    const d = checkPolicy({ kind: "admin" }, DEFAULT_POLICY, "auto", noApproval);
    expect(d.status).toBe("denied");
  });
});

describe("checkPolicy — aspect override", () => {
  const rules: PolicyRules = {
    ...DEFAULT_POLICY,
    read: "success",
    aspects: { unbounded_select: "escalate", pii: "denied" },
  };

  it("read + unbounded_select aspect escalates", () => {
    const cls: Classification = { kind: "read", aspects: ["unbounded_select"] };
    const d = checkPolicy(cls, rules, "auto", noApproval);
    expect(d.status).toBe("escalate");
    expect(d.reason).toContain("unbounded_select");
  });

  it("strictest aspect wins when multiple apply", () => {
    const cls: Classification = {
      kind: "read",
      aspects: ["unbounded_select", "pii"],
    };
    const d = checkPolicy(cls, rules, "auto", noApproval);
    expect(d.status).toBe("denied");
    expect(d.reason).toContain("pii");
  });

  it("unrecognized aspect is ignored", () => {
    const cls: Classification = { kind: "read", aspects: ["unknown_aspect"] };
    const d = checkPolicy(cls, rules, "auto", noApproval);
    expect(d.status).toBe("success");
  });
});

describe("checkPolicy — approval_mode state machine", () => {
  const rules: PolicyRules = { ...DEFAULT_POLICY, read: "success" };

  it("confirm_once: escalates until approved, then succeeds", () => {
    const cls: Classification = { kind: "read" };
    const state1 = { sessionApproved: false, hasActiveGrant: () => false };
    expect(checkPolicy(cls, rules, "confirm_once", state1).status).toBe("escalate");
    const state2 = { sessionApproved: true, hasActiveGrant: () => false };
    expect(checkPolicy(cls, rules, "confirm_once", state2).status).toBe("success");
  });

  it("confirm_each: always escalates", () => {
    const d = checkPolicy(
      { kind: "read" },
      rules,
      "confirm_each",
      { sessionApproved: true, hasActiveGrant: () => true },
    );
    expect(d.status).toBe("escalate");
  });

  it("grant_required: success iff read grant active, else denied", () => {
    const with_ = checkPolicy(
      { kind: "read" },
      rules,
      "grant_required",
      { sessionApproved: false, hasActiveGrant: (t) => t === "read" },
    );
    expect(with_.status).toBe("success");
    const without = checkPolicy(
      { kind: "read" },
      rules,
      "grant_required",
      noApproval,
    );
    expect(without.status).toBe("denied");
  });

  it("approval_mode does not apply to write/admin", () => {
    // Write rule = present → escalate regardless of approval_mode.
    const d = checkPolicy(
      { kind: "write" },
      DEFAULT_POLICY,
      "grant_required",
      noApproval,
    );
    expect(d.status).toBe("escalate");
  });
});

describe("combineDecisions", () => {
  it("denied beats everything else", () => {
    const combined = combineDecisions([
      { status: "success", reason: "" },
      { status: "escalate", reason: "" },
      { status: "denied", reason: "blocked" },
    ]);
    expect(combined.status).toBe("denied");
    expect(combined.reason).toBe("blocked");
  });

  it("escalate beats success", () => {
    const combined = combineDecisions([
      { status: "success", reason: "" },
      { status: "escalate", reason: "wait" },
    ]);
    expect(combined.status).toBe("escalate");
  });

  it("ties go to first occurrence", () => {
    const combined = combineDecisions([
      { status: "escalate", reason: "first" },
      { status: "escalate", reason: "second" },
    ]);
    expect(combined.reason).toBe("first");
  });

  it("throws on empty list", () => {
    expect(() => combineDecisions([])).toThrow(/requires at least one/);
  });
});

describe("Decision union (3.0)", () => {
  it("has exactly three base statuses", () => {
    expect(Object.keys(DECISION_RANK).sort()).toEqual([
      "denied",
      "escalate",
      "success",
    ]);
  });
});
