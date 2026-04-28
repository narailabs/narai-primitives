/**
 * Approval-gate type system. Shared across every connector.
 *
 * Wire formats are lowercase string literals so JSON round-trips without a
 * codec step. The canonical envelope `status` is `success | denied | escalate
 * | error`; connectors MAY extend with custom status values via the
 * `extendDecision` hook on `createConnector` (db-agent uses `present_only`).
 */

// ───────────────────────────────────────────────────────────────────────────
// Classification — what `classify(action, params)` returns.
// ───────────────────────────────────────────────────────────────────────────

/** The CRUD-ish base axis every connector classifies into. */
export type Kind = "read" | "write" | "admin";

/**
 * Kind plus optional connector-specific aspects (free-form strings).
 * Aspects layer on top of kind for finer gating (e.g. `unbounded_select`,
 * `source_code`, `pii`, `bulk_read`). Rule lookup applies kind first, then
 * the strictest aspect rule that matches wins.
 */
export interface Classification {
  kind: Kind;
  aspects?: readonly string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Rules — operator-configured actions per kind / aspect.
// ───────────────────────────────────────────────────────────────────────────

/** Wire rules operators set per classification. */
export type Rule = "success" | "present" | "escalate" | "denied";

/** Rule without `"success"` — used for safety-floor slots (admin, ddl, privilege). */
export type RestrictedRule = Exclude<Rule, "success">;

export interface PolicyRules {
  read: Rule;
  write: Rule;
  admin: RestrictedRule;
  /** Per-aspect rule map. Absent aspects fall through to the kind's rule. */
  aspects?: Record<string, Rule>;
}

export type ApprovalMode =
  | "auto"
  | "confirm_once"
  | "confirm_each"
  | "grant_required";

/** Defaults matching db-agent's historical behavior, generalized to CRUD. */
export const DEFAULT_POLICY: PolicyRules = {
  read: "success",
  write: "present",
  admin: "denied",
  aspects: {},
};

// ───────────────────────────────────────────────────────────────────────────
// Decision — what `checkPolicy` returns.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A gate decision. `extendDecision` hooks (e.g., db-agent's `present_only`)
 * widen this by returning an envelope with additional fields; the base
 * discriminants are fixed.
 */
export type Decision =
  | { status: "success"; reason: string }
  | { status: "denied"; reason: string }
  | { status: "escalate"; reason: string };

/** Strictness rank for combining multiple decisions (denied wins). */
export const DECISION_RANK: Record<Decision["status"], number> = {
  success: 0,
  escalate: 1,
  denied: 2,
};

// ───────────────────────────────────────────────────────────────────────────
// Envelope — what CLI emits on stdout.
// ───────────────────────────────────────────────────────────────────────────

/** Canonical 7-code error taxonomy used across every connector. */
export type ErrorCode =
  | "AUTH_ERROR"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "VALIDATION_ERROR"
  | "CONFIG_ERROR"
  | "CONNECTION_ERROR";

/** Success envelope — data payload is connector-specific. */
export interface SuccessEnvelope {
  status: "success";
  action: string;
  data: Record<string, unknown>;
}

/**
 * Resolution hint attached to non-success envelopes when a curated hardship
 * pattern matches. Task 6.2 attaches these at runtime.
 */
export interface ResolutionHint {
  pattern_id: string;
  advice: string;
  confidence: number;
  scope: "tenant" | "global";
}

/** Gate-deny envelope. */
export interface DeniedEnvelope {
  status: "denied";
  action: string;
  reason: string;
  resolution_hint?: ResolutionHint;
}

/** Gate-escalate envelope. */
export interface EscalateEnvelope {
  status: "escalate";
  action: string;
  reason: string;
  resolution_hint?: ResolutionHint;
}

/** Runtime error envelope. */
export interface ErrorEnvelope {
  status: "error";
  action: string;
  error_code: ErrorCode;
  message: string;
  retriable: boolean;
  resolution_hint?: ResolutionHint;
}

/**
 * Connector-extended envelope. `extendDecision` hooks may emit custom status
 * values (e.g., `present_only`). The `extension` field carries the
 * connector-specific payload; arbitrary extra fields are accessed via cast.
 */
export interface ExtendedEnvelope {
  status: string;
  action: string;
  message?: string;
  extension: Record<string, unknown>;
  resolution_hint?: ResolutionHint;
}

export type Envelope =
  | SuccessEnvelope
  | DeniedEnvelope
  | EscalateEnvelope
  | ErrorEnvelope
  | ExtendedEnvelope;
