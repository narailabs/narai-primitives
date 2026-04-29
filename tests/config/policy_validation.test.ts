/**
 * Hub-side validation of policy values against `PolicyDecision ∪ extras`.
 *
 * These tests pin the runtime IoC complement to the type-level generic:
 * the resolve layer accepts any string in policy slots (so the hub stays
 * connector-agnostic), but consumers can call `validatePolicies` with a
 * per-connector vocabulary registry to fail config-load on bad values.
 */
import { describe, it, expect } from "vitest";
import {
  validatePolicies,
  assertValidPolicies,
} from "../../src/config/policy_validation.js";
import { DB_POLICY_EXTRAS } from "../../src/connectors/db/lib/plugin_config.js";
import type { ResolvedConfig } from "../../src/config/types.js";

function buildConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    hub: { model: null, max_tokens: null },
    policy: {},
    enforce_hooks: true,
    model: null,
    environment: null,
    consumer: null,
    connectors: {},
    ...overrides,
  };
}

describe("validatePolicies — base decisions only", () => {
  it("accepts allow / escalate / deny in every typed slot", () => {
    const cfg = buildConfig({
      policy: { read: "allow", write: "escalate", delete: "deny", admin: "deny", privilege: "deny" },
      connectors: {
        github: {
          name: "github", enabled: true, skill: "github-agent-connector",
          model: null, enforce_hooks: true,
          policy: { read: "allow", write: "escalate" },
          options: {},
        },
      },
    });
    expect(validatePolicies(cfg)).toEqual([]);
  });

  it("rejects connector-specific extras when no extras registered", () => {
    const cfg = buildConfig({
      connectors: {
        db: {
          name: "db", enabled: true, skill: "db-agent-connector",
          model: null, enforce_hooks: true,
          policy: { write: "present" },
          options: {},
        },
      },
    });
    const issues = validatePolicies(cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      connector: "db",
      action: "write",
      value: "present",
    });
    expect(issues[0]?.expected).toEqual(["allow", "escalate", "deny"]);
  });

  it("rejects nonsense values (typos)", () => {
    const cfg = buildConfig({
      connectors: {
        github: {
          name: "github", enabled: true, skill: "github-agent-connector",
          model: null, enforce_hooks: true,
          policy: { read: "esclate" },
          options: {},
        },
      },
    });
    const issues = validatePolicies(cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.value).toBe("esclate");
  });
});

describe("validatePolicies — with per-connector extras", () => {
  it("accepts db's 'present' when DB_POLICY_EXTRAS is registered", () => {
    const cfg = buildConfig({
      connectors: {
        db: {
          name: "db", enabled: true, skill: "db-agent-connector",
          model: null, enforce_hooks: true,
          policy: { write: "present", admin: "present" },
          options: {},
        },
      },
    });
    const issues = validatePolicies(cfg, {
      connectorExtras: { db: DB_POLICY_EXTRAS },
    });
    expect(issues).toEqual([]);
  });

  it("rejects extras belonging to a different connector", () => {
    const cfg = buildConfig({
      connectors: {
        github: {
          name: "github", enabled: true, skill: "github-agent-connector",
          model: null, enforce_hooks: true,
          policy: { write: "present" },
          options: {},
        },
      },
    });
    // db's vocabulary is registered, but github isn't — github gets base only.
    const issues = validatePolicies(cfg, {
      connectorExtras: { db: DB_POLICY_EXTRAS },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.connector).toBe("github");
  });

  it("does not validate top-level policy against connector extras", () => {
    const cfg = buildConfig({
      policy: { write: "present" },  // top-level — only base decisions allowed
      connectors: {
        db: {
          name: "db", enabled: true, skill: "db-agent-connector",
          model: null, enforce_hooks: true,
          policy: { write: "present" },
          options: {},
        },
      },
    });
    const issues = validatePolicies(cfg, {
      connectorExtras: { db: DB_POLICY_EXTRAS },
    });
    // db's per-connector slice is OK; top-level "present" is rejected.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.connector).toBeNull();
  });

  it("ignores undefined slots and free-form extra keys", () => {
    const cfg = buildConfig({
      connectors: {
        db: {
          name: "db", enabled: true, skill: "db-agent-connector",
          model: null, enforce_hooks: true,
          // unbounded_select is a connector-specific *aspect* (not a typed action),
          // so the validator skips it — db's own validator handles it.
          policy: { read: "allow", unbounded_select: "escalate" } as never,
          options: {},
        },
      },
    });
    expect(validatePolicies(cfg, { connectorExtras: { db: DB_POLICY_EXTRAS } }))
      .toEqual([]);
  });
});

describe("assertValidPolicies", () => {
  it("returns silently when every slot is valid", () => {
    const cfg = buildConfig({
      policy: { read: "allow" },
    });
    expect(() => assertValidPolicies(cfg)).not.toThrow();
  });

  it("throws an aggregated error citing every offender", () => {
    const cfg = buildConfig({
      policy: { read: "wat" },
      connectors: {
        github: {
          name: "github", enabled: true, skill: "github-agent-connector",
          model: null, enforce_hooks: true,
          policy: { write: "yolo", admin: "free-for-all" },
          options: {},
        },
      },
    });
    expect(() => assertValidPolicies(cfg)).toThrowError(/Invalid policy values/);
    try {
      assertValidPolicies(cfg);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("<top-level>");
      expect(msg).toContain("connectors.github.policy.write");
      expect(msg).toContain("connectors.github.policy.admin");
    }
  });
});
