/**
 * Type-level inversion-of-control assertions for `PolicyMap` and friends.
 *
 * These tests validate the generic `PolicyMap<TExtra>` behaviour — that
 * specializing widens the accepted decision set without polluting the base
 * universal `PolicyDecision`. The runtime body is a thin sanity check; the
 * actual contract lives in the `// @ts-expect-error` comments, which the
 * project's `tsc --noEmit` step verifies.
 *
 * If a `@ts-expect-error` comment ends up over a line that no longer fails
 * typing, tsc will report it as an unused suppression — meaning the type
 * IoC has weakened and a connector-specific decision has leaked into the
 * base set.
 */
import { describe, it, expect } from "vitest";

import type {
  PolicyDecision,
  PolicyMap,
  ResolvedConnector,
  ResolvedConfig,
} from "../../src/config/types.js";
import type {
  DbExtraDecision,
  DbPolicyMap,
  DbResolvedConnector,
} from "../../src/connectors/db/lib/plugin_config.js";

// ───────────────────────────────────────────────────────────────────────────
// Helpers — make assignability checks read like assertions.
// ───────────────────────────────────────────────────────────────────────────

function expectAssignable<T>(_value: T): void {
  /* compile-time only */
}

// ───────────────────────────────────────────────────────────────────────────
// Base type: PolicyDecision must NOT include connector-specific extras.
// ───────────────────────────────────────────────────────────────────────────

describe("PolicyDecision (base)", () => {
  it("admits exactly allow / escalate / deny", () => {
    expectAssignable<PolicyDecision>("allow");
    expectAssignable<PolicyDecision>("escalate");
    expectAssignable<PolicyDecision>("deny");

    // @ts-expect-error — "present" is db-agent's, not part of the universal set.
    expectAssignable<PolicyDecision>("present");
    // @ts-expect-error — present_only is db's runtime spelling, not config-level.
    expectAssignable<PolicyDecision>("present_only");
    // @ts-expect-error — arbitrary strings are not PolicyDecision.
    expectAssignable<PolicyDecision>("anything-else");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PolicyMap: connector-agnostic by default, strict when narrowed, widenable.
// ───────────────────────────────────────────────────────────────────────────

describe("PolicyMap<TExtra>", () => {
  it("default (TExtra = string) is connector-agnostic and admits any string", () => {
    // Hub-style code annotates without specializing — anything string-shaped
    // flows through. This is the runtime today, type-encoded.
    const policy: PolicyMap = { read: "allow", write: "anything-goes", delete: "present" };
    expect(policy.read).toBe("allow");
  });

  it("PolicyMap<never> is the strictest specialization (only base PolicyDecision)", () => {
    const strict: PolicyMap<never> = { read: "allow", write: "escalate", delete: "deny" };
    expect(strict.read).toBe("allow");

    // @ts-expect-error — "present" is not in PolicyDecision and TExtra=never.
    const _bad1: PolicyMap<never> = { read: "present" };
    // @ts-expect-error — db's wire spelling has no place at the config level.
    const _bad2: PolicyMap<never> = { write: "present_only" };
    void _bad1; void _bad2;
  });

  it("PolicyMap<\"present\"> admits 'present' but rejects unrelated extras", () => {
    const dbish: PolicyMap<"present"> = { read: "present", write: "allow", delete: "deny" };
    expect(dbish.read).toBe("present");

    // @ts-expect-error — only "present" is widened; other extras still rejected.
    const _bad: PolicyMap<"present"> = { read: "sandbox" };
    void _bad;
  });

  it("future connectors can declare their own without touching the base", () => {
    // Imagine a hypothetical "sandbox" connector — no narai-primitives change required.
    type SandboxPolicyMap = PolicyMap<"sandbox" | "queue">;
    const sandboxPolicy: SandboxPolicyMap = { write: "sandbox", delete: "queue" };
    expect(sandboxPolicy.write).toBe("sandbox");

    // @ts-expect-error — db's "present" doesn't belong in this connector's vocabulary.
    const _bad: SandboxPolicyMap = { write: "present" };
    void _bad;
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ResolvedConnector / ResolvedConfig propagate TExtra through.
// ───────────────────────────────────────────────────────────────────────────

describe("ResolvedConnector / ResolvedConfig propagation", () => {
  it("ResolvedConnector<TExtra> threads the parameter into policy", () => {
    const slice: ResolvedConnector<"present"> = {
      name: "db",
      enabled: true,
      skill: "db-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: { read: "allow", write: "present", delete: "present" },
      options: {},
    };
    expect(slice.policy.write).toBe("present");

    // @ts-expect-error — even on a specialized slice, unknown extras are rejected.
    const _bad: ResolvedConnector<"present"> = {
      name: "db", enabled: true, skill: "x", model: null, enforce_hooks: false,
      policy: { read: "sandbox" }, options: {},
    };
    void _bad;
  });

  it("ResolvedConfig<TExtra> uniformly widens both top-level and per-connector policy", () => {
    const cfg: ResolvedConfig<"present"> = {
      hub: { model: null, max_tokens: null },
      policy: { read: "present" },
      enforce_hooks: false,
      model: null,
      environment: null,
      consumer: null,
      connectors: {
        db: {
          name: "db", enabled: true, skill: "db-agent-connector", model: null,
          enforce_hooks: false,
          policy: { read: "present" },
          options: {},
        },
      },
    };
    expect(cfg.connectors.db?.policy.read).toBe("present");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// db-agent specialization: the typed exports route to the right widening.
// ───────────────────────────────────────────────────────────────────────────

describe("db-agent typed exports", () => {
  it("DbExtraDecision is exactly 'present' (no leakage of present_only or others)", () => {
    expectAssignable<DbExtraDecision>("present");

    // @ts-expect-error — present_only is the runtime/wire form, not a config rule.
    expectAssignable<DbExtraDecision>("present_only");
    // @ts-expect-error — db's vocabulary doesn't include arbitrary strings.
    expectAssignable<DbExtraDecision>("escalate-but-also-publish");
  });

  it("DbPolicyMap = PolicyMap<DbExtraDecision> accepts the four db-config values", () => {
    const p: DbPolicyMap = {
      read: "allow",
      write: "present",
      delete: "escalate",
      admin: "deny",
    };
    expect(p.read).toBe("allow");

    // @ts-expect-error — anything outside the four-value set still rejected.
    const _bad: DbPolicyMap = { read: "queue" };
    void _bad;
  });

  it("DbResolvedConnector exposes the same widening at the slice level", () => {
    const slice: DbResolvedConnector = {
      name: "db", enabled: true, skill: "db-agent-connector",
      model: null, enforce_hooks: true,
      policy: { read: "allow", write: "present" },
      options: {},
    };
    expect(slice.policy.write).toBe("present");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// policyExtras: the runtime IoC complement is declared, accessible, and typed.
// ───────────────────────────────────────────────────────────────────────────

describe("ConnectorConfig.policyExtras (runtime vocabulary)", () => {
  it("the db connector declares ['present'] at runtime", async () => {
    // Live import — exercises the export wiring end-to-end.
    const { default: dbConnector } = await import("../../src/connectors/db/index.js");
    // The `policyExtras` field lives on the ConnectorConfig that built the
    // connector; the public Connector interface doesn't re-expose it. So we
    // assert the underlying constant matches what the connector ships.
    const { DB_POLICY_EXTRAS } = await import("../../src/connectors/db/lib/plugin_config.js");
    expect(DB_POLICY_EXTRAS).toEqual(["present"]);
    expect(dbConnector.name).toBe("db");
  });
});
