/**
 * audit.ts — Audit logging for wiki_db (JSONL format, non-failing).
 *
 * Mirrors `audit.py`:
 *  - Module-level state holds `enabled`, `path`, and `session_id`.
 *  - `enableAudit` / `disableAudit` toggle the state.
 *  - `logQuery` / `logEvent` append a single JSON line each; errors are
 *    swallowed so logging never raises into the caller.
 *
 * JSONL format parity: JSON.stringify uses compact separators (",", ":"),
 * which matches Python's `json.dumps(record)` output byte-for-byte for
 * dict+string+number payloads. Keys appear in insertion order in both
 * languages.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Module-level state
const _state = {
  enabled: false as boolean,
  path: null as string | null,
  sessionId: null as string | null,
};

/**
 * Enable audit logging to `path` (JSONL file).
 * If `sessionId` is not provided, a random 12-char hex string is generated.
 */
export function enableAudit(filePath: string, sessionId?: string | null): void {
  _state.enabled = true;
  _state.path = filePath;
  // Create the parent directory up front so the first append does not
  // silently drop the record when the directory is missing. Wrapped so
  // enableAudit preserves its never-throw contract.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // best-effort; a write failure later is still swallowed in _writeRecord
  }
  _state.sessionId =
    sessionId !== undefined && sessionId !== null
      ? sessionId
      // Python: secrets.token_hex(6) → 12 hex chars.
      : crypto.randomBytes(6).toString("hex");
}

/** Disable audit logging and clear state. */
export function disableAudit(): void {
  _state.enabled = false;
  _state.path = null;
  _state.sessionId = null;
}

/** Append a JSON record to the audit file. Never raises.
 *
 *  Uses JSON.stringify (compact form) so each record fits on one line.
 */
function _writeRecord(record: Record<string, unknown>): void {
  if (!_state.enabled || _state.path === null) return;
  try {
    // fs.appendFileSync creates the file if missing but NOT parent dirs,
    // matching Python's `open(path, "a")` semantics.
    fs.appendFileSync(_state.path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // best-effort, same as Python's `except OSError: pass`
  }
}

/**
 * Python-compatible ISO-8601 UTC timestamp with trailing "Z".
 *
 * Python's `datetime.datetime.utcnow().isoformat() + "Z"` produces a
 * format like `"2026-04-12T10:55:50.123456"` (microseconds) + `"Z"`.
 * JS's `Date().toISOString()` yields `"2026-04-12T10:55:50.123Z"`
 * (millisecond precision). Both are valid ISO-8601 so downstream parsers
 * accept them; the test only checks for the key's presence.
 */
function _isoTimestamp(): string {
  // Strip trailing Z that toISOString includes, then re-append to match
  // Python's explicit `+ "Z"` composition.
  const iso = new Date().toISOString();
  return iso.endsWith("Z") ? iso : iso + "Z";
}

export interface LogQueryParams {
  env: string;
  query: string;
  status: string;
  row_count: number;
  execution_time_ms: number;
  error?: string | null;
  context?: string | null;
}

/**
 * Mask values of common credential-bearing identifiers in a SQL string.
 *
 * Catches `password='…'`, `token="…"`, `api_key='…'`, etc. so that
 * read-only queries against the user's own DB don't persist embedded
 * credentials to events.jsonl. Intentionally only handles complete
 * single/double-quoted literals — partial or concatenated literals are
 * out of scope.
 */
// Key/separator are captured as distinct groups so the original separator
// (e.g. `:` for JSON, `=` for SQL/env) is preserved verbatim — hard-coding
// `=` would mangle `{"password":"x"}` into `{"password"='[REDACTED]'}` and
// break downstream consumers parsing events.jsonl as JSON-per-line.
//
// Leading/trailing `\b` keeps `mytoken='x'` and `notpassword='x'` from being
// spuriously redacted just because they end in a sensitive keyword.
//
// Value classes use `(?:\\.|[^Q\\])*` so `\"` and other escape sequences
// inside JSON-encoded values are skipped — without this, `"abc\"def"`
// terminates at the escaped quote and leaks the tail.
//
// AUTH redaction is split into two anchored patterns:
//   QUOTED_RE — preceded by `"` or `'` (JSON key or string-value context);
//     the unquoted-value branch's value class `[^"'\r\n]+` stops at any
//     quote so it can't consume past the outer JSON closing quote.
//   LINE_RE — anchored to `^` or `\r\n` (HTTP header / env line); value
//     class is `[^\r\n]+` so Digest's embedded quoted params are
//     fully consumed.
// Anchoring avoids the regression where a mid-string match on
// `{"message":"authorization: …"}` swallowed the trailing `"}` and
// produced unterminated JSON.
const _SENSITIVE_KEYS = "password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|auth";
const _SENSITIVE_LITERAL_SQUOTE_RE = new RegExp(
  `("?\\b(?:${_SENSITIVE_KEYS})\\b"?)(\\s*[:=]\\s*)'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'`,
  "gi",
);
const _SENSITIVE_LITERAL_DQUOTE_RE = new RegExp(
  `("?\\b(?:${_SENSITIVE_KEYS})\\b"?)(\\s*[:=]\\s*)"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"`,
  "gi",
);
const _SENSITIVE_AUTH_QUOTED_RE =
  /(?<=["'])(\bauthorization\b)("?)(\s*[:=]\s*)(?:(["'])((?:bearer|basic)\s+)?(?:[^\r\n\\]|\\.)*?\4|((?:bearer|basic)\s+)?[^"'\r\n]+)/gi;
const _SENSITIVE_AUTH_LINE_RE =
  /(?:^|(?<=[\r\n]))(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?[^\r\n]+/gi;

export function scrubSqlSecrets(sql: string): string {
  return sql
    .replace(
      _SENSITIVE_LITERAL_SQUOTE_RE,
      (_m, key: string, sep: string) => `${key}${sep}'[REDACTED]'`,
    )
    .replace(
      _SENSITIVE_LITERAL_DQUOTE_RE,
      (_m, key: string, sep: string) => `${key}${sep}"[REDACTED]"`,
    )
    .replace(
      _SENSITIVE_AUTH_QUOTED_RE,
      (
        _m,
        kw: string,
        keyQuote: string,
        sep: string,
        valQuote: string | undefined,
        schemeQ: string | undefined,
        schemeU: string | undefined,
      ) => {
        if (valQuote !== undefined) {
          return `${kw}${keyQuote}${sep}${valQuote}${schemeQ || ""}[REDACTED]${valQuote}`;
        }
        return `${kw}${keyQuote}${sep}${schemeU || ""}[REDACTED]`;
      },
    )
    .replace(
      _SENSITIVE_AUTH_LINE_RE,
      (_m, kw: string, sep: string, scheme: string | undefined) =>
        `${kw}${sep}${scheme || ""}[REDACTED]`,
    );
}

/** Log a query execution event. */
export function logQuery(params: LogQueryParams): void {
  const record: Record<string, unknown> = {
    event_type: "query",
    timestamp: _isoTimestamp(),
    session_id: _state.sessionId,
    env: params.env,
    // Scrub before truncate so a credential split by truncation can't leak.
    query: scrubSqlSecrets(params.query).slice(0, 2000),
    status: params.status,
    row_count: params.row_count,
    execution_time_ms: params.execution_time_ms,
  };
  if (params.error !== undefined && params.error !== null) {
    record["error"] = params.error;
  }
  if (params.context !== undefined && params.context !== null) {
    record["context"] = params.context;
  }
  _writeRecord(record);
}

export interface LogEventParams {
  event_type: string;
  details?: Record<string, unknown> | null;
}

/** Log a non-query event (e.g. connect, schema_inspect). */
export function logEvent(params: LogEventParams): void {
  const record: Record<string, unknown> = {
    event_type: params.event_type,
    timestamp: _isoTimestamp(),
    session_id: _state.sessionId,
  };
  if (params.details !== undefined && params.details !== null) {
    record["details"] = params.details;
  }
  _writeRecord(record);
}

/** Internal: state snapshot exposed only for tests. */
export function _auditState(): {
  enabled: boolean;
  path: string | null;
  sessionId: string | null;
} {
  return {
    enabled: _state.enabled,
    path: _state.path,
    sessionId: _state.sessionId,
  };
}
