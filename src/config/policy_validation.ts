/**
 * Hub-level validator for `~/.connectors/config.yaml` policy blocks.
 *
 * The base `PolicyDecision` set is `"allow" | "escalate" | "deny"`; each
 * connector may register extras (e.g. db-agent's `"present"`) via the
 * `policyExtras` field on `createConnector`. This module is the **runtime
 * IoC complement** to that type-level surface — it validates resolved
 * config values against `PolicyDecision ∪ per-connector extras` so a
 * typo'd `write: "esclate"` fails at config-load instead of at first call.
 *
 * The validator is intentionally non-throwing by default: callers receive
 * a list of issues and decide whether to log, warn, or hard-fail. An
 * `assertValidPolicies` helper throws when any issue is found.
 *
 * Where to wire it up:
 *  - The hub (planner) can call `assertValidPolicies(resolved, { connectorExtras })`
 *    after `loadResolvedConfig`, with `connectorExtras` populated from each
 *    builtin connector's exported vocabulary (e.g. `DB_POLICY_EXTRAS`).
 *  - Custom connectors loaded via `~/.connectors/connectors/<name>/` should
 *    expose their own vocabulary the same way; the hub merges it into the
 *    `connectorExtras` map before validating.
 */
import type { PolicyDecision, PolicyMap, ResolvedConfig } from "./types.js";

/** The five canonical action keys validated as typed slots. */
const TYPED_ACTIONS = ["read", "write", "delete", "admin", "privilege"] as const;
type TypedAction = (typeof TYPED_ACTIONS)[number];

/** Universal decision set, kept in lockstep with the `PolicyDecision` type. */
const BASE_DECISIONS: readonly PolicyDecision[] = [
  "allow",
  "escalate",
  "deny",
];

/** A single offending policy value, with enough context to surface to operators. */
export interface PolicyIssue {
  /** Connector name, or `null` when the issue is on the top-level `policy:`. */
  connector: string | null;
  /** Which typed action slot was offending (always one of the TYPED_ACTIONS). */
  action: TypedAction;
  /** The actual (offending) value found in config. */
  value: string;
  /** What the validator expected — base decisions ∪ this connector's extras. */
  expected: readonly string[];
}

/** Options forwarded to `validatePolicies` / `assertValidPolicies`. */
export interface ValidationOptions {
  /**
   * Per-connector extra-decision vocabulary. Keyed by connector name as it
   * appears in the resolved config. Connectors absent from this map are
   * validated against `PolicyDecision` only — which is correct behavior
   * for connectors that don't widen the decision set.
   *
   * For builtin connectors, prefer importing the connector's own constant
   * (e.g. `DB_POLICY_EXTRAS` from `narai-primitives/db/plugin-config`) so
   * the runtime list and the type-level `TExtra` parameter stay in lockstep.
   */
  connectorExtras?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Validate every typed action slot in a resolved config against the
 * appropriate vocabulary. Returns the list of issues (empty ⇒ valid).
 *
 * Top-level `policy` is validated against the base `PolicyDecision` set
 * with no extras — extras only have meaning at the connector level.
 *
 * Free-form aspect keys (e.g. db's `unbounded_select`) are not validated
 * here: they flow through the `[extra: string]` index signature on
 * `PolicyMap`, and each connector validates its own extras at the
 * connector boundary (with full knowledge of its valid set).
 */
export function validatePolicies(
  config: ResolvedConfig,
  opts: ValidationOptions = {},
): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const connectorExtras = opts.connectorExtras ?? {};

  validatePolicyMap(config.policy, [], null, issues);

  for (const [name, slice] of Object.entries(config.connectors)) {
    const extras = connectorExtras[name] ?? [];
    validatePolicyMap(slice.policy, extras, name, issues);
  }

  return issues;
}

/** Throwing variant. Composes with `validatePolicies` — same options, same checks. */
export function assertValidPolicies(
  config: ResolvedConfig,
  opts: ValidationOptions = {},
): void {
  const issues = validatePolicies(config, opts);
  if (issues.length === 0) return;
  const lines = issues.map((i) => {
    const where = i.connector === null ? "<top-level>" : `connectors.${i.connector}`;
    return `  ${where}.policy.${i.action} = ${JSON.stringify(i.value)} ` +
      `(expected one of ${JSON.stringify(i.expected)})`;
  });
  throw new Error(`Invalid policy values:\n${lines.join("\n")}`);
}

function validatePolicyMap(
  policy: PolicyMap,
  knownExtras: readonly string[],
  connector: string | null,
  out: PolicyIssue[],
): void {
  const allowed: readonly string[] = [...BASE_DECISIONS, ...knownExtras];
  for (const action of TYPED_ACTIONS) {
    const value = (policy as Record<string, unknown>)[action];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      out.push({ connector, action, value: String(value), expected: allowed });
      continue;
    }
    if (!allowed.includes(value)) {
      out.push({ connector, action, value, expected: allowed });
    }
  }
}
