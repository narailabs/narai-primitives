/**
 * Audit event shapes. Every event becomes one line in a JSONL file.
 *
 * `event_type` is the discriminant; the union is open (extensible) because
 * connectors may emit their own event types via `AuditWriter.logEvent`.
 */

export interface BaseEvent {
  event_type: string;
  timestamp: string;   // ISO-8601 UTC, millisecond precision, trailing "Z"
  session_id: string;
  details?: Record<string, unknown>;
}

/** Emitted on every action invocation (after policy gate). */
export interface ActionEvent extends BaseEvent {
  event_type: "action";
  connector: string;
  action: string;
  status: string;           // envelope's top-level status (success/denied/escalate/error/...)
  execution_time_ms: number;
}

/** Policy-gate decision events. */
export interface PolicyEvent extends BaseEvent {
  event_type:
    | "policy_success"
    | "policy_denied"
    | "policy_escalate";
  connector: string;
  action: string;
  reason: string;
  kind: string;
  aspects?: readonly string[];
}

/** Grant lifecycle. */
export interface GrantEvent extends BaseEvent {
  event_type: "grant_added" | "grant_expired" | "grant_revoked";
  grant_type: string;
  ttl_seconds?: number;
}

/** Hardship — also written to JSONL via the hardship module, but audited too. */
export interface HardshipEvent extends BaseEvent {
  event_type: "hardship_recorded";
  connector: string;
  action: string;
  kind: string;
  context: string;
}

export type AuditEvent =
  | BaseEvent
  | ActionEvent
  | PolicyEvent
  | GrantEvent
  | HardshipEvent;
