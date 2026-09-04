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
const KQ = '(?:\\\\*["\'])?';
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
/**
 * Parameter NAMES are an HTTP token, not `\w+`. RFC 7616 defines `username*`
 * for the extended (RFC 5987) encoding, and the token set also admits
 * `- . ! # $ % & + ^ _ ~ |`. `\w+` rejected `username*`, so a header using the
 * extended form failed this branch and fell through to the inline one, which
 * stops at the first quote and leaves `response` standing.
 *
 * The whole token set is admitted at once rather than adding `*`. This branch
 * has now been widened three times — for bare values, for escaped quotes, and
 * for this — and each time the next unhandled character was the next report.
 * The apostrophe is the one token character deliberately excluded: it is also
 * a value quote here, and admitting it into the name would let a name run
 * across a quoted value.
 */
const AUTH_PARAM_NAME = "[A-Za-z0-9!#$%&*+^_~|.-]+";
/**
 * An authentication SCHEME is a token as well, not `[A-Za-z]+`. `AWS4-HMAC-SHA256`
 * carries digits and hyphens, so a scheme-letters-only rule failed the whole
 * parameter branch and the fallback stopped at the first quoted value, leaving
 * `Signature="…"` standing. Same grammar as the parameter names above and the
 * same exclusion: the apostrophe is a value quote here.
 */
const AUTH_SCHEME = "[A-Za-z0-9!#$%&*+^_~|.-]+";
/**
 * An unquoted parameter value. Two shapes, and the order matters.
 *
 * First the RFC 5987 extended value an `xxx*=` parameter carries —
 * `charset'language'value`, as in `username*=UTF-8''alice`. It contains
 * apostrophes by definition, which the plain token below excludes, so a
 * token-only rule stopped at `UTF-8` and the parameter list failed from
 * there. Each of its three segments still excludes the double quote, so it
 * cannot run across a following quoted value.
 *
 * Then the plain token. It excludes the quote, comma and whitespace to keep
 * the parameter boundaries, and `]` and `}` so the branch cannot escape the
 * header into a surrounding payload.
 */
const AUTH_PARAM_VALUE =
  "[^\\s,\"'\\r\\n\\]}]*'[^\\s,\"'\\r\\n\\]}]*'[^\\s,\"'\\r\\n\\]}]*|[^\\s,\"'\\r\\n\\]}]+";
const SENSITIVE_AUTH_PARAMS_RE = new RegExp(
  `(\\\\*["']?)(\\bauthorization\\b)(\\\\*["']?)(\\s*[:=]\\s*)(${AUTH_SCHEME}\\s+)?${AUTH_PARAM_NAME}\\s*=\\s*(?:(\\\\*["'])(?:(?:(?!\\6)(?:\\\\.|[^\\r\\n]))*\\6|[^\\r\\n]*)|${AUTH_PARAM_VALUE})(?:\\s*,\\s*${AUTH_PARAM_NAME}\\s*=\\s*(?:(\\\\*["'])(?:(?:(?!\\7)(?:\\\\.|[^\\r\\n]))*\\7|[^\\r\\n]*)|${AUTH_PARAM_VALUE}))*`,
  "gi",
);
const SENSITIVE_AUTH_ESCAPED_RE =
  /(\\*["']?)(\bauthorization\b)(\\*["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?\\+(["'])((?:bearer|basic)\s+)?(?:\\\\.|(?!\\+\6)[^\r\n])*(\\+\6)?/gi;
const SENSITIVE_AUTH_QUOTED_RE =
  /(?<=["'])(\bauthorization\b)(\\*["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\5)[^\r\n\\])*(\5)|[^\r\n]*)|(?:[^"'\r\n\\]|["'](?![\s]*(?:[,;)\]}]|$)))+)/gi;
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
 * The unquoted fallback admits a quote that is followed by more value, and
 * stops at one followed by structure (`,;)]}`) or the end of the input. Those
 * are the two things a quote can be here: part of the credential, or the
 * closer of the string the message was embedded in. Refusing every quote
 * leaked `Authorization: Bearer pre"abc123`; accepting every quote consumed
 * the `"}` of `{"message":"authorization: Bearer abc"}` and broke the
 * payload. The lookahead is the distinction between those two cases.
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
  /(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\4)[^\r\n\\])*(\4)|[^\r\n]*)|(?:[^"'\r\n\\]|["'](?![\s]*(?:[,;)\]}]|$)))+)/gi;
/**
 * Unquoted-value form (`password:hunter2`). Parser errors echo the offending
 * source fragment, so `--params '{"password":hunter2}'` surfaces the raw
 * value in a `JSON.parse` message that the quoted patterns above skip.
 *
 * Runs LAST so already-redacted quoted values are inert. That rests on the
 * FIRST position alone refusing `"` and `'`, so `password='[REDACTED]'` still
 * does not match. The trailing position deliberately admits them: a value
 * that never opened a quote cannot be ended by one, and excluding the quote
 * there meant `password=pre"hunter2` matched only `pre` and emitted
 * `password="[REDACTED]""hunter2` with the tail intact. Structure (`,;)]}`)
 * and whitespace still bound the match, so the payload after the field is
 * untouched.
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
/**
 * PEM armor, redacted as one unit wherever it appears.
 *
 * Every value pattern in this file treats whitespace as a value terminator,
 * which is correct for a token and wrong for a PEM block: the body is
 * newline-separated, so `private_key=-----BEGIN PRIVATE KEY-----\nMIIE...`
 * redacted the first token and left the key material standing. That became
 * reachable the moment the `private_key` vocabulary was added.
 *
 * Armor does not need a terminator guessed for it — it carries its own. The
 * match runs from `-----BEGIN` to the first `-----END ...-----`, so it is
 * bounded by the document rather than by the end of the line, and it needs no
 * field name in front of it: a PEM private key echoed on its own is a
 * credential whether or not something labelled it.
 *
 * Scoped to key material. A CERTIFICATE is published by design, and redacting
 * one would remove the most useful thing in a TLS diagnostic.
 *
 * Runs FIRST so the value patterns never see the inside of a block.
 *
 * The body is base64 and whitespace, and bounded. An unconstrained `[\\s\\S]*?`
 * was measurably superlinear — a message of repeated unterminated `-----BEGIN`
 * headers went 0.8ms at 10k chars to 13.4ms at 80k, because each header
 * rescans to the end looking for a terminator that is not there. Restricting
 * the class makes a non-PEM continuation fail at the first character (`-` is
 * not base64), and the length cap covers the rest: 8192 base64 characters is
 * comfortably above a 4096-bit key. Round 7 made linear scan cost a standing
 * requirement for this file.
 */
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8192}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * A PEM block whose `-----END` marker never arrived.
 *
 * A parser error echoing incomplete key material is the ordinary case, and
 * {@link PEM_BLOCK_RE} requires the terminator, so a truncated block fell
 * through to the field patterns — which redacted `-----BEGIN` as the value and
 * left the body on the following lines. Four shapes leaked: keyed, bare, other
 * key types, and mid-prose.
 *
 * A `-----BEGIN … PRIVATE KEY-----` header is unambiguous on its own, so the
 * absence of a terminator is a reason to redact more, not less.
 *
 * The body is matched as base64 LINES rather than as base64 characters. Prose
 * is mostly letters, so a character class would run straight on into the rest
 * of the message and delete the diagnostic around the key — over-matching is
 * safe for a value and not for the message carrying it. Requiring 16+
 * unbroken base64 characters per line admits a real PEM body (64 to a line)
 * and stops at ordinary words.
 *
 * Runs immediately after {@link PEM_BLOCK_RE}, so it only ever sees blocks
 * that genuinely had no terminator.
 */
const PEM_TRUNCATED_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[ \t]*[\r\n]+[A-Za-z0-9+/=]{16,}){0,256}[ \t]*[\r\n]*/g;

const SENSITIVE_ESCAPED_QUOTE_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)\\\\+(["'])(?:\\\\\\\\.|(?!\\\\+\\3)[^\\r\\n])*(\\\\+\\3)?`,
  "gi",
);
const SENSITIVE_UNQUOTED_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})${KEY_END}${KQ})(\\s*[:=]\\s*)(?:[^\\s"'{\\[\\\\][^\\s,;)\\]}]*)`,
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
 * They do NOT exclude the apostrophe. `encodeURIComponent` leaves `'` alone,
 * so `_buildUri` emits `mongodb://user:abc'def@host` for a password containing
 * one — and excluding it meant the class stopped early, the required trailing
 * `@` was never reached, and the whole credential survived. The double quote
 * still is excluded, which is what keeps the match inside a JSON string value;
 * `@` and `/` are what bound it within the authority. The apostrophe was doing
 * no work here that those three do not already do.
 *
 * Residual: a colon-less userinfo (`https://<token>@host`) is left alone,
 * because that position is far more often a bare username (`postgres://
 * myuser@localhost/db`) than a token, and this repo never generates it.
 *
 * The leading lookbehind is a performance guard, not a correctness one. A
 * scheme cannot begin part-way through a run of scheme characters, and without
 * saying so the engine retried the greedy `[a-z0-9+.-]*` from EVERY character
 * of a long alphabetic message, backtracking each time in search of `://`.
 * That is quadratic, and it runs synchronously on externally derived exception
 * text: measured before the guard, 10k characters took 48 ms, 30k took 376 ms
 * and 60k took 1.6 s, so a large parser error stalled the connector.
 */
const URL_USERINFO_RE =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"]+:)[^\s/@"]+@/gi;

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

/**
 * Bound on JSON-string layers `scrubSecrets` will peel.
 *
 * Each layer strictly shrinks the input, so the loop terminates without a cap
 * — and the cap that was here did harm rather than good: past it the still
 * escaped text was handed to the very patterns whose ambiguity the unwrap
 * exists to avoid, so eleven layers leaked where eight did not. A defensive
 * limit that silently restores the failure mode is not a defence.
 *
 * The bound remains only as a work ceiling, and it is now unreachable in
 * practice: serializing doubles the escape run, so depth grows as log2 of the
 * length and a 1 MB message tops out around 20. Reaching 64 means the input is
 * adversarial, so it fails closed rather than falling through.
 */
const MAX_UNWRAP_DEPTH = 64;

/**
 * Peel JSON-string layers before matching, and re-serialize afterwards.
 *
 * The patterns below decide where a value ends by counting backslashes. That
 * works while the escape run is unambiguous, but once a credential containing
 * a quote is serialized more than twice, the run in front of the *embedded*
 * quote becomes indistinguishable from the run in front of the *terminating*
 * one, and matching stops early — `"[REDACTED]"hunter2` keeps the tail.
 *
 * Counting cannot resolve that, because the ambiguity is real: the text alone
 * does not say which quote ends the value. `JSON.parse` does, because it
 * consumed the escapes that encode the answer. So each layer is removed
 * before the patterns run and restored after, and they only ever see a value
 * whose quotes are literal.
 *
 * This is a fast path, not the defence: a payload that is not a JSON string
 * falls straight through to the same pattern chain as before.
 */
function unwrapJsonString(text: string): string | null {
  if (text.length < 2 || text.charCodeAt(0) !== 34) return null;
  if (!text.endsWith('"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === "string" ? parsed : null;
}

/**
 * @param maxUnwrapDepth How many JSON-string layers to peel before failing
 * closed. The default is unreachable for a real message (see
 * {@link MAX_UNWRAP_DEPTH}); it is a parameter so the ceiling behaviour is
 * reachable from a test, and so a caller on a memory-constrained path can
 * trade diagnostic detail for a lower bound.
 */
export function scrubSecrets(
  text: string,
  maxUnwrapDepth: number = MAX_UNWRAP_DEPTH,
): string {
  // Peel iteratively rather than recursively: depth is caller-controlled, and
  // the recursion this replaces put it on the JavaScript call stack.
  let payload = text;
  let depth = 0;
  while (depth < maxUnwrapDepth) {
    const inner = unwrapJsonString(payload);
    if (inner === null) break;
    payload = inner;
    depth++;
  }
  // Still nested at the ceiling. Redact rather than hand the escaped remainder
  // to the patterns below, which is what made the previous cap a leak.
  const scrubbed =
    depth === maxUnwrapDepth && unwrapJsonString(payload) !== null
      ? "[REDACTED]"
      : scrubOneLayer(payload);
  let out = scrubbed;
  for (let i = 0; i < depth; i++) out = JSON.stringify(out);
  return out;
}

/** The pattern chain itself, applied to one fully-decoded layer. */
function scrubOneLayer(text: string): string {
  return text
    .replace(PEM_BLOCK_RE, "[REDACTED]")
    .replace(PEM_TRUNCATED_RE, "[REDACTED]")
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
