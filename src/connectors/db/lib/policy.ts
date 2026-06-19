/**
 * policy.ts — Guard-rail mechanism for SQL query authorization.
 *
 * Classifies SQL statements and enforces approval policies before execution.
 *
 * Parity notes vs. the Python reference (`policy.py`):
 *  - `Decision` is a string-literal union (not an enum) so JSON output is the
 *    lowercase wire value directly: `"allow" | "deny" | "escalate" |
 *    "present_only"`. Python's `Enum` values serialize the same.
 *  - `PolicyResult` is a discriminated union on `decision`; `formatted_sql`
 *    exists ONLY on the `present_only` branch, matching Python's behaviour
 *    where the field is populated just for write/delete/admin (was DML).
 *  - Default-deny on unknown first-words: the classifier falls through to
 *    `"admin"` (the most restrictive category) for anything not in the known
 *    keyword sets. Python's reference fell through to `"ddl"`; the V2.0
 *    rename moves DDL→ADMIN but the safety floor is unchanged.
 *
 * G-DB-1: the SQL keyword classifier is exported as a top-level
 * `classifySqlKeywords` so non-relational drivers (MongoDB, DynamoDB) can
 * provide their own override via the `DatabaseDriver.classifyOperation`
 * method without going through the SQL keyword path. Policy.checkQuery
 * accepts an optional driver and dispatches accordingly.
 */
import { performance } from "node:perf_hooks";
import type { PolicyDecision } from "narai-primitives/config";
import type { DatabaseDriver } from "./drivers/base.js";
import { logEvent, scrubSqlSecrets } from "./audit.js";
import { DEFAULT_POLICY, type PolicyRules } from "./plugin_config.js";

/**
 * Possible outcomes of a db-internal policy check (wire format = lowercase
 * string). Composed from the universal `PolicyDecision` plus db's local
 * `"present_only"` so the base set has a single source of truth. Note that
 * `"present_only"` is a *runtime* spelling distinct from the *config-level*
 * `"present"` rule (the latter is the operator-facing token in YAML; this
 * one is the wire status emitted in the envelope after rule translation).
 */
export type Decision = PolicyDecision | "present_only";

/** Namespace providing Python-style attribute access (`Decision.ALLOW`). */
export const Decision = {
  ALLOW: "allow" as const,
  DENY: "deny" as const,
  ESCALATE: "escalate" as const,
  PRESENT_ONLY: "present_only" as const,
} satisfies Record<string, Decision>;

/** Classification of statements by intent (V2.0 vocab). */
export type OperationType = "read" | "write" | "delete" | "admin" | "privilege";

/** Namespace mirroring Python's `OperationType.READ` etc. */
export const OperationType = {
  READ: "read" as const,
  WRITE: "write" as const,
  DELETE: "delete" as const,
  ADMIN: "admin" as const,
  PRIVILEGE: "privilege" as const,
} satisfies Record<string, OperationType>;

/** Discriminated union: `formatted_sql` is REQUIRED only when decision === "present_only". */
export type PolicyResult =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string }
  | { decision: "escalate"; reason: string }
  | { decision: "present_only"; reason: string; formatted_sql: string };

/**
 * Decision strictness rank. When a compound statement has multiple per-statement
 * decisions, the combined result is the one with the highest rank (deny beats
 * escalate beats present_only beats allow). Ties break by first occurrence so
 * the reported reason points at the earliest offending statement.
 */
const _DECISION_RANK: Record<Decision, number> = {
  allow: 0,
  present_only: 1,
  escalate: 2,
  deny: 3,
};

// -----------------------------------------------------------------------
// Keyword -> OperationType mapping (V2.0 vocab)
// -----------------------------------------------------------------------

const _READ_KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "WITH",
]);
const _WRITE_KEYWORDS: ReadonlySet<string> = new Set([
  "INSERT", "UPDATE", "REPLACE", "MERGE", "UPSERT",
]);
const _DELETE_KEYWORDS: ReadonlySet<string> = new Set([
  "DELETE", "TRUNCATE",
]);
const _ADMIN_KEYWORDS: ReadonlySet<string> = new Set([
  "CREATE", "DROP", "ALTER", "RENAME",
]);
const _PRIVILEGE_KEYWORDS: ReadonlySet<string> = new Set([
  "GRANT", "REVOKE",
]);

/**
 * Classify a SQL string by its leading keyword.
 *
 * Exported so SQL drivers (sqlite, postgres, mysql, mssql) can implement
 * `DatabaseDriver.classifyOperation` without instantiating a Policy. Throws
 * `Error("Empty SQL statement")` for empty/whitespace-only input.
 *
 * Default-deny: any unknown first-word falls through to `ADMIN` (most
 * restrictive), matching `policy.py`'s safety-floor intent.
 */
export function classifySqlKeywords(sql: string): OperationType {
  const cleaned = Policy._stripComments(sql).trim();
  if (!cleaned) {
    throw new Error("Empty SQL statement");
  }
  const firstToken = cleaned.split(/\s+/)[0] ?? "";
  const firstWord = firstToken.toUpperCase();

  if (_PRIVILEGE_KEYWORDS.has(firstWord)) return OperationType.PRIVILEGE;
  if (_ADMIN_KEYWORDS.has(firstWord)) return OperationType.ADMIN;
  if (_DELETE_KEYWORDS.has(firstWord)) return OperationType.DELETE;
  if (_WRITE_KEYWORDS.has(firstWord)) return OperationType.WRITE;
  if (_READ_KEYWORDS.has(firstWord)) return OperationType.READ;

  return OperationType.ADMIN;
}

/**
 * Split SQL on statement-terminating semicolons, respecting single- and double-
 * quoted string literals. Comments are stripped first, so line and block
 * comments cannot hide a semicolon.
 *
 * Returns trimmed, non-empty statements. An input with a single trailing
 * semicolon returns one statement. Edge cases: `''` escaped quotes inside a
 * single-quoted literal work by accident of toggle semantics (exit + re-enter
 * with nothing in between). NOT handled: PostgreSQL dollar-quoted strings
 * (`$tag$...$tag$`) and backtick-quoted identifiers — tolerably over-split
 * rather than under-split, which is the right bias for a safety gate.
 */
function _splitStatements(sql: string): string[] {
  const cleaned = Policy._stripComments(sql);
  const out: string[] = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ";" && !inSingle && !inDouble) {
      const s = cleaned.slice(start, i).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Classify every statement in a compound SQL string. Comments are stripped,
 * then the input is split on semicolons (outside quoted literals). Each
 * non-empty statement is classified via `classifySqlKeywords`. Throws
 * `"Empty SQL statement"` when the result would be zero statements — same
 * contract as `classifySqlKeywords` on empty input.
 *
 * The CLI pre-check and `Policy.checkQuery` both use this so that a compound
 * like `SELECT 1; DROP TABLE users;` is classified as [READ, ADMIN] and the
 * strictest rule (under V2.0 default `admin: present` → present_only) wins.
 * A compound of all reads classifies as [READ, READ, ...] and the aggregate
 * decision is allow.
 */
export function classifyStatements(sql: string): OperationType[] {
  const stmts = _splitStatements(sql);
  if (stmts.length === 0) {
    throw new Error("Empty SQL statement");
  }
  return stmts.map((s) => classifySqlKeywords(s));
}

// Regex to strip SQL line comments (-- ...) and block comments (/* ... */)
const _LINE_COMMENT_RE = /--[^\n]*/g;
// Python uses re.DOTALL so `.` matches newlines; in JS use the `s` flag.
const _BLOCK_COMMENT_RE = /\/\*.*?\*\//gs;


/**
 * Heuristic: a SELECT is "unbounded" if it reads from a table but has
 * no WHERE, LIMIT, JOIN, or specific id filter.
 *
 * Python uses `re.IGNORECASE | re.DOTALL`; in JS we emulate with `is` flags.
 */
const _UNBOUNDED_RE = /^\s*SELECT\s+.*\bFROM\s+\w+/is;
// G-POLICY-CROSSJOIN: require JOIN ... ON so CROSS JOIN (which has no
// join predicate and explodes rows) does not count as bounded. Bare
// JOIN USING (…) also falls through to escalate — safe direction.
const _BOUNDED_KEYWORDS_RE =
  /\b(WHERE|LIMIT|OFFSET|HAVING|GROUP\s+BY|JOIN\s+\S+\s+ON)\b/i;

export type ApprovalMode =
  | "auto"
  | "confirm_once"
  | "confirm_each"
  | "grant_required";

const _VALID_APPROVAL_MODES: ReadonlySet<ApprovalMode> = new Set([
  "auto", "confirm_once", "confirm_each", "grant_required",
]);

/**
 * Stateful policy engine that gates SQL execution.
 *
 * Parameters
 * ----------
 * approvalMode : string
 *     One of: auto, confirm_once, confirm_each, grant_required.
 */
export class Policy {
  private readonly _approval_mode: ApprovalMode;
  private readonly _rules: PolicyRules;
  private _session_approved: boolean;
  private readonly _grants: Map<string, number>; // grant_type -> expiry (ms, performance.now())
  // G-DB-AUDIT: grant_types that have already had a `grant_expired` event
  // emitted (de-dupes spam from repeated isGrantActive polling).
  private readonly _expired_logged: Set<string>;

  constructor(
    approvalMode: string = "auto",
    rules: PolicyRules = DEFAULT_POLICY,
  ) {
    if (!_VALID_APPROVAL_MODES.has(approvalMode as ApprovalMode)) {
      // Match Python repr(): single-quoted string.
      throw new Error(`Unknown approval_mode: '${approvalMode}'`);
    }
    this._approval_mode = approvalMode as ApprovalMode;
    this._rules = rules;
    this._session_approved = false;
    this._grants = new Map();
    this._expired_logged = new Set();
  }

  // ------------------------------------------------------------------
  // SQL classification
  // ------------------------------------------------------------------

  /** Remove SQL comments from the statement. */
  static _stripComments(sql: string): string {
    let s = sql.replace(_BLOCK_COMMENT_RE, "");
    s = s.replace(_LINE_COMMENT_RE, "");
    return s.trim();
  }

  /** Determine the OperationType of a raw SQL string. */
  classifySql(sql: string): OperationType {
    return classifySqlKeywords(sql);
  }

  // ------------------------------------------------------------------
  // Unbounded query heuristic
  // ------------------------------------------------------------------

  /** Return true if the SELECT appears to lack a bounding clause. */
  static _isUnboundedSelect(sql: string): boolean {
    if (!_UNBOUNDED_RE.test(sql)) return false;
    return !_BOUNDED_KEYWORDS_RE.test(sql);
  }

  // ------------------------------------------------------------------
  // Decision logic
  // ------------------------------------------------------------------

  /**
   * Evaluate whether `sql` should be executed under current policy.
   *
   * G-DB-1: when `driver` is supplied, classification is delegated to
   * `driver.classifyOperation()`. This lets non-relational drivers
   * (MongoDB, DynamoDB) classify their JSON envelope queries instead of
   * falling through SQL keyword matching (which would default to ADMIN).
   *
   * G-DB-AUDIT: every `deny` decision is emitted as a `policy_deny` event
   * via `audit.logEvent`. The audit module no-ops when audit is disabled.
   */
  checkQuery(sql: string, driver?: DatabaseDriver): PolicyResult {
    const stripped = sql.trim();
    if (!stripped) {
      const result: PolicyResult = { decision: "deny", reason: "Empty SQL statement" };
      _emitDeny(result.reason, null);
      return result;
    }

    // Non-SQL drivers (MongoDB, DynamoDB) receive JSON envelopes — semicolon
    // splitting would corrupt them. Stay on the single-statement path and
    // trust the driver's own classifier for those.
    if (driver !== undefined) {
      return this._checkSingleStatement(stripped, driver);
    }

    // SQL path: split on statement terminators, classify each, combine via
    // strictest-wins (deny > escalate > present_only > allow). A compound of
    // all-allowed statements stays allowed.
    let classifications: OperationType[];
    try {
      classifications = classifyStatements(stripped);
    } catch (exc) {
      const reason = (exc as Error).message;
      _emitDeny(reason, null);
      return { decision: "deny", reason };
    }

    const statements = _splitStatements(stripped);
    const perStmt: Array<{ stmt: string; op: OperationType; result: PolicyResult }> = [];
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      const op = classifications[i]!;
      perStmt.push({ stmt, op, result: this._decideOne(stmt, op) });
    }

    // Pick the strictest decision; break ties by first occurrence so the
    // reason and op reflect the earliest culprit (predictable messaging).
    let winner = perStmt[0]!;
    for (const entry of perStmt.slice(1)) {
      if (_DECISION_RANK[entry.result.decision] > _DECISION_RANK[winner.result.decision]) {
        winner = entry;
      }
    }

    // For a present_only compound, substitute the formatted whole-compound so
    // the human who runs it manually gets every statement, not just the
    // write/delete/admin half.
    let final = winner.result;
    if (statements.length > 1 && final.decision === "present_only") {
      const combined = perStmt.map((e) => _formatStatement(e.stmt)).join("; ") + ";";
      final = { ...final, formatted_sql: combined };
    }

    // Emit one audit event for the combined decision. Tagging with the
    // winner's op makes the event legible ("policy_deny op=admin because an
    // ADMIN statement was present") without flooding the log with per-stmt
    // entries for every compound query.
    if (final.decision === "deny") {
      _emitDeny(final.reason, winner.op);
    } else if (final.decision === "escalate") {
      _emitEscalate(final.reason, winner.op);
    } else if (final.decision === "present_only") {
      _emitPresentOnly(final.reason, winner.op, final.formatted_sql);
    } else if (winner.op !== OperationType.READ) {
      // READ allow is deliberately not audited (matches prior behavior);
      // write/delete allow is, so symmetry with present_only/deny holds.
      _emitAllow(winner.op);
    }

    return final;
  }

  /**
   * Single-statement decision path. Factored out so compound handling can
   * call it per sub-statement without emitting audit events (those are
   * consolidated into one emission after combining). Compatible with the
   * driver-provided path: when a non-SQL driver supplies its own
   * `classifyOperation`, the whole query string flows through here.
   */
  private _decideOne(stmt: string, op: OperationType): PolicyResult {
    const rule = this._rules[op];
    if (rule === "deny") {
      return { decision: "deny", reason: _denyReason(op) };
    }
    if (rule === "escalate") {
      return { decision: "escalate", reason: _escalateReason(op) };
    }
    if (rule === "present") {
      const formatted = _formatStatement(stmt);
      return { decision: "present_only", reason: _presentReason(op), formatted_sql: formatted };
    }
    // rule === "allow"
    if (op === OperationType.READ) {
      return this._checkRead(stmt);
    }
    // Config validation prevents "allow" from reaching ADMIN/PRIVILEGE; only
    // WRITE/DELETE remain.
    return { decision: "allow", reason: `${op.toUpperCase()} allowed by policy` };
  }

  /**
   * Driver-provided path: the caller owns classification (possibly via a
   * JSON envelope for MongoDB/DynamoDB). Emits the audit event itself since
   * we're not aggregating across multiple sub-statements here.
   */
  private _checkSingleStatement(
    stmt: string,
    driver: DatabaseDriver,
  ): PolicyResult {
    let op: OperationType;
    try {
      op = driver.classifyOperation(stmt);
    } catch (exc) {
      const reason = (exc as Error).message;
      _emitDeny(reason, null);
      return { decision: "deny", reason };
    }
    const result = this._decideOne(stmt, op);
    if (result.decision === "deny") _emitDeny(result.reason, op);
    else if (result.decision === "escalate") _emitEscalate(result.reason, op);
    else if (result.decision === "present_only") _emitPresentOnly(result.reason, op, result.formatted_sql);
    else if (op !== OperationType.READ) _emitAllow(op);
    return result;
  }

  /** Apply approval-mode logic for READ operations. */
  private _checkRead(sql: string): PolicyResult {
    // Unbounded safety check — operator can opt out via
    // policy.unbounded_select: 'allow' (default 'escalate').
    if (
      this._rules.unbounded_select !== "allow" &&
      Policy._isUnboundedSelect(sql)
    ) {
      return {
        decision: "escalate",
        reason: "Unbounded SELECT detected -- add WHERE or LIMIT",
      };
    }

    const mode = this._approval_mode;

    if (mode === "auto") {
      return { decision: "allow", reason: "auto-approved" };
    }

    if (mode === "confirm_once") {
      if (this._session_approved) {
        return { decision: "allow", reason: "session approved" };
      }
      return {
        decision: "escalate",
        reason: "First read requires confirmation (confirm_once)",
      };
    }

    if (mode === "confirm_each") {
      return {
        decision: "escalate",
        reason: "Each read requires confirmation (confirm_each)",
      };
    }

    if (mode === "grant_required") {
      if (this.isGrantActive("read")) {
        return { decision: "allow", reason: "active read grant" };
      }
      return { decision: "deny", reason: "No active read grant" };
    }

    // Unreachable given the constructor guard, but defensive:
    return { decision: "deny", reason: `Unknown mode: ${mode}` };
  }

  // ------------------------------------------------------------------
  // Session & grant management
  // ------------------------------------------------------------------

  /** Mark the current session as approved (for confirm_once mode). */
  approveSession(): void {
    this._session_approved = true;
  }

  /**
   * Add a time-limited grant.
   *
   * G-DB-AUDIT: emits a `grant_added` event with the grant type and TTL.
   *
   * Lifetime scope: grants are in-process only. Expiry is measured with
   * `performance.now()`, which is reset on every Node process start, so
   * a new CLI invocation always begins with no active grants — even if
   * a previous run added one seconds ago. Suitable for the CLI's
   * single-invocation model; not suitable as a cross-process gate.
   */
  addGrant(grantType: string, ttlSeconds: number = 300): void {
    // performance.now() is process-relative; see JSDoc for lifetime scope.
    this._grants.set(grantType, performance.now() + ttlSeconds * 1000);
    logEvent({
      event_type: "grant_added",
      details: { grant_type: grantType, ttl_seconds: ttlSeconds },
    });
  }

  /**
   * Check whether a grant is currently active (not expired).
   *
   * G-DB-AUDIT: emits a single `grant_expired` event the first time an
   * expired grant is observed (subsequent checks are silent so the audit
   * log isn't spammed by repeated polling).
   */
  isGrantActive(grantType: string): boolean {
    const expiry = this._grants.get(grantType);
    if (expiry === undefined) return false;
    if (performance.now() < expiry) return true;
    if (!this._expired_logged.has(grantType)) {
      this._expired_logged.add(grantType);
      logEvent({
        event_type: "grant_expired",
        details: { grant_type: grantType },
      });
    }
    return false;
  }
}

/**
 * Issue a time-limited grant whose TTL derives from an environment's
 * `grant_duration_hours` field (v2 design §4 default: 8 hours).
 *
 * This is the recommended API for prod callers — `addGrant` remains the
 * low-level primitive (5-minute default, used for short-lived operations
 * like test scaffolding and administrative confirmations).
 *
 * Lifetime scope: grants live in memory only. Because `addGrant` uses
 * `performance.now()` — a process-relative monotonic clock — a grant
 * written in one CLI invocation does NOT carry into the next one, even
 * if `grant_duration_hours=8`. The "8 hour" default means "up to 8
 * wall-clock hours within a single long-running session," not "8
 * wall-clock hours across reboots." Persisting grants to disk is out
 * of scope for v2.
 */
export function grantFromEnv(
  policy: Policy,
  env: { grant_duration_hours?: number },
  grantType: string,
): void {
  const hours = env.grant_duration_hours ?? 8;
  policy.addGrant(grantType, hours * 3600);
}

/**
 * G-DB-AUDIT: emit a `policy_deny` event with the deny reason and the
 * SQL operation type (when known). The audit module no-ops when audit
 * has not been enabled, so this is safe to call unconditionally.
 */
function _emitDeny(reason: string, op: OperationType | null): void {
  const details: Record<string, unknown> = { reason };
  if (op !== null) details["op"] = op;
  logEvent({ event_type: "policy_deny", details });
}

/** Emit a `policy_allow` audit event tagged with the operation type. */
function _emitAllow(op: OperationType): void {
  logEvent({ event_type: "policy_allow", details: { op } });
}

/**
 * Symmetric to `_emitDeny` / `_emitPresentOnly`: record a `policy_escalate`
 * event when the policy returns `escalate`. Without this, a blocked-pending-
 * approval path leaves an empty audit trail, making "no write happened" hard
 * to prove positively — the viewer's absence-of-write check sees nothing to
 * distinguish from "CLI never ran". The `op` tag lets consumers filter
 * read-escalation (grant_required / unbounded SELECT) from write-escalation.
 */
function _emitEscalate(reason: string, op: OperationType | null): void {
  const details: Record<string, unknown> = { reason };
  if (op !== null) details["op"] = op;
  logEvent({ event_type: "policy_escalate", details });
}

/** Default deny reason per operation type (stable strings used by evals). */
function _denyReason(op: OperationType): string {
  if (op === OperationType.ADMIN) return "ADMIN statements are never allowed";
  if (op === OperationType.PRIVILEGE) return "PRIVILEGE statements are never allowed";
  if (op === OperationType.WRITE) return "WRITE statements are not allowed";
  if (op === OperationType.DELETE) return "DELETE statements are not allowed";
  return "READ statements are not allowed";
}

function _escalateReason(op: OperationType): string {
  return `${op.toUpperCase()} statements require approval`;
}

function _presentReason(op: OperationType): string {
  return `${op.toUpperCase()} statements are displayed but not executed`;
}

/**
 * Strip comments and uppercase the leading keyword for readability when
 * echoing a statement back to the caller in a `present_only` response.
 */
function _formatStatement(sql: string): string {
  let formatted = Policy._stripComments(sql.trim());
  const parts = formatted.split(/\s+/);
  const first = parts[0];
  if (first !== undefined) {
    if (parts.length > 1) {
      const rest = parts.slice(1).join(" ");
      formatted = first.toUpperCase() + " " + rest;
    } else {
      formatted = first.toUpperCase();
    }
  }
  return formatted;
}

/**
 * Symmetric to `_emitDeny`: emit a `policy_present_only` event when a
 * write/delete/admin statement is intercepted and returned as formatted
 * SQL rather than executed. Without this, the "no write event occurred"
 * audit assertion on PRESENT_ONLY paths passes vacuously — an empty
 * audit log also has no writes. Recording the policy decision gives
 * downstream consumers (and eval graders) a positive signal that the
 * decision actually fired.
 *
 * The `formatted_sql` is truncated to a reasonable length so the audit
 * file doesn't bloat on long INSERTs; the full SQL is already in the
 * API response.
 */
function _emitPresentOnly(
  reason: string,
  op: OperationType | null,
  formattedSql: string,
): void {
  // Scrub credentials before truncation so a literal split by truncation
  // can't leak. Same helper used by audit.logQuery.
  const scrubbed = scrubSqlSecrets(formattedSql);
  const truncated =
    scrubbed.length > 500
      ? scrubbed.slice(0, 500) + "\u2026"
      : scrubbed;
  const details: Record<string, unknown> = {
    reason,
    formatted_sql: truncated,
  };
  if (op !== null) details["op"] = op;
  logEvent({ event_type: "policy_present_only", details });
}

/**
 * Serialize a PolicyResult to JSON.
 *
 * Key order: decision, reason, (formatted_sql only when decision ===
 * "present_only"). V8 preserves string-key insertion order so explicit
 * construction is sufficient.
 */
export function policyResultJson(result: PolicyResult): string {
  if (result.decision === "present_only") {
    return JSON.stringify({
      decision: result.decision,
      reason: result.reason,
      formatted_sql: result.formatted_sql,
    });
  }
  return JSON.stringify({
    decision: result.decision,
    reason: result.reason,
  });
}
