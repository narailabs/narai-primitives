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
// Key boundaries are NOT plain `\b`. `_` is a word character, so `\btoken\b`
// never matches `session_token` and `\bsecret\b` / `\baccess[_-]?key\b` both
// miss `secret_access_key` — the exact field names `src/connectors/aws/cli.ts`
// writes. Measured on this function before the fix: `secret_access_key`,
// `session_token`, `secretAccessKey`, `refresh_token` and `client_secret` all
// passed through with the credential intact.
//
// An earlier revision of this paragraph added "while the toolkit's own
// `scrubSecrets` redacted every one of them." That was measured against a tree
// carrying #207 and is FALSE of this branch, where the toolkit copy still has
// the old `\b` form and leaks all five — re-measured here rather than
// reasoned about. Retracted rather than reworded, because a comment asserting
// that the unfixed scrubber is already safe is worse than no comment: it tells
// the next reader the other copy needs nothing.
//
// Requiring a non-alphanumeric neighbour instead admits the `_`/`-` compound
// forms while still rejecting the run-on words `\b` was there to protect
// (`mytoken`, `notpassword`, `xsecret`), where the neighbour is a letter.
// camelCase compounds are handled by the prefix list rather than by loosening
// the boundary: these patterns are built with `i`, which case-folds `[A-Z]`,
// so a `(?<=[a-z0-9])(?=[A-Z])` rule degrades to "letter followed by letter"
// and starts redacting `mytoken` again.
//
// This matches the boundary `src/toolkit/audit/writer.ts` uses. Note the tense:
// as of THIS branch the toolkit copy still has the old `\b` form — the matching
// fix for it is in #207, which is not merged yet. So on `main` today both
// copies leak; when #207 lands the toolkit is fixed; when this lands the db
// copy is fixed; and only with both do they actually mirror each other. Do not
// read this comment as an assertion that they are in step right now.
//
// The two must stay in step, and the fact that they did not is why this bug
// existed — see the note above `scrubSqlSecrets`.
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
/**
 * `private[_-]?key` is named explicitly rather than by adding a bare `key`
 * alternative: `_KEY_PREFIX` can consume `private`, but with no `key` word to
 * complete it a service-account credential rendered as `private_key='…'`
 * passed through intact. A bare `key` would also redact `primary_key`,
 * `sort_key` and `partition_key` — ordinary SQL, and redacting them would
 * destroy the query this audit log exists to record.
 *
 * The matching change to `SENSITIVE_WORDS` in `src/toolkit/audit/writer.ts`
 * is in #207; neither copy has it on `main` yet.
 */
const _SENSITIVE_KEYS =
  "password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|private[_-]?key|auth";
/** Credential-word prefixes, so `secret_access_key` and `secretAccessKey` both reduce to a known prefix plus a known key. */
const _KEY_PREFIX = "(?:(?:secret|session|access|refresh|client|api|auth|private)[_-]?)?";
/** A non-alphanumeric neighbour, or the string edge — `\b`'s job without treating `_` as a letter. */
/**
 * The quote around the key is single OR double. A Python-style repr of a
 * credential object reaches a SQL audit log as readily as JSON does — a JSONB
 * literal, or an ORM echoing its parameters — and `"?` matched none of it, so
 * the key never terminated and `{'session_token': 'hunter2'}` wrote the
 * credential to events.jsonl in the clear. Measured across a key x wrapper
 * cross-product: of the shapes still leaking after the compound-key fix, this
 * one accounted for 21 on its own, plain `password` included.
 *
 * Same job as `KQ` in `src/toolkit/audit/writer.ts`, without its escape-run
 * branch: the db copy has no escaped-value pattern to pair one with, so
 * admitting an escaped key quote here would match a key whose value it then
 * could not read. That shape stays open — see the note above `scrubSqlSecrets`.
 */
const _KQ = "[\"']?";
const _KEY_START = "(?<![A-Za-z0-9])";
const _KEY_END = "(?![A-Za-z0-9])";
/**
 * The SQL-doubled form of the same shapes.
 *
 * A Python-style object embedded in a SQL single-quoted literal must double
 * its own apostrophes — `UPDATE t SET x = '{''session_token'': ''hunter2''}'`
 * is the valid SQL for it. The single-quote pattern below reads `''hunter2''`
 * as an EMPTY literal followed by `hunter2''`, so it matched, redacted
 * nothing, and wrote the credential to events.jsonl.
 *
 * The value is `''(?:[^']|'')*?''(?=\s*[,}]|$)` and every part of that earns
 * its place, because `''` is genuinely ambiguous here: it is an escaped
 * apostrophe INSIDE a value and also the quote that ENDS one, and the two
 * readings pull in opposite directions.
 *
 * `[^']*` alone took the first reading's opposite and stopped at the first
 * `''` inside a value, so a secret containing an escaped apostrophe was
 * half-redacted and its tail stayed in the log: `''abc''''def''` came back as
 * `''[REDACTED]''''def''`. A GREEDY `(?:[^']|'')*` then took the other extreme
 * and ran to the last `''` in the statement, swallowing every field after the
 * secret — `{''password'': ''p'', ''user'': ''bob''}` lost `''user'': ''bob''`
 * entirely. Both are the same mistake: resolving the ambiguity by quantifier
 * greed rather than by what actually distinguishes the two cases.
 *
 * What distinguishes them is STRUCTURE, and it takes both halves of a run
 * boundary to say it. A value's closing `''` is a run of exactly two, and it
 * is followed by a field separator or the end of the object; an embedded one
 * is part of a longer run, or is followed by more value.
 *
 * The lookahead alone was not enough. In `''abc'''',def''` — the encoding of
 * the secret `abc',def` — the last two quotes of the four ARE followed by a
 * comma, so a comma-only rule ended the value there and left `,def` in the
 * log. The `(?<!')` is what says "this pair is a run of its own, not the tail
 * of a longer one". With both, `abc''def` continues (followed by `d`),
 * `abc'''',def` continues (the pair is inside a four-run), and `p''` ends
 * (a lone pair, followed by a comma).
 *
 * Runs BEFORE the single-quote pattern so the doubled form is consumed first.
 *
 * The doubled key quotes are REQUIRED, not optional. Optional, the pattern
 * had no left anchor and read two ordinary empty literals as one doubled
 * value: `UPDATE t SET password = '' WHERE note = ''` came back as
 * `UPDATE t SET password = '[REDACTED]'[REDACTED]''`, deleting `WHERE note = `
 * from the audit record. Over-matching is safe for a value and not for the
 * statement carrying it, and an audit log that rewrites the query has lost
 * the thing it exists to keep. Requiring them also says what the pattern is
 * for: an object embedded in a literal, where both key and value are doubled.
 * A bare key inside one cannot arise — JSON and Python reprs both quote keys.
 *
 * Found because the test written for the single-quote fix called
 * `.replace(/''/g, "'")` on its own input, converting the doubled form to the
 * plain one and asserting against a shape that never reaches the database.
 * The test is corrected alongside this.
 */
const _SENSITIVE_LITERAL_SQUOTE_DOUBLED_RE = new RegExp(
  `(''${_KEY_START}${_KEY_PREFIX}(?:${_SENSITIVE_KEYS})${_KEY_END}'')(\\s*[:=]\\s*)''(?:[^']|'')*?(?<!')''(?=\\s*[,}]|$)`,
  "gi",
);
const _SENSITIVE_LITERAL_SQUOTE_RE = new RegExp(
  `(${_KQ}${_KEY_START}${_KEY_PREFIX}(?:${_SENSITIVE_KEYS})${_KEY_END}${_KQ})(\\s*[:=]\\s*)'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'`,
  "gi",
);
const _SENSITIVE_LITERAL_DQUOTE_RE = new RegExp(
  `(${_KQ}${_KEY_START}${_KEY_PREFIX}(?:${_SENSITIVE_KEYS})${_KEY_END}${_KQ})(\\s*[:=]\\s*)"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"`,
  "gi",
);
const _SENSITIVE_AUTH_QUOTED_RE =
  /(?<=["'])(\bauthorization\b)("?)(\s*[:=]\s*)(?:(["'])((?:bearer|basic)\s+)?(?:\\.|[^\r\n\\])*?\4|((?:bearer|basic)\s+)?[^"'\r\n]+)/gi;
const _SENSITIVE_AUTH_LINE_RE =
  /(?:^|(?<=[\r\n]))(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?[^\r\n]+/gi;

export function scrubSqlSecrets(sql: string): string {
  return sql
    .replace(
      _SENSITIVE_LITERAL_SQUOTE_DOUBLED_RE,
      (_m, key: string, sep: string) => `${key}${sep}''[REDACTED]''`,
    )
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
