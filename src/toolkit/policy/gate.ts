/**
 * Pure rule → Decision mapping. Stateless; approval-mode state lives in
 * `./approval.ts` (the factory wires it up per connector invocation).
 *
 * Rule combination: kind rule is the base; each aspect rule (if declared)
 * applies on top via Rule strictness (denied > escalate > present > success).
 * Note: Rule "present" collapses to Decision "escalate" — extendDecision
 * hooks intercept escalate to emit ExtendedEnvelope.
 * Ties go to the first offender so the `reason` message is predictable.
 */
import type {
  ApprovalMode,
  Classification,
  Decision,
  PolicyRules,
  Rule,
} from "./types.js";
import { DECISION_RANK } from "./types.js";

/** Strictness rank for combining Rule values (same order as DECISION_RANK). */
const RULE_RANK: Record<Rule, number> = {
  success: 0,
  present: 1,
  escalate: 2,
  denied: 3,
};

/** Minimal state needed for approval-mode resolution. Pure-data. */
export interface ApprovalState {
  sessionApproved: boolean;
  hasActiveGrant: (grantType: string) => boolean;
}

/**
 * Evaluate a classification against rules + approval mode, returning a
 * decision. No side effects — the caller is responsible for emitting audit
 * events (see `../audit/writer.ts`).
 */
export function checkPolicy(
  classification: Classification,
  rules: PolicyRules,
  approvalMode: ApprovalMode,
  approvalState: ApprovalState,
): Decision {
  const kind = classification.kind;
  const kindRule: Rule = rules[kind];

  // Combine kind rule with the strictest matching aspect rule.
  let combinedRule: Rule = kindRule;
  let strictestReasonSource: "kind" | "aspect" = "kind";
  let offendingAspect: string | null = null;

  if (classification.aspects && rules.aspects) {
    for (const aspect of classification.aspects) {
      const aspectRule = rules.aspects[aspect];
      if (aspectRule === undefined) continue;
      if (RULE_RANK[aspectRule] > RULE_RANK[combinedRule]) {
        combinedRule = aspectRule;
        strictestReasonSource = "aspect";
        offendingAspect = aspect;
      }
    }
  }

  // Map the combined rule to a decision.
  switch (combinedRule) {
    case "denied":
      return { status: "denied", reason: denyReason(kind, strictestReasonSource, offendingAspect) };
    case "escalate":
      return {
        status: "escalate",
        reason: escalateReason(kind, strictestReasonSource, offendingAspect),
      };
    // Rule "present" collapses to Decision "escalate" in toolkit 3.0;
    // extendDecision hooks (e.g. db-agent) intercept escalate to emit
    // a connector-specific ExtendedEnvelope.
    case "present":
      return { status: "escalate", reason: presentReason(kind, strictestReasonSource, offendingAspect) };
    case "success":
      // A "success" rule for reads still has to pass the approval mode gate.
      if (kind === "read") {
        return resolveApprovalMode(approvalMode, approvalState);
      }
      return { status: "success", reason: `${kind} allowed by policy` };
  }
}

/**
 * Read-specific: given that policy says "success", apply the approval-mode
 * state machine.
 *
 *  - auto: always success
 *  - confirm_once: escalate until sessionApproved, then success
 *  - confirm_each: always escalate
 *  - grant_required: success iff hasActiveGrant("read"), else denied
 */
function resolveApprovalMode(
  mode: ApprovalMode,
  state: ApprovalState,
): Decision {
  switch (mode) {
    case "auto":
      return { status: "success", reason: "auto-approved" };
    case "confirm_once":
      if (state.sessionApproved) {
        return { status: "success", reason: "session approved" };
      }
      return {
        status: "escalate",
        reason: "First read requires confirmation (confirm_once)",
      };
    case "confirm_each":
      return {
        status: "escalate",
        reason: "Each read requires confirmation (confirm_each)",
      };
    case "grant_required":
      if (state.hasActiveGrant("read")) {
        return { status: "success", reason: "active read grant" };
      }
      return { status: "denied", reason: "No active read grant" };
  }
}

/**
 * Combine multiple per-call decisions (e.g., db-agent classifies each SQL
 * statement separately). Strictest decision wins; ties by first occurrence.
 */
export function combineDecisions(decisions: readonly Decision[]): Decision {
  if (decisions.length === 0) {
    throw new Error("combineDecisions requires at least one decision");
  }
  let winner = decisions[0]!;
  for (let i = 1; i < decisions.length; i++) {
    const d = decisions[i]!;
    if (DECISION_RANK[d.status] > DECISION_RANK[winner.status]) {
      winner = d;
    }
  }
  return winner;
}

// ───────────────────────────────────────────────────────────────────────────
// Reason builders — stable strings so tests/evals can assert on them.
// ───────────────────────────────────────────────────────────────────────────

function denyReason(
  kind: string,
  source: "kind" | "aspect",
  aspect: string | null,
): string {
  if (source === "aspect" && aspect !== null) {
    return `${aspect} aspect is denied by policy`;
  }
  return `${kind} is denied by policy`;
}

function escalateReason(
  kind: string,
  source: "kind" | "aspect",
  aspect: string | null,
): string {
  if (source === "aspect" && aspect !== null) {
    return `${aspect} aspect requires approval`;
  }
  return `${kind} requires approval`;
}

function presentReason(
  kind: string,
  source: "kind" | "aspect",
  aspect: string | null,
): string {
  if (source === "aspect" && aspect !== null) {
    return `${aspect} aspect is displayed but not executed`;
  }
  return `${kind} is displayed but not executed`;
}
