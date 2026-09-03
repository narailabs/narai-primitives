/**
 * JSONL audit writer. Instance-per-connector (no module-global state).
 *
 * Non-failing: any disk I/O error is swallowed. Audit MUST NEVER crash the
 * caller — a missing audit trail is better than a missing feature.
 *
 * Secret redaction: `scrubSecrets(str)` masks common `password='...'` /
 * `token='...'` / `api_key='...'` literals before writing. Called on
 * caller-supplied strings that might contain credentials.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEvent } from "./events.js";

export interface AuditWriterOptions {
  enabled: boolean;
  /** Absolute path to the JSONL file. Required when `enabled` is true. */
  path?: string;
  /** Fixed session id (tests). If omitted, a random 12-char hex is generated. */
  sessionId?: string;
}

/**
 * Redact common credential-bearing `key='value'` literals in a string.
 *
 * Key/separator are captured as distinct groups so the original separator
 * (e.g. `:` for JSON payloads, `=` for SQL or env-style) is preserved
 * verbatim — hard-coding `=` would mangle `{"password":"x"}` into
 * `{"password"='[REDACTED]'}` and break downstream JSON-per-line parsers.
 *
 * The `\b` boundaries ensure we only match the sensitive keyword as a
 * complete word (or wrapped in JSON quotes), so `mytoken='x'` and
 * `notpassword='x'` don't get spuriously redacted.
 *
 * Value classes use `(?:\\.|[^Q\\])*` (Q = the active quote) so escape
 * sequences like `\"` inside JSON-encoded values are skipped rather than
 * treated as the closing quote.
 *
 * AUTH redaction uses two anchored patterns instead of one unanchored one:
 *
 *   QUOTED_RE — preceded by `"` or `'` (JSON key OR string-value context).
 *     Value class is `[^"'\r\n]+` so the unquoted branch can't consume
 *     past the JSON value's closing quote and mangle the outer payload.
 *
 *   LINE_RE — anchored to `^` or `\r\n` (HTTP-header / env form). Value
 *     class is `[^\r\n]+` so Digest parameters with embedded quotes
 *     (`Digest username="u", response="…"`) are fully consumed.
 *
 * Anchoring to a field boundary avoids the regression from a single
 * unanchored pattern, where `{"message":"authorization: Bearer abc"}`
 * matched mid-string and the greedy unquoted value class swallowed the
 * trailing `"}`, producing unterminated JSON.
 */
/**
 * `private[_-]?key` is listed explicitly rather than by adding a bare `key`
 * alternative. `KEY_PREFIX` can already consume `private`, but with no `key`
 * word to complete it a service-account credential rendered as
 * `private_key="…"` (or `privateKey`, as SDKs emit it) passed through intact.
 * A bare `key` would fix that and also redact `primary_key`, `sort_key` and
 * every other ordinary `*_key` column, which is why the compound is named.
 */
const SENSITIVE_WORDS =
  "password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|private[_-]?key|auth";
/**
 * Key boundaries. Plain `\b` is wrong here because `_` is a word character,
 * so `\btoken\b` misses `session_token` and `\bsecret\b` /
 * `\baccess[_-]?key\b` both miss `secret_access_key` — the exact field names
 * `src/connectors/aws/cli.ts` uses for AWS credentials.
 *
 * Requiring a non-alphanumeric neighbour instead admits the `_`/`-` joined
 * compound forms while still rejecting the run-on words `\b` was added to
 * protect (`mytoken`, `notpassword`, `xsecret`), where the neighbour is a
 * letter.
 *
 * camelCase compounds are handled by KEY_PREFIX rather than by loosening these
 * boundaries. Widening KEY_START to admit a lowercase-to-uppercase transition
 * looks like the general rule, but these patterns are built with `i`: the `i`
 * flag case-folds `[A-Z]`, so `(?<=[a-z0-9])(?=[A-Z])` degrades to "letter
 * followed by letter" and starts redacting `mytoken` and `notpassword` — the
 * exact run-on words the boundary exists to reject. Measured, not assumed.
 */
/**
 * Credential-word prefixes, so a compound key matches whichever way it is
 * spelled: `secret_access_key` (CLI/env), `secretAccessKey` (JS objects) and
 * `secret-access-key` all reduce to a known prefix plus a known key.
 *
 * SDK and custom errors render JavaScript credential objects, so the same
 * fields that `src/connectors/aws/cli.ts` writes as snake_case arrive from the
 * SDK as camelCase. Enumerating the prefixes keeps the run-on protection that
 * a case-based rule loses: `my` is not a credential word, so `mytoken` still
 * falls through to KEY_START and is still rejected.
 */
const KEY_PREFIX = "(?:(?:secret|session|access|refresh|client|api|auth|private)[_-]?)?";
/**
 * Optional quote around the key: single or double, escaped or not. Single
 * quotes matter because a Python-style repr of a credential object
 * (`{'password': 'hunter2'}`) reaches these logs as readily as JSON does. A serialized object embedded
 * in another string arrives with its key quotes escaped as well
 * (`request payload: {\\"password\\":\\"hunter2\\"}`), and a key group that
 * accepted only a bare `"` matched none of it — so the escaped *value* branch
 * never got a chance to run and the whole object leaked.
 */
const KQ = '(?:\\\\?["\'])?';
const KEY_START = "(?<![A-Za-z0-9])";
const KEY_END = "(?![A-Za-z0-9])";
/**
 * The quoted-value bodies use the loop-unrolled form `[^'\\]*(?:\\.[^'\\]*)*`
 * rather than the equivalent `(?:[^'\\]|\\.)*`. Both are linear here — the two
 * alternatives are disjoint on their first character, so no ambiguous
 * decomposition exists — but #95 rewrites these same two lines to the unrolled
 * form, and it edits them off `main`, i.e. without KEY_START/KEY_END. Carrying
 * the unrolled body here makes this branch a strict superset of #95 on these
 * lines, so resolving that conflict in either direction keeps the compound-key
 * boundary fix. Taking #95's side otherwise silently restores `\b` and stops
 * redacting `secret_access_key` / `session_token`.
 */
const SENSITIVE_SQUOTE_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)'(?:[^'\\\\]*(?:\\\\.[^'\\\\]*)*(')|[^\\r\\n]*)`,
  "gi",
);
const SENSITIVE_DQUOTE_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)"(?:[^"\\\\]*(?:\\\\.[^"\\\\]*)*(")|[^\\r\\n]*)`,
  "gi",
);
/**
 * Authorization with a backslash-escaped quoted value, and optionally an
 * escaped quote around the keyword too — the nested-serialization form, same
 * as SENSITIVE_ESCAPED_QUOTE_RE handles for the other credential keys.
 *
 * This exists because the escaped form had to be added to each pattern family
 * separately, and the Authorization family was missed twice. Runs first, so
 * the balanced and unquoted branches below only ever see unescaped text.
 */
/**
 * A parameterised auth header (`Authorization: Digest username="alice",
 * response="…"`). The value is a comma-separated list of `key="value"` pairs
 * rather than one token, so every other branch stopped at the first quote and
 * left the `response` credential standing.
 *
 * The line-anchored pattern already covered this by consuming to end of line,
 * which is why the gap only ever showed up mid-string. This branch is the
 * bounded equivalent: it consumes only well-formed `key="value"` pairs joined
 * by commas, so it cannot run past the header into a surrounding payload the
 * way an end-of-line rule would.
 *
 * The whole parameter list is redacted, including `username` and `nonce`.
 * Over-redacting a header whose interesting field is the credential is the
 * safe direction, and it matches what the line-anchored branch already does.
 */
const SENSITIVE_AUTH_PARAMS_RE =
  /(\\?["']?)(\bauthorization\b)(\\?["']?)(\s*[:=]\s*)([A-Za-z]+\s+)?\w+\s*=\s*(?:(\\?["'])[^\r\n]*?\6|[^\s,"'\r\n\]}]+)(?:\s*,\s*\w+\s*=\s*(?:(\\?["'])[^\r\n]*?\7|[^\s,"'\r\n\]}]+))+/gi;
const SENSITIVE_AUTH_ESCAPED_RE =
  /(\\?["']?)(\bauthorization\b)(\\?["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?\\(["'])((?:bearer|basic)\s+)?(?:\\\\.|(?!\\\6)[^\r\n])*(\\\6)?/gi;
const SENSITIVE_AUTH_QUOTED_RE =
  /(?<=["'])(\bauthorization\b)(\\?["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\5)[^\r\n\\])*(\5)|[^\r\n]*)|[^"'\r\n\\]+)/gi;
const SENSITIVE_AUTH_LINE_RE =
  /(?:^|(?<=[\r\n]))(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?[^\r\n]+/gi;
/**
 * INLINE_RE — the third context: a header embedded mid-string with a prefix,
 * as thrown messages routinely are (`request failed: Authorization: Bearer
 * abc.def`). QUOTED_RE needs a preceding quote and LINE_RE needs a line
 * start, so neither fires and the token reached stdout intact.
 *
 * Runs after both, so by this point the only `authorization` occurrences
 * left are the unanchored ones.
 *
 * The value is an alternation, not one class. A *balanced* quoted run comes
 * first: it stops at its own closing quote, so it cannot consume past a JSON
 * value's end and mangle the outer payload — the safety property the original
 * single-unanchored-pattern regression lacked. The unquoted class (excluding
 * `"` and `'`) is the fallback.
 *
 * An unquoted-only class was not enough. `Authorization: "Bearer abc123"`
 * stopped at the opening quote and redacted the separator whitespace instead
 * of the token, yielding `Authorization:[REDACTED]"Bearer abc123"` with the
 * credential intact. The scheme is captured on both sides of the quote,
 * because it appears in both `Authorization: "Bearer x"` and
 * `Authorization: Bearer "x"`.
 *
 * The rule the quoted branch encodes, stated once so it does not need another
 * narrower case bolted on: **the value runs to its terminator, and an absent
 * terminator is the end of the line.** A truncated message
 * (`Authorization: "Bearer abc123` — no closing quote) has nothing structured
 * after it to protect, because everything that follows is inside the unclosed
 * string. So the balanced form is preferred when it exists, and end-of-line is
 * the fallback. The closing quote is captured rather than assumed, so the
 * replacement re-emits one only when the source actually had one.
 *
 * Re-running over already-redacted text is a no-op in every branch.
 */
const SENSITIVE_AUTH_INLINE_RE =
  /(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\4)[^\r\n\\])*(\4)|[^\r\n]*)|[^"'\r\n\\]+)/gi;
/**
 * Unquoted-value form (`password:hunter2`). Parser errors echo the offending
 * source fragment, so `--params '{"password":hunter2}'` surfaces the raw
 * value in a `JSON.parse` message that the quoted patterns above skip.
 *
 * Runs LAST so already-redacted quoted values are inert: neither position
 * admits `"` or `'`, so `password='[REDACTED]'` no longer matches.
 *
 * The value is split into two positions rather than one `+` class:
 *
 *   first char — excludes whitespace, quotes, and the structure openers
 *     `{` / `[`. Openers must not match: `{"token":[1,2]}` is well-formed
 *     and redacting from `[` would stop at the inner `,` and mangle the
 *     array. Closers and separators (`,;)]}`) ARE admitted here, because
 *     valid JSON never places one directly after `:` for a scalar field —
 *     if one appears, the text is already malformed, which is exactly the
 *     parser-echo case, and redacting is the safe direction.
 *
 *   rest — excludes the delimiters too, so the match stops at the end of
 *     the field rather than swallowing the payload tail. This is the same
 *     greedy-consumption regression the AUTH anchoring above guards against.
 *
 * Excluding delimiters from BOTH positions was the earlier bug: a value that
 * *begins* with one (`{"password":)hunter2}`) failed to match at all and
 * leaked whole.
 *
 * The first position also excludes `\`, because a backslash-led value is the
 * escaped-quote form that SENSITIVE_ESCAPED_QUOTE_RE consumes just above.
 * Without that exclusion this pattern re-matched the `\` in that pattern's own
 * output and stacked a second marker on it.
 *
 * The replacement is quoted (`"[REDACTED]"`) so redacting a bare JSON literal
 * (`{"token":12345}`) leaves events.jsonl parseable as JSON-per-line.
 */
/**
 * Backslash-escaped quoted value (`password=\"hunter2\"`). A JSON string that
 * was itself serialized into another string arrives with its quotes escaped,
 * so the quoted patterns above never fire — their quote must follow the
 * separator directly, and here a backslash sits in between. The unquoted
 * pattern then matched the lone backslash and stopped at the quote, emitting
 * `password="[REDACTED]""hunter2\"` with the credential still present.
 *
 * Runs before the unquoted pattern so that partial match can no longer happen.
 * The closing `\"` is captured, so the same terminator rule the other value
 * patterns use holds here too: consume to the terminator, fall back to end of
 * line, and re-emit a closer only when the source had one.
 */
const SENSITIVE_ESCAPED_QUOTE_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)\\\\(["'])(?:\\\\\\\\.|(?!\\\\\\3)[^\\r\\n])*(\\\\\\3)?`,
  "gi",
);
const SENSITIVE_UNQUOTED_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)(?:[^\\s"'{\\[\\\\][^\\s"',;)\\]}]*)`,
  "gi",
);
/**
 * Connection-URL userinfo (`mongodb://user:hunter2@host`). Every pattern above
 * keys off a `password`-style field name; a DSN carries the credential
 * positionally instead, so a thrown driver error echoing its connection string
 * matched nothing and leaked whole. `src/connectors/db/lib/drivers/mongodb.ts`
 * builds exactly this shape (`${user}:${password}@`).
 *
 * Only the password position is redacted. The username is not itself a secret
 * and keeping it — along with scheme, host, and path — is what makes the
 * scrubbed message still useful for diagnosing a connection failure.
 *
 * The value classes exclude `/` and `@`, so the match cannot run past the
 * authority into the path and swallow the rest of the payload — the same
 * greedy-consumption guard the AUTH patterns document above. Re-running over
 * already-redacted text is a no-op (`[REDACTED]` re-matches to itself).
 *
 * Residual: a colon-less userinfo (`https://<token>@host`) is left alone,
 * because that position is far more often a bare username (`postgres://
 * myuser@localhost/db`) than a token, and this repo never generates it.
 */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"']+:)[^\s/@"']+@/gi;

/**
 * True when a field path names a credential — `password`, `api_key`,
 * `secretAccessKey`, `auth.token`, and the rest of the same vocabulary the
 * scrubbing patterns use.
 *
 * Exists because `scrubSecrets` cannot help with author-controlled free text.
 * It finds a secret by its `key = value` shape, so a message that names the
 * field and the value in prose — a Zod `superRefine` producing
 * `rejected value hunter2` — has no shape to key off and survives scrubbing.
 * When the *path* says the field is a credential, the caller should drop the
 * whole message rather than try to scrub it.
 */
const SENSITIVE_PATH_RE = new RegExp(
  `(?:^|[.\\[\\]])${KEY_PREFIX}(?:${SENSITIVE_WORDS})(?=$|[.\\[\\]])`,
  "i",
);
export function isSensitiveFieldPath(path: string): boolean {
  return SENSITIVE_PATH_RE.test(path);
}

/**
 * Does free-text prose *name* a credential field?
 *
 * `isSensitiveFieldPath` above keys off a structured path (`auth.token`,
 * `creds[0].password`). A validation issue raised on the object rather than on
 * one of its fields has no path at all, so that test is blind to it, and the
 * message is author prose rather than a `key = value` literal `scrubSecrets`
 * can find. This is the same credential vocabulary applied with prose
 * boundaries: any non-alphanumeric neighbour instead of a path separator.
 *
 * The lookahead still rejects run-on words, so `authorization failed` does not
 * match on `auth` (the next character is a letter) while `auth failed` does.
 * Over-matching here only ever costs a dropped message, never a leak.
 */
const SENSITIVE_MENTION_RE = new RegExp(
  `(?:^|[^A-Za-z0-9])${KEY_PREFIX}(?:${SENSITIVE_WORDS})(?=$|[^A-Za-z0-9])`,
  "i",
);
export function mentionsSensitiveField(text: string): boolean {
  return SENSITIVE_MENTION_RE.test(text);
}

export function scrubSecrets(text: string): string {
  return text
    .replace(
      SENSITIVE_SQUOTE_RE,
      (_m, key: string, sep: string, close: string | undefined) =>
        `${key}${sep}'[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_DQUOTE_RE,
      (_m, key: string, sep: string, close: string | undefined) =>
        `${key}${sep}"[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_AUTH_PARAMS_RE,
      (
        _m,
        kq1: string,
        kw: string,
        kq2: string,
        sep: string,
        scheme: string | undefined,
      ) => `${kq1}${kw}${kq2}${sep}${scheme ?? ""}[REDACTED]`,
    )
    .replace(
      SENSITIVE_AUTH_ESCAPED_RE,
      (
        _m,
        kq1: string,
        kw: string,
        kq2: string,
        sep: string,
        schemeOutside: string | undefined,
        quote: string,
        schemeInside: string | undefined,
        close: string | undefined,
      ) =>
        `${kq1}${kw}${kq2}${sep}${schemeOutside ?? ""}\\${quote}${schemeInside ?? ""}[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_AUTH_QUOTED_RE,
      (
        _m,
        kw: string,
        keyQuote: string,
        sep: string,
        schemeOutside: string | undefined,
        valQuote: string | undefined,
        schemeInside: string | undefined,
        closeQuote: string | undefined,
      ) => {
        if (valQuote !== undefined) {
          // Same terminator rule as everywhere else: re-emit the closer only
          // when the source had one.
          const close = closeQuote === undefined ? "" : valQuote;
          return `${kw}${keyQuote}${sep}${schemeOutside ?? ""}${valQuote}${schemeInside ?? ""}[REDACTED]${close}`;
        }
        return `${kw}${keyQuote}${sep}${schemeOutside ?? ""}[REDACTED]`;
      },
    )
    .replace(
      SENSITIVE_AUTH_LINE_RE,
      (_m, kw: string, sep: string, scheme: string | undefined) =>
        `${kw}${sep}${scheme || ""}[REDACTED]`,
    )
    .replace(
      SENSITIVE_AUTH_INLINE_RE,
      (
        _m,
        kw: string,
        sep: string,
        schemeOutside: string | undefined,
        valQuote: string | undefined,
        schemeInside: string | undefined,
        closeQuote: string | undefined,
      ) => {
        if (valQuote !== undefined) {
          // Re-emit the closing quote only when the source had one; a
          // truncated message must not gain a quote it never contained.
          const close = closeQuote === undefined ? "" : valQuote;
          return `${kw}${sep}${schemeOutside || ""}${valQuote}${schemeInside || ""}[REDACTED]${close}`;
        }
        return `${kw}${sep}${schemeOutside || ""}[REDACTED]`;
      },
    )
    .replace(
      SENSITIVE_ESCAPED_QUOTE_RE,
      (
        _m,
        key: string,
        sep: string,
        quote: string,
        close: string | undefined,
      ) => `${key}${sep}\\${quote}[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_UNQUOTED_RE,
      (_m, key: string, sep: string) => `${key}${sep}"[REDACTED]"`,
    )
    .replace(URL_USERINFO_RE, (_m, prefix: string) => `${prefix}[REDACTED]@`);
}

function isoTimestamp(): string {
  const iso = new Date().toISOString();
  return iso.endsWith("Z") ? iso : iso + "Z";
}

export interface AuditWriter {
  readonly enabled: boolean;
  readonly sessionId: string;
  logEvent(
    event: Omit<AuditEvent, "timestamp" | "session_id"> & Record<string, unknown>,
  ): void;
}

class DiskAuditWriter implements AuditWriter {
  readonly enabled: boolean;
  readonly sessionId: string;
  private readonly _path: string | null;

  constructor(opts: AuditWriterOptions) {
    this.enabled = opts.enabled;
    this.sessionId = opts.sessionId ?? crypto.randomBytes(6).toString("hex");
    this._path = opts.enabled && opts.path ? opts.path : null;
  }

  logEvent(
    event: Omit<AuditEvent, "timestamp" | "session_id"> & Record<string, unknown>,
  ): void {
    if (!this.enabled || this._path === null) return;
    const record: Record<string, unknown> = {
      ...event,
      timestamp: isoTimestamp(),
      session_id: this.sessionId,
    };
    try {
      // Ensure parent dir exists — caller may pass a path whose dir doesn't
      // yet exist (common for first use).
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.appendFileSync(this._path, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // Best-effort; never raise into the caller.
    }
  }
}

/** A no-op writer used when audit is disabled. */
class NullAuditWriter implements AuditWriter {
  readonly enabled = false;
  readonly sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? crypto.randomBytes(6).toString("hex");
  }

  logEvent(): void {
    /* no-op */
  }
}

export function createAuditWriter(opts: AuditWriterOptions): AuditWriter {
  if (!opts.enabled) return new NullAuditWriter(opts.sessionId);
  if (opts.path === undefined || opts.path.length === 0) {
    throw new Error(
      "audit: 'path' is required when 'enabled' is true",
    );
  }
  return new DiskAuditWriter(opts);
}
