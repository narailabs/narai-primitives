/**
 * JSONL audit writer. Instance-per-connector (no module-global state).
 *
 * Non-failing: any disk I/O error is swallowed. Audit MUST NEVER crash the
 * caller — a missing audit trail is better than a missing feature.
 *
 * Secret redaction: `scrubSecrets(str)` masks common `password='...'` /
 * `token='...'` / `api_key='...'` literals before writing. Called on
 * caller-supplied strings that might contain credentials.
 *
 * WHERE that call belongs — the contract this file does NOT enforce for you:
 * `logEvent` appends `JSON.stringify(record)` exactly as handed to it. It does
 * not scrub. Redaction is the CALL SITE's job, and every existing site in
 * `toolkit/connector.ts` carries a `DO NOT REMOVE` comment naming the test
 * that pins it.
 *
 * Scrubbing centrally here was considered and rejected twice over: the text
 * arriving from `connector.ts` has already been through `scrubSecrets`, so a
 * second pass double-escapes it, and the stronger of the two defences
 * (`redactSensitiveEchoes`) needs the `params`/`credentials` context that
 * exists at the call site and not here.
 *
 * The consequence, stated so it is not rediscovered: a NEW error path added
 * later inherits no protection. If you add one, scrub the message before it
 * reaches `logEvent` and add the test that would fail without it.
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
 * Every word the redactor treats as a sensitive KEY.
 *
 * `SENSITIVE_WORDS` alone is the wrong set, and the gap is not hypothetical:
 * `authorization` is redacted by the five `SENSITIVE_AUTH_*_RE` patterns,
 * which carry their own `\bauthorization\b` literal, so the field vocabulary
 * never had to list it. Building this guard from the field vocabulary alone
 * therefore left `{"authorization":"{\"ordinary\":\"hunter2\"}"}` looking
 * like an ordinary prose payload — unwrapped, prefix scrubbed without its
 * value, secret intact. `auth` does not cover it either: KEY_END rejects a
 * following letter, which is what keeps `authorization failed` from matching.
 *
 * The union is named once so the two vocabularies cannot drift again.
 */
const SENSITIVE_KEY_WORDS = `${SENSITIVE_WORDS}|authorization`;
/**
 * Optional quote around the key: single or double, escaped or not. Single
 * quotes matter because a Python-style repr of a credential object
 * (`{'password': 'hunter2'}`) reaches these logs as readily as JSON does. A serialized object embedded
 * in another string arrives with its key quotes escaped as well
 * (`request payload: {\\"password\\":\\"hunter2\\"}`), and a key group that
 * accepted only a bare `"` matched none of it — so the escaped *value* branch
 * never got a chance to run and the whole object leaked.
 *
 * The escape run is tied to a left boundary. Without it the group is optional
 * at every index, so on a long backslash run each index consumed the whole
 * remaining run before failing to find a quote — four patterns share this
 * prefix, and `scrubSecrets("\\".repeat(20_000))` cost 2.6s and scaled
 * quadratically on externally derived error text. A run is only ever entered
 * at its first backslash now, which is the only start that can match anyway.
 */
const KQ = '(?:(?<!\\\\)\\\\*["\'])?';
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
/**
 * The camelCase spelling of a sensitive KEY, for the value patterns.
 *
 * `KEY_PREFIX` enumerates CREDENTIAL-side prefixes (`secret`, `session`, …),
 * so `secretAccessKey` matched and `githubToken` did not. The path matcher
 * already accepts an arbitrary prefix — `SENSITIVE_PATH_CAMEL_RE` — so
 * `isSensitiveFieldPath("githubToken")` was true while
 * `scrubSecrets('{"githubToken":"hunter2"}')` left the value alone. A hook
 * that reports an environment-derived `githubToken` reaches the envelope
 * through `scrubSecrets` alone, with no path and no candidate set behind it.
 *
 * The separator spelling needs nothing: KEY_START is `(?<![A-Za-z0-9])`, and
 * `_` is not alphanumeric, so `github_token` already matches at `token`.
 * camelCase has no such boundary, which is the whole of the gap.
 *
 * It cannot join the patterns below: they carry `i`, which case-folds the
 * uppercase transition this needs to see, and without that transition the
 * rule degrades to "letter followed by letter" and starts redacting
 * `mytoken`. So it is a separate, case-SENSITIVE family, exactly as the path
 * matcher keeps `SENSITIVE_PATH_CAMEL_RE` apart from its two siblings.
 *
 * The path rule's two narrowings are inherited: the word is TERMINAL
 * (`maxTokenCount` does not match) and SINGULAR (`maxTokens` is a count, not
 * a credential).
 */
const KEY_CAMEL = `${KQ}(?<![A-Za-z0-9])[A-Za-z0-9]*[a-z0-9](?:${SENSITIVE_KEY_WORDS.replace(
  /[a-z]+/g,
  (w) => w.charAt(0).toUpperCase() + w.slice(1),
)})(?![A-Za-z0-9])${KQ}`;

/**
 * The unterminated-value fallback, bounded at the containing JSON string.
 *
 * Every quoted-value pattern below needs a fallback for a value whose closing
 * quote never arrives — a truncated parser error routinely produces one. That
 * fallback used to be `[^\r\n]*`, and inside a serialized payload there is no
 * newline to stop at, so it ran to the end of the whole document: the
 * credential was redacted, but the JSON came back truncated and every sibling
 * field after the message was deleted. EIGHT patterns shared the fallback and
 * all of them did it — the report named one.
 *
 * A JSON string ends at an unescaped `"` followed by `,`, `]`, `}` or the end
 * of input. Stopping there keeps the redaction and gives the payload back.
 * Only the double quote counts as a terminator: an apostrophe is a value quote
 * in this grammar, and admitting it would end the fallback early on ordinary
 * prose.
 */
/**
 * `<prefix>_authorization` as a KEY, for the scalar patterns only.
 *
 * `authorization` is absent from {@link SENSITIVE_WORDS} on purpose — KEY_END
 * rejects a following letter, which is what stops `auth` matching inside
 * `authorization failed` — and the five `SENSITIVE_AUTH_*_RE` patterns carry
 * their own literal instead. Every one of those anchors on the bare word: the
 * quoted form needs a quote immediately before it, and the line and inline
 * forms need `authorization` to touch its `:`. A service prefix breaks all
 * three, and `\b` cannot rescue them because `_` is itself a word character.
 * So `{"github_authorization":"hunter2"}` returned the credential unchanged
 * while `isSensitiveFieldPath("github_authorization")` called it sensitive —
 * the same vocabulary disagreement as the two fixed above, in a third place.
 * Measured, the gap is every separator spelling: `github_authorization`,
 * `gh-authorization` and `client_authorization` all leaked.
 *
 * Deliberately COMPOUND-only. A separator is required, so the bare
 * `authorization` key still belongs to the AUTH family alone and this does not
 * reshape a redaction those patterns already handle — they preserve the scheme
 * (`Bearer`) and the `key=value` parameter structure, and a generic key match
 * would blank it. The camel spelling needs nothing: `githubAuthorization`
 * already matches through {@link KEY_CAMEL}.
 */
const COMPOUND_AUTH_KEY =
  "(?<![A-Za-z0-9])[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-]authorization";

const UNTERMINATED_TAIL = `(?:(?!\\\\*"\\s*(?:[,\\]}]|$))[^\\r\\n])*`;

const SENSITIVE_SQUOTE_RE = new RegExp(
  `(${KQ}(?:${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})|${COMPOUND_AUTH_KEY})${KEY_END}${KQ})(\\s*[:=]\\s*)'(?:[^'\\\\]*(?:\\\\.[^'\\\\]*)*(')|${UNTERMINATED_TAIL})`,
  "gi",
);
const SENSITIVE_DQUOTE_RE = new RegExp(
  `(${KQ}(?:${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})|${COMPOUND_AUTH_KEY})${KEY_END}${KQ})(\\s*[:=]\\s*)"(?:[^"\\\\]*(?:\\\\.[^"\\\\]*)*(")|${UNTERMINATED_TAIL})`,
  "gi",
);
/** {@link KEY_CAMEL} twins of the two above — same bodies, no `i` flag. */
/**
 * The BACKTICK-quoted value, which is not a JavaScript nicety but the shape
 * `util.inspect` reaches for whenever a string holds both a single and a
 * double quote — `{ password: `abc\'"}hunter2` }`. Without a branch of its
 * own the value fell through to the UNQUOTED pattern, which stops at the first
 * structural delimiter, so the marker landed after `abc` and the rest of the
 * secret survived verbatim.
 *
 * The container scan learned the same delimiter one round earlier; this is its
 * scalar sibling, and fixing one without the other is why it came back.
 */
const SENSITIVE_BTICK_RE = new RegExp(
  `(${KQ}(?:${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})|${COMPOUND_AUTH_KEY})${KEY_END}${KQ})(\\s*[:=]\\s*)\`(?:[^\`\\\\]*(?:\\\\.[^\`\\\\]*)*(\`)|${UNTERMINATED_TAIL})`,
  "gi",
);
const SENSITIVE_BTICK_CAMEL_RE = new RegExp(
  `(${KEY_CAMEL})(\\s*[:=]\\s*)\`(?:[^\`\\\\]*(?:\\\\.[^\`\\\\]*)*(\`)|${UNTERMINATED_TAIL})`,
  "g",
);
const SENSITIVE_SQUOTE_CAMEL_RE = new RegExp(
  `(${KEY_CAMEL})(\\s*[:=]\\s*)'(?:[^'\\\\]*(?:\\\\.[^'\\\\]*)*(')|${UNTERMINATED_TAIL})`,
  "g",
);
const SENSITIVE_DQUOTE_CAMEL_RE = new RegExp(
  `(${KEY_CAMEL})(\\s*[:=]\\s*)"(?:[^"\\\\]*(?:\\\\.[^"\\\\]*)*(")|${UNTERMINATED_TAIL})`,
  "g",
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
  `((?<!\\\\)\\\\*["']?|["']?)(\\bauthorization\\b)(\\\\*["']?)(\\s*[:=]\\s*)(${AUTH_SCHEME}\\s+)?${AUTH_PARAM_NAME}\\s*=\\s*(?:(\\\\*["'])(?:(?:(?!\\6)(?:\\\\.|[^\\\\\\r\\n]))*\\6|${UNTERMINATED_TAIL})|${AUTH_PARAM_VALUE})(?:\\s*,\\s*${AUTH_PARAM_NAME}\\s*=\\s*(?:(\\\\*["'])(?:(?:(?!\\7)(?:\\\\.|[^\\\\\\r\\n]))*\\7|${UNTERMINATED_TAIL})|${AUTH_PARAM_VALUE}))*`,
  "gi",
);
const SENSITIVE_AUTH_ESCAPED_RE =
  /((?<!\\)\\*["']?|["']?)(\bauthorization\b)(\\*["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?\\+(["'])((?:bearer|basic)\s+)?(?:\\\\.|(?!\\+\6)[^\r\n])*(\\+\6)?/gi;
const SENSITIVE_AUTH_QUOTED_RE =
  /(?<=["'])(\bauthorization\b)(\\*["']?)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\5)[^\r\n\\])*(\5)|(?:(?!\\*"\s*(?:[,\]}]|$))[^\r\n])*)|(-?\d[\d.eE+-]*|true|false|null|\{(?:"(?:\\.|[^"\\])*"|[^{}"]|\{(?:"(?:\\.|[^"\\])*"|[^{}"]|\{(?:"(?:\\.|[^"\\])*"|[^{}"])*\})*\})*\}|\[(?:"(?:\\.|[^"\\])*"|[^\[\]"]|\[(?:"(?:\\.|[^"\\])*"|[^\[\]"]|\[(?:"(?:\\.|[^"\\])*"|[^\[\]"])*\])*\])*\])(?=\s*[,}\]])|(?:[^"'\r\n\\]|["'](?![\s]*(?:[,;)\]}]|$)))+)/gi;
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
 *
 * The unquoted fallback admits a quote in a SECOND case: when `, name =`
 * follows it, so the value continues into another parameter. This is the
 * fail-closed rule for a header the parameter branch could not parse.
 * `AUTH_PARAM_NAME` excludes the apostrophe on purpose — it is also a value
 * quote here — so `Digest foo'bar="x", response="hunter2"` failed that branch
 * and arrived here, where the old rule read the `"` before `,` as structure,
 * stopped, and reported success on half a header.
 *
 * The fix is deliberately NOT a wider name class. Admitting backtick alone —
 * the half with no counter-argument, since it is not in the value-quote class
 * — turned seven serialization depths from clean to leaking. Widening the
 * grammar to close one arrangement has opened others every time it was tried.
 * What was actually wrong is that a PARTIAL match here reported success; a
 * fallback that consumes the whole parameter list covers the apostrophe, the
 * backtick, and the next character nobody has thought of, without touching
 * the grammar at all.
 *
 * It stays bounded: the quote is admitted only when another `name =` follows,
 * so the value ends with the last parameter and cannot run into the object
 * carrying the header — the safety property an end-of-line rule lacks.
 */
const SENSITIVE_AUTH_INLINE_RE =
  /(\bauthorization\b)(\s*[:=]\s*)((?:bearer|basic)\s+)?(?:(["'])((?:bearer|basic)\s+)?(?:(?:\\.|(?!\4)[^\r\n\\])*(\4)|(?:(?!\\*"\s*(?:[,\]}]|$))[^\r\n])*)|(?:\\["']|[^"'\r\n\\]|["'](?=\s*,\s*[^\s,="'\r\n]+\s*=)|["'](?![\s]*(?:[,;)\]}]|$)))+)/gi;
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
/**
 * An encrypted PEM carries RFC 1421 metadata between the BEGIN marker and the
 * base64 body — `Proc-Type: 4,ENCRYPTED` and `DEK-Info: AES-128-CBC,<iv>`.
 * Their `:`, `,` and `-` are outside the base64 body class, so the complete
 * block never matched, and {@link PEM_TRUNCATED_RE} then removed only the
 * header: the metadata, the body and the END marker were all returned intact.
 *
 * Bounded at four lines, one separator each. RFC 1421 defines exactly two
 * (`Proc-Type` and `DEK-Info`), so four is slack, and a fixed ceiling keeps
 * the group from being a nested quantifier — `(?:sep+ line)*` over a long run
 * of separators is the shape that backtracks, and this file has a linear-time
 * test that measures it.
 *
 * The metadata section is matched as its own optional prefix rather than by
 * widening the body class, which would let the block run through arbitrary
 * text between two markers. The value excludes the backslash so it stops at a
 * `\n` escape in a serialized PEM instead of consuming the rest of the
 * document.
 */
const PEM_META_LINES = String.raw`(?:[ \t]*(?:[\r\n]|\\[rn])[ \t]*[A-Za-z][A-Za-z0-9-]*:[^\r\n\\]{0,200}){0,4}`;

const PEM_BLOCK_RE = new RegExp(
  String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----${PEM_META_LINES}(?:[A-Za-z0-9+/=\s]|\\[rn]){0,8192}?-----END [A-Z0-9 ]*PRIVATE KEY-----`,
  "g",
);

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
 * that genuinely had no terminator — and blocks whose terminator sat beyond
 * that pattern's 8192-character cap, which is why this one has no cap of its
 * own. A capped body redacts the header plus the first N lines and leaves the
 * rest verbatim, which is a partial match treated as complete: at 256 lines,
 * a 257-line body leaked one line, a 300-line body 44, and a 600-line body
 * 344 — for a terminated block as well as a truncated one.
 *
 * Removing the cap does not cost the linear scan this file requires. A body
 * line must begin with a newline and carry 16+ unbroken base64 characters, so
 * the repetition is a single forward pass with no terminator to hunt and
 * nothing to rescan; measured, bounded and unbounded run within noise of each
 * other on the repeated-header shape. What bounds cost here is
 * {@link PEM_BLOCK_RE}'s terminator search, and that cap is untouched.
 */
const PEM_TRUNCATED_RE = new RegExp(
  String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----${PEM_META_LINES}(?:[ \t]*(?:[\r\n]|\\[rn])+[A-Za-z0-9+/=]{16,})*(?:[ \t]*(?:[\r\n]|\\[rn])+[A-Za-z0-9+/=]{1,15}(?=[ \t]*(?:[\r\n]|\\[rn]|"|$)))?[ \t]*(?:[\r\n]|\\[rn])*`,
  "g",
);

/**
 * The unquoted value when it lives INSIDE a JSON string.
 *
 * The ordinary class stops at `,`, `;`, `)`, `]` or `}` because in plain text
 * those are structural. Inside a serialized string they are not: the message
 * `password=abc'\"}hunter2` is one value, and stopping at that `}` put the
 * marker after `abc` and left the rest of the secret verbatim.
 *
 * The tell is an ESCAPED quote. A `\"` only appears where a JSON string is
 * being quoted inside another, so when one is ahead of the next unescaped `"`
 * the delimiters between here and that quote belong to the value. This branch
 * is ordered FIRST for that reason, and the lookahead keeps it from claiming
 * an ordinary unquoted value, which still stops where it always did.
 *
 * It consumes `\\.` as a unit so an escaped quote cannot end it early, and
 * stops at the first UNESCAPED `"` — the one closing the containing string.
 *
 * The leading guard is not optional. Every other value class here excludes the
 * quote characters a marker starts with, so none of them can re-claim one; this
 * branch has no first-character restriction, and `\\"[REDACTED]\\"` — what the
 * escaped-quote pattern emits one step earlier in the chain — matched it and
 * was redacted a second time into a broken marker.
 * Over-running a value is the safe direction here: it redacts a little extra
 * from a span the caller supplied, where stopping short leaks.
 */
const IN_JSON_STRING_VALUE = `(?!\\\\*["']?\\[REDACTED\\])(?=[^"\\r\\n]*\\\\")(?:\\\\.|[^"\\r\\n])*`;

const SENSITIVE_ESCAPED_QUOTE_RE = new RegExp(
  `(${KQ}(?:${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})|${COMPOUND_AUTH_KEY})${KEY_END}${KQ})(\\s*[:=]\\s*)\\\\+(["'])(?:\\\\\\\\.|(?!\\\\+\\3)(?!\\\\*"\\s*(?:[,\\]}]|$))[^\\r\\n])*(\\\\+\\3)?`,
  "gi",
);
const SENSITIVE_UNQUOTED_RE = new RegExp(
  `(${KQ}(?:${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_WORDS})|${COMPOUND_AUTH_KEY})${KEY_END}${KQ})(\\s*[:=]\\s*)(?:${IN_JSON_STRING_VALUE}|[^\\s"'\`{\\[\\\\][^\\s,;)\\]}]*)`,
  "gi",
);
/** {@link KEY_CAMEL} twins of the two above — same bodies, no `i` flag. */
const SENSITIVE_ESCAPED_QUOTE_CAMEL_RE = new RegExp(
  `(${KEY_CAMEL})(\\s*[:=]\\s*)\\\\+(["'])(?:\\\\\\\\.|(?!\\\\+\\3)(?!\\\\*"\\s*(?:[,\\]}]|$))[^\\r\\n])*(\\\\+\\3)?`,
  "g",
);
const SENSITIVE_UNQUOTED_CAMEL_RE = new RegExp(
  `(${KEY_CAMEL})(\\s*[:=]\\s*)(?:${IN_JSON_STRING_VALUE}|[^\\s"'\`{\\[\\\\][^\\s,;)\\]}]*)`,
  "g",
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
/**
 * The trailing `s?` is on the PATH matcher only, never on the value patterns.
 *
 * A path segment is a container name: `{ tokens: ["…"] }` holds credentials
 * exactly as `{ token: "…" }` does, and the connector's array walk already
 * states that entries of `tokens` inherit their container's sensitivity — the
 * vocabulary just did not agree, so the invariant was false and a plural
 * container contributed no redaction candidate.
 *
 * The value patterns must NOT gain it. There the token is a KEY next to a
 * value, and `passwords` as a key is the run-on-word case the boundary rules
 * exist to leave alone; widening them is how `mytoken` starts being redacted.
 * A path and a key look alike and are not the same question.
 */
const SENSITIVE_PATH_RE = new RegExp(
  `(?:^|[.\\[\\]])${KEY_PREFIX}(?:${SENSITIVE_KEY_WORDS})s?(?=$|[.\\[\\]])`,
  "i",
);
/**
 * The same vocabulary after an ARBITRARY prefix, not only the eight in
 * {@link KEY_PREFIX}.
 *
 * `KEY_PREFIX` enumerates credential-side prefixes (`secret`, `session`,
 * `access`, …) and so covers `secret_access_key` but not the far commoner
 * SERVICE-side naming: `github_token`, `gitlab_token`, `slack_token`,
 * `db_password`, `user_api_key`. Those are ordinary field names, they hold
 * real credentials, and every one of them contributed no redaction candidate.
 * Enumerating service names would repeat the mistake one vendor at a time, so
 * the prefix is whatever precedes a separator.
 *
 * Two deliberate narrowings keep this from swallowing benign fields:
 *
 * - The word must be TERMINAL. `access_key_id` is the public half of an AWS
 *   pair and `password_hint` and `token_count` are not credentials; in each
 *   the credential word is followed by more segment, so none of them match.
 * - SINGULAR only. The `s?` on the rule above exists for a plural CONTAINER
 *   (`{tokens: [...]}`), which is meaningful when the prefix is a credential
 *   word. With an arbitrary prefix it collides with counts — `max_tokens`,
 *   `estimated_tokens`, `maxTokens` — which are numbers, and matching them
 *   would blank an ordinary validation diagnostic. Residue, stated: a plural
 *   service-prefixed container (`github_tokens`) is not matched here.
 *
 * The run-on exclusion is inherited unchanged, because a separator is
 * required: `mytoken`, `notpassword`, `passwordless`, `secretary` and
 * `tokenized` have none.
 */
const SENSITIVE_PATH_COMPOUND_RE = new RegExp(
  `(?:^|[.\\[\\]])[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-](?:${SENSITIVE_KEY_WORDS})(?=$|[.\\[\\]])`,
  "i",
);
/**
 * The camelCase spelling of the same rule, and the reason it cannot live in
 * the regex above: that one carries the `i` flag, which erases the
 * lowercase-to-uppercase boundary this needs to see. Case-sensitive, and the
 * vocabulary is capitalised to match `githubToken` / `dbPassword`.
 */
const SENSITIVE_PATH_CAMEL_RE = new RegExp(
  `(?:^|[.\\[\\]])[A-Za-z0-9]*[a-z0-9](?:${SENSITIVE_KEY_WORDS.replace(
    /[a-z]+/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1),
  )})(?=$|[.\\[\\]])`,
);

/**
 * A path segment that names a CONTAINER of credentials, such as
 * `credentials.pat`.
 *
 * Deliberately separate from {@link isSensitiveFieldPath} rather than another
 * alternative inside it. That predicate answers two different questions for
 * two callers: which values to collect for redaction, and whether a validation
 * message should be dropped whole instead of having its echoes redacted.
 * Folding `credential` in changed the second one too, and five existing tests
 * caught it — `credentials: rejected value [REDACTED]` degraded to
 * `credentials: [REDACTED]`, losing the author's constant text, which is the
 * exact trade the redact-rather-than-drop design was chosen to avoid.
 *
 * So this is for the collector only. `pat` is in no vocabulary and never will
 * be; the container name is the only thing in `credentials.pat` that says what
 * it holds.
 */
const CREDENTIAL_CONTAINER_RE = /(?:^|[.[\]])credentials?(?=$|[.[\]])/i;
export function isCredentialContainerPath(path: string): boolean {
  return CREDENTIAL_CONTAINER_RE.test(path);
}
export function isSensitiveFieldPath(path: string): boolean {
  return (
    SENSITIVE_PATH_RE.test(path) ||
    SENSITIVE_PATH_COMPOUND_RE.test(path) ||
    SENSITIVE_PATH_CAMEL_RE.test(path)
  );
}

/**
 * A PLURAL credential word behind an arbitrary prefix: `github_tokens`,
 * `githubTokens`, `db_passwords`.
 *
 * The residue {@link SENSITIVE_PATH_COMPOUND_RE} documents and declines to
 * cover. Adding `s?` there is the obvious fix and it is the wrong one: with an
 * arbitrary prefix the plural collides with counts, so `max_tokens`,
 * `prompt_tokens` and `total_tokens` — among the commonest benign parameters
 * in an LLM toolkit, and the whole subject of `src/toolkit/usage/` — start
 * being treated as credentials. Measured, not assumed: that change redacts all
 * five counting spellings and fails two tests whose names are the policy.
 *
 * So the plural is split out instead of widened in, and it answers a narrower
 * question that the caller completes. A count is a NUMBER and a credential
 * bundle is a CONTAINER, so the collector in connector.ts pairs this predicate
 * with the value's shape and only treats `github_tokens` as sensitive when its
 * value is an array or an object. `{max_tokens: 4096}` is a number and stays a
 * diagnostic; `{github_tokens: ["hunter2"]}` is a container and its entries
 * become redaction candidates.
 *
 * NOT part of {@link isSensitiveFieldPath}, and that is the point. That
 * predicate also decides whether to drop a validation message whole, where no
 * value is in hand to ask about — the exact call site where widening the rule
 * would delete a benign count's diagnostic.
 *
 * The compound rule's other narrowing is inherited: the word is TERMINAL and a
 * separator is required, so `token_counts`, `password_hints` and the run-on
 * `mytokens` still do not match.
 */
const SENSITIVE_PATH_COMPOUND_PLURAL_RE = new RegExp(
  `(?:^|[.\\[\\]])[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-](?:${SENSITIVE_KEY_WORDS})s(?=$|[.\\[\\]])`,
  "i",
);
/** The camel spelling, case-sensitive for the reason given above {@link SENSITIVE_PATH_CAMEL_RE}. */
const SENSITIVE_PATH_CAMEL_PLURAL_RE = new RegExp(
  `(?:^|[.\\[\\]])[A-Za-z0-9]*[a-z0-9](?:${SENSITIVE_KEY_WORDS.replace(
    /[a-z]+/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1),
  )})s(?=$|[.\\[\\]])`,
);
export function isPluralCredentialContainerPath(path: string): boolean {
  return (
    SENSITIVE_PATH_COMPOUND_PLURAL_RE.test(path) ||
    SENSITIVE_PATH_CAMEL_PLURAL_RE.test(path)
  );
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
  // The FULL key vocabulary, not `SENSITIVE_WORDS`. The narrow set omits
  // `authorization`, which the dedicated AUTH patterns cover for a `key =
  // value` literal — but this predicate reads PROSE, where there is no literal
  // for them to find. So `authorization rejected hunter2`, raised at the root
  // by a refinement, matched nothing here: `auth` is rejected by the run-on
  // lookahead (the next character is a letter) and the full word was not in
  // the set, so the message went out unredacted whenever the resolved value
  // was not among the raw-input candidates.
  //
  // The key/value patterns above keep the narrow set on purpose; adding the
  // word there would duplicate what the AUTH patterns already do.
  `(?:^|[^A-Za-z0-9])${KEY_PREFIX}(?:${SENSITIVE_KEY_WORDS})(?=$|[^A-Za-z0-9])`,
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
/**
 * How many candidate payload spans the locator will try in one message.
 * Bounded because candidate starts overlap, so the end-scans are not disjoint
 * and an adversarial `"{`-repeated message would otherwise be quadratic on a
 * synchronous path. Past the cap the message is scrubbed as a flat layer.
 */
const MAX_PAYLOAD_SPAN_ATTEMPTS = 64;
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
      : scrubEmbeddedOrLayer(payload, maxUnwrapDepth - depth);
  let out = scrubbed;
  for (let i = 0; i < depth; i++) out = JSON.stringify(out);
  return out;
}

/**
 * Scrub one layer, unwrapping a serialized payload that sits BEHIND a prose
 * prefix rather than being the whole message.
 *
 * The peel above requires the entire string to be a JSON string, and an SDK
 * exception routinely prefixes one (`Error payload: "{\"password\":…}"`). With
 * the prefix present nothing was unwrapped and the escaped form went straight
 * to the pattern chain, which copes at one and two layers and stops coping at
 * three: `'Error payload: ' + JSON.stringify(x3)` of a value containing a
 * double quote leaked, while the identical payload without the prefix did not.
 * The behaviour was also non-monotonic in depth — three and five leaked, four
 * did not — which is the mark of a regex resolving a genuine ambiguity rather
 * than a threshold set too low. Unwrapping removes the ambiguity instead of
 * widening another escape class to survive it.
 *
 * Two bounds keep this from becoming its own problem:
 *
 * - Candidate spans come from ONE left-to-right pass ({@link jsonStringSpans}).
 *   Trying every quote PAIR would be quadratic in a message full of quotes,
 *   which is the cost class the previous round was about.
 * - The span is rewritten only when `JSON.stringify` reproduces it byte for
 *   byte. Re-serializing is not identity in general — `"aAb"` comes back
 *   as `"aAb"` — and silently rewriting the message around a credential is the
 *   failure mode this whole file guards against.
 */
/**
 * Whether a byte-identical JSON-string span is a SERIALIZED PAYLOAD rather
 * than an ordinary quoted value.
 *
 * Both parse; the difference is what unwrapping does. `api_key="hunter2"` has
 * a span of `"hunter2"` whose inner is the same characters without the quotes,
 * so unwrapping it and re-serializing hands the value straight back — while
 * the prefix, scrubbed alone, no longer has a value to redact. That was a leak
 * introduced by the unwrap itself, caught by twelve existing tests.
 *
 * Two conditions, and both are needed. Unwrapping must have actually removed
 * escapes, and the result must open like a JSON document. A quoted value
 * containing an escape (`"say \"hi\""`) satisfies the first alone.
 */
/**
 * True when the quote at `i` is a real delimiter rather than an escaped one.
 *
 * The opener test accepts a quote followed by a backslash, because that is how
 * a nested string layer begins. An ESCAPED inner quote presents the same two
 * characters, so `{"password":"\"\"hunter2\"","tail":"K"}` offered a span
 * starting at the escaped quote, split the real value in half and emitted
 * malformed text with `hunter2` standing outside any span the later
 * input-aware pass could match.
 *
 * Parity of the preceding backslash run decides it: an even count (including
 * zero) leaves the quote unescaped.
 */
function isUnescapedQuoteAt(text: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && text.charCodeAt(j) === 92; j--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * True when `prefix` ends with a sensitive KEY and its separator, so the span
 * that follows is that key's value rather than a payload embedded in prose.
 *
 * Unwrapping loses the outer context: the prefix is scrubbed without its
 * value, so the field patterns have no `key = value` pair left to match, and
 * the value is scrubbed as a document in its own right. A credential that
 * happens to BE a JSON document — `{"password":"{\"ordinary\":\"hunter2\"}"}`
 * — then survives whole, because nothing inside it is sensitively named.
 *
 * A sensitive key's value is never a payload to unwrap; it is a value to
 * redact, which is what `scrubOneLayer` does with the pair intact.
 */
const SENSITIVE_KEY_TAIL_RE = new RegExp(
  `${KQ}${KEY_START}${KEY_PREFIX}(?:${SENSITIVE_KEY_WORDS})${KEY_END}${KQ}\\s*[:=]\\s*$`,
  "i",
);
/**
 * The camelCase spelling, case-SENSITIVE for the same reason {@link KEY_CAMEL}
 * is: under `i` the uppercase transition folds away. Without this,
 * `{"githubToken":"{\"ordinary\":\"hunter2\"}"}` was unwrapped as a prose
 * payload while the same key's ordinary value was redacted — the drift this
 * guard exists to prevent, one spelling further along.
 */
const SENSITIVE_KEY_TAIL_CAMEL_RE = new RegExp(
  `${KEY_CAMEL}\\s*[:=]\\s*$`,
);
function endsWithSensitiveKey(prefix: string): boolean {
  return (
    SENSITIVE_KEY_TAIL_RE.test(prefix) ||
    SENSITIVE_KEY_TAIL_CAMEL_RE.test(prefix)
  );
}

function isSerializedPayload(span: string, inner: string): boolean {
  if (inner === span.slice(1, -1)) return false;
  const head = inner.charCodeAt(0);
  if (head === 123 || head === 91) return true; // `{` or `[`
  // A further JSON string layer — and it has to BE one, not merely start with
  // a quote. `{"password":"\"hunter2"}` has a value whose inner is `"hunter2`,
  // which opens with a quote and is not a string; treating it as a payload
  // recursed into the value, scrubbed the prefix with no value beside it, and
  // leaked at every depth from 1 to 7.
  return head === 34 && unwrapJsonString(inner) !== null;
}

/**
 * Every `"…"` run in one left-to-right pass, as `[start, end)` pairs.
 *
 * A JSON string ends at its first UNESCAPED quote, so each span's end follows
 * from its start with no search — the pass visits each character a bounded
 * number of times and the spans it yields are disjoint. That is what keeps
 * locating an embedded payload linear rather than quadratic in the number of
 * quotes, which matters because this runs synchronously on error text an
 * attacker can shape.
 *
 * A run with no closing quote is not yielded: there is nothing to parse.
 */
/**
 * Yields `[start, end, exhausted]`. `exhausted` is `true` on the single
 * sentinel yielded when {@link MAX_PAYLOAD_SPAN_ATTEMPTS} runs out, and the
 * caller MUST fail closed on it: candidates remain unexamined, so a payload
 * this pass never looked at may still be in the text.
 */
function* jsonStringSpans(
  text: string,
): Generator<[number, number, boolean]> {
  let i = 0;
  let attempts = 0;
  while (i < text.length) {
    // Only a quote that OPENS a serialized payload is a candidate. A payload
    // is an object, an array, or another string layer, so the next character
    // is `{`, `[`, or the backslash of an escaped quote — nothing else can be
    // one. Pairing every quote with the next unescaped quote instead made an
    // unmatched prose quote swallow the payload's opening quote: `Error
    // unmatched " payload: "<serialized>"` yielded `" payload: "`, and the
    // real span was never offered. Skipping non-openers resynchronises
    // without pairing quotes off against each other.
    if (
      text.charCodeAt(i) !== 34 ||
      !isUnescapedQuoteAt(text, i) ||
      !isPayloadOpener(text.charCodeAt(i + 1))
    ) {
      i++;
      continue;
    }
    // Candidate spans can overlap once starts are chosen independently of
    // where the previous one ended, so the end-scans are no longer disjoint
    // and the pass is no longer linear in the worst case. Adversarial input
    // (`"{` repeated) is the case that matters, since this runs synchronously
    // on error text. A cap keeps the cost bounded. Past it the
    // caller redacts the remainder wholesale: flat-scrubbing it is NOT the
    // same fail-safe as finding no payload, because the budget ran out with
    // candidates unexamined and the 65th may be the real one. Every other
    // budget in this file fails closed; this one silently failed open.
    if (attempts++ >= MAX_PAYLOAD_SPAN_ATTEMPTS) {
      yield [i, i, true];
      return;
    }
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 34) break;
      j++;
    }
    if (j >= text.length) return; // unterminated run; nothing left to parse
    yield [i, j + 1, false];
    // Advance by ONE, not past the span: a rejected candidate must not consume
    // the quotes a real payload might start at.
    i++;
  }
}

/** `{`, `[`, or a backslash — the only characters a serialized payload can open with. */
function isPayloadOpener(code: number): boolean {
  return code === 123 || code === 91 || code === 92;
}

function scrubEmbeddedOrLayer(text: string, remainingDepth: number): string {
  if (remainingDepth <= 0) return scrubOneLayer(text);
  // Candidate spans, not "first quote to last quote". That first attempt was
  // wrong the moment the prose carried a quote of its own:
  // `Error "request": payload: "<serialized>"` produced a span that was not
  // valid JSON, so nothing unwrapped and the leak came straight back. The
  // pass below is linear and yields disjoint runs, so the unrelated
  // `"request"` is simply tried and rejected.
  //
  // The remainder is consumed by a LOOP, not a tail call. Recursing on it cost
  // one stack frame per payload while `remainingDepth` stayed put, so a
  // message carrying ten thousand of them overflowed the stack and replaced
  // the connector's error envelope with a `RangeError` — the scrubber
  // destroying the diagnostic it exists to protect. The unwrap loop above was
  // made iterative for this reason and the pattern came back one function
  // down. Only the SIBLING recursion becomes a loop: the recursion into a
  // payload's own content stays, because `remainingDepth` bounds that one.
  let rest = text;
  let out = "";
  outer: while (rest.length > 0) {
    for (const [start, end, exhausted] of jsonStringSpans(rest)) {
      // The span budget ran out with candidates unexamined, so what is left
      // may hold a payload this pass never reached.
      if (exhausted) return out + "[REDACTED]";
      const span = rest.slice(start, end);
      const inner = unwrapJsonString(span);
      if (
        inner !== null &&
        JSON.stringify(inner) === span &&
        isSerializedPayload(span, inner) &&
        !endsWithSensitiveKey(rest.slice(0, start))
      ) {
        out += scrubOneLayer(rest.slice(0, start));
        out += JSON.stringify(scrubSecrets(inner, remainingDepth - 1));
        // The remainder may hold a second payload; a message carrying two is
        // no less plausible than one.
        rest = rest.slice(end);
        continue outer;
      }
    }
    break;
  }
  return out + scrubOneLayer(rest);
}

/** The pattern chain itself, applied to one fully-decoded layer. */
/**
 * A sensitive key whose value is a CONTAINER, matched structurally rather
 * than with a regex.
 *
 * Two reports landed on the same predicate from opposite sides, which is the
 * tell that a regex was being asked to parse a recursive grammar:
 *
 *   - `SENSITIVE_UNQUOTED_RE`'s value class excludes `{` and `[` so the branch
 *     cannot escape into a surrounding payload. That exclusion also means no
 *     pattern claims the value at all, so
 *     `scrubSecrets('{"password":{"value":"hunter2"}}')` returned the
 *     credential verbatim. Every sensitive key except `authorization` leaked
 *     a container value.
 *   - `authorization` was the exception because
 *     `SENSITIVE_AUTH_QUOTED_RE` hand-unrolls `{...}` and `[...]` three levels
 *     deep. At four levels the alternation fails and the catch-all consumes an
 *     incomplete value:
 *     `'{"authorization":{"a":{"b":{"c":{"d":"hunter2"}}}},"tail":"K"}'` came
 *     back as `{"authorization":[REDACTED]"}}}},"tail":"K"}` — redacted, but
 *     no longer parseable, which is the payload-integrity failure the
 *     unterminated-value fallback was fixed for.
 *
 * Adding a fourth alternation level answers neither report; it moves the
 * boundary. Nesting depth is unbounded in the grammar, so the structural tell
 * is the brace itself: find the value's extent by counting delimiters, and the
 * depth stops mattering. One balanced span in, one `[REDACTED]` out, so the
 * document stays parseable at any depth and the whole key vocabulary is
 * covered by the same rule.
 *
 * Bounded like the rest of this file: {@link MAX_CONTAINER_SPAN} caps how far
 * the scan will look for the closing delimiter. An unbalanced or oversized
 * container is left to the pattern chain below, which fails closed on it.
 */
const MAX_CONTAINER_SPAN = 64 * 1024;
const REDACTED_MARKER = "[REDACTED]";

/**
 * Two matchers, not one alternation, because they need different flags.
 *
 * `KEY_CAMEL` locates the lowercase-to-uppercase transition in `myToken`, and
 * that boundary only exists under a case-SENSITIVE match. Folding it into a
 * combined `gi` regex case-folds the transition to "letter followed by
 * letter", so `mytoken` and `notpassword` — the run-on words the boundary
 * exists to reject — matched, and their containers were deleted while the
 * scalar patterns kept them. The same trap is documented above SENSITIVE_WORDS
 * for KEY_START, and this walked into it from the other side.
 */
/**
 * The container-only vocabulary: {@link SENSITIVE_KEY_WORDS} plus `credentials?`.
 *
 * `credential`/`credentials` names a CONTAINER of secrets, never a secret
 * itself, so it belongs here rather than in the shared vocabulary. The rest of
 * the codebase already treated it that way — {@link isCredentialContainerPath}
 * is true for it and the walk in connector.ts marks everything beneath it
 * sensitive — and only the shape scrubber disagreed, so
 * `{"credentials":{"pat":"hunter2"}}` came back whole and a hook that
 * serializes an environment-derived bundle put the secret on stdout.
 *
 * It must NOT reach the scalar patterns, for the reason documented above
 * {@link isCredentialContainerPath}: `credentials: "./creds.json"` is a path
 * to a file, and blanking it costs a diagnostic while hiding nothing. The
 * `(?=[{[])` lookahead on both matchers below is what holds that line — they
 * fire only when the value opens a container.
 *
 * Both matchers also take a trailing `s?`, which the SCALAR patterns must not.
 * The plural is ambiguous by name — `github_tokens` is a bundle and
 * `max_tokens` is a count — and on the scalar path there is nothing to break
 * the tie, which is why `SENSITIVE_PATH_COMPOUND_RE` stays singular and why
 * the collector in connector.ts has to ask about the value. Here the lookahead
 * has already asked: a count is never spelled `{` or `[`, so the same `s?` that
 * would blank `max_tokens: 4096` on the scalar path cannot fire on it at all.
 */
const CONTAINER_KEY_WORDS = `${SENSITIVE_KEY_WORDS}|credentials?`;
/**
 * The camel spelling of the same vocabulary, and it is a separate constant for
 * the reason stated above {@link KEY_CAMEL}: a case-SENSITIVE match is the only
 * thing that can see the transition in `awsCredentials`. Fixing only the `gi`
 * matcher above left that exact sibling leaking — `{"awsCredentials":{...}}`
 * has no separator for KEY_START to anchor on.
 */
const CONTAINER_KEY_CAMEL = `${KQ}(?<![A-Za-z0-9])[A-Za-z0-9]*[a-z0-9](?:${CONTAINER_KEY_WORDS.replace(
  /[a-z]+/g,
  (w) => w.charAt(0).toUpperCase() + w.slice(1),
)})s?(?![A-Za-z0-9])${KQ}`;

const SENSITIVE_CONTAINER_KEY_RE = new RegExp(
  `(${KQ}${KEY_START}${KEY_PREFIX}(?:${CONTAINER_KEY_WORDS})s?${KEY_END}${KQ})(\\s*[:=]\\s*)(?=[{[])`,
  "gi",
);
const SENSITIVE_CONTAINER_KEY_CAMEL_RE = new RegExp(
  `(${CONTAINER_KEY_CAMEL})(\\s*[:=]\\s*)(?=[{[])`,
  "g",
);

/**
 * Where a sensitive key's container value ends.
 *
 *   - `{ kind: "end" }`   — a balanced close was found at `index`.
 *   - `{ kind: "unsafe" }` — the scan cannot vouch for the extent: the span
 *     bound was reached, or a closer did not match its opener. The caller
 *     must fail CLOSED on this. Returning "not a container" here was a
 *     fail-open: the generic patterns deliberately refuse values that begin
 *     with `{` or `[`, so nothing else claimed the value and a
 *     `{"password":{"pad":<66 KiB>,"value":"hunter2"}}` came back intact.
 *   - `{ kind: "none" }`  — not a container at all.
 *
 * Delimiter TYPES are stacked, not just counted. A combined depth let a `]`
 * close a `{`, so `{"password":{]hunter2,"tail":"K"}` matched `{]` and left
 * the bare credential in the tail.
 *
 * Quotes are tracked so a delimiter inside a string value cannot move the
 * stack — `{"a":"}"}` is one container — and a backslash escapes the next
 * character inside a string, so an escaped quote does not end it.
 */
type ContainerScan =
  | { kind: "end"; index: number }
  | { kind: "unsafe" }
  | { kind: "none" };

/**
 * The marker for an UNQUOTED value, quoted only where a quote belongs.
 *
 * The two callers below used to quote unconditionally, and each spelling is
 * wrong in the other's context:
 *
 *   - `{"githubToken":123456}` — a real JSON member with a number. Emitting a
 *     bare marker gives `{"githubToken":[REDACTED]}`, which does not parse.
 *   - `{"message":"password=hunter2"}` — a credential phrase INSIDE a JSON
 *     string. Emitting a quoted marker ends the containing string early.
 *
 * The separator was the first answer to that and it was the wrong one: `:`
 * appears in prose as readily as in JSON, so `{"message":"prefix token: abc"}`
 * was treated as a member and got quotes it could not carry. The KEY says it
 * instead, and says it independently of the separator — a JSON or repr member
 * has a QUOTED key, and a phrase inside a string does not. The key group
 * already captures its own surrounding quotes, so the test is just whether the
 * capture kept them.
 *
 * The quote it kept is also the quote to emit. A Python repr member is
 * `{'token': 123}`, and closing it with `"` would be as unparseable as not
 * closing it at all.
 */
const MEMBER_KEY_RE = /^\\*(["'])[\s\S]*\\*\1$/;

/**
 * The quote a container key is a MEMBER of, or `null` for prose.
 *
 * {@link unquotedMarker} answers this from the capture alone, and the container
 * matchers cannot: `KEY_START` is satisfied by `_`, so on `{"github_token":…}`
 * the match begins at the SUFFIX and the capture is `token"` — no opening
 * quote, so a capture-only test called a real JSON member prose and emitted a
 * bare marker into a value position. That is not valid JSON, which is the same
 * defect the member rule was introduced to remove, arriving from the other
 * side one commit later.
 *
 * So when the capture is not self-evidently a member, walk back over the rest
 * of the key and look at what precedes it. Both ends must agree: a phrase like
 * `{"message":"github_token=[]"}` also has a quote before the key run — the
 * containing string's own — but its capture has no trailing quote, so it is
 * still correctly read as prose.
 */
function memberQuote(text: string, matchStart: number, key: string): string | null {
  const inCapture = MEMBER_KEY_RE.exec(key);
  if (inCapture !== null) return inCapture[1] as string;
  let i = matchStart;
  while (i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1] as string)) i--;
  const before = text[i - 1];
  if (before !== '"' && before !== "'") return null;
  return key.endsWith(before) ? before : null;
}

/**
 * The container pass's marker, deciding quoting by the same rule as the scalar
 * sites — see {@link unquotedMarker} — with the key resolved by
 * {@link memberQuote} rather than read out of the capture.
 */
function containerMarker(quote: string | null): string {
  return quote !== null
    ? `${quote}${REDACTED_MARKER}${quote}`
    : REDACTED_MARKER;
}

function unquotedMarker(
  match: string,
  key: string,
  sep: string,
  whole: string,
  offset: number,
): string {
  // The value class is deliberately greedy — it excludes `,`, `;`, `)`, `]`
  // and `}` but not a quote — because under-matching a value LEAKS while
  // over-matching only redacts a little extra. Inside a JSON string that
  // greed swallows the string's own closing quote, so re-emit whatever the
  // match ended on instead of narrowing the class and trading a malformed
  // payload for an escaped secret.
  const tail = /["']$/.exec(match)?.[0] ?? "";
  // Resolved from the TEXT, not from the capture, for the reason spelled out
  // above {@link memberQuote}: `KEY_START` is satisfied by `_`, so on
  // `{"github_token":123456}` this pattern starts at the `token` suffix and the
  // capture has no opening quote to read. The container pass was corrected one
  // commit ago and this site was not, which is the same rule-versus-sites miss
  // in the same area — there are exactly two places in this file that decide
  // membership from a key, and they now share the decision.
  const quote = memberQuote(whole, offset, key);
  return quote !== null
    ? `${key}${sep}${quote}${REDACTED_MARKER}${quote}${tail}`
    : `${key}${sep}${REDACTED_MARKER}${tail}`;
}

function containerEnd(text: string, open: number): ContainerScan {
  const first = text[open];
  if (first !== "{" && first !== "[") return { kind: "none" };
  const hardEnd = open + MAX_CONTAINER_SPAN;
  const limit = Math.min(text.length, hardEnd);
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < limit; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    // The backtick is a string delimiter here for the same reason the other
    // two are: `util.inspect` switches to it whenever a string contains both
    // a single and a double quote, which is exactly what a credential dumped
    // through an SDK error looks like. Without it the first `}` INSIDE such a
    // string closed the scan, so the marker landed mid-string, the tail of the
    // secret survived, and the payload came back malformed as well.
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const want = c === "}" ? "{" : "[";
      if (stack.pop() !== want) return { kind: "unsafe" };
      if (stack.length === 0) return { kind: "end", index: i + 1 };
    }
  }
  // Ran out of input as well as budget: an unterminated container is the
  // truncated-payload shape, and it is unsafe for the same reason.
  return { kind: "unsafe" };
}

/**
 * Replace every sensitive key's container value with a single marker.
 *
 * Run once per matcher — see {@link SENSITIVE_CONTAINER_KEY_RE}. The second
 * pass sees the first pass's markers, and the marker guard below stops it
 * from treating one as a container.
 */
function scrubContainerValues(text: string, re: RegExp): string {
  re.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length;
    const scan = containerEnd(text, open);
    if (scan.kind === "none") continue;
    if (scan.kind === "unsafe") {
      // Fail closed. The extent is unknown, so everything from the value on
      // is dropped rather than handed to patterns that will not claim it.
      // Quoted only for a MEMBER, exactly as the scalar replacements decide it
      // — see `unquotedMarker`. Applying that rule to the scalar sites and not
      // to this one left the same defect here: `{"message":"token=[]"}` is
      // prose inside a string, and quoting its marker ended the string early.
      return (
        out +
        text.slice(cursor, m.index) +
        m[1] +
        m[2] +
        containerMarker(memberQuote(text, m.index, m[1] as string))
      );
    }
    const end = scan.index;
    // The marker this function writes is itself bracket-delimited, so an
    // unquoted `authorization: [REDACTED]` left by another pattern looks like
    // a container on the next pass and would be rewritten to
    // `authorization: "[REDACTED]"`. That is a redaction either way, but it
    // makes `scrubSecrets` non-idempotent, and this file is applied more than
    // once — the depth-unwrapping loop above re-enters it per layer.
    if (text.slice(open, end) === REDACTED_MARKER) continue;
    // Quoted for a MEMBER and bare for prose, the same rule and the same reason
    // as the scalar sites: a bare marker in a JSON value position is not valid
    // JSON, and a quoted one inside a JSON string is not either.
    out +=
      text.slice(cursor, m.index) +
      m[1] +
      m[2] +
      containerMarker(memberQuote(text, m.index, m[1] as string));
    cursor = end;
    re.lastIndex = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

function scrubOneLayer(text: string): string {
  return scrubContainerValues(
    scrubContainerValues(text, SENSITIVE_CONTAINER_KEY_RE),
    SENSITIVE_CONTAINER_KEY_CAMEL_RE,
  )
    .replace(PEM_BLOCK_RE, "[REDACTED]")
    .replace(PEM_TRUNCATED_RE, "[REDACTED]")
    // Backticks BEFORE the unquoted branch, which would otherwise claim the
    // value and stop at the first delimiter inside it. See SENSITIVE_BTICK_RE.
    .replace(
      SENSITIVE_BTICK_RE,
      (_m, key: string, sep: string, close: string | undefined) =>
        `${key}${sep}\`[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_BTICK_CAMEL_RE,
      (_m, key: string, sep: string, close: string | undefined) =>
        `${key}${sep}\`[REDACTED]${close ?? ""}`,
    )
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
      SENSITIVE_SQUOTE_CAMEL_RE,
      (_m, key: string, sep: string, close: string | undefined) =>
        `${key}${sep}'[REDACTED]${close ?? ""}`,
    )
    .replace(
      SENSITIVE_DQUOTE_CAMEL_RE,
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
        jsonScalar: string | undefined,
      ) => {
        if (valQuote !== undefined) {
          // Same terminator rule as everywhere else: re-emit the closer only
          // when the source had one.
          const close = closeQuote === undefined ? "" : valQuote;
          return `${kw}${keyQuote}${sep}${schemeOutside ?? ""}${valQuote}${schemeInside ?? ""}[REDACTED]${close}`;
        }
        if (jsonScalar !== undefined) {
          // A JSON scalar under a quoted key. The marker replaces a value that
          // had no quotes of its own, so it must supply them — the generic and
          // camelCase branches already do this. Quoting alone is not enough:
          // the general branch below also consumed the `,` and the NEXT
          // key/value pair, so `{"authorization":123,"tail":"K"}` came back as
          // `{"authorization":[REDACTED]"}` — invalid, and the sibling gone.
          // Matching the scalar itself stops at its own boundary.
          return `${kw}${keyQuote}${sep}${schemeOutside ?? ""}"[REDACTED]"`;
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
      SENSITIVE_ESCAPED_QUOTE_CAMEL_RE,
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
      (m: string, key: string, sep: string, offset: number, whole: string) =>
        unquotedMarker(m, key, sep, whole, offset),
    )
    .replace(
      // Quoted, exactly like SENSITIVE_UNQUOTED_RE above. `scrubSecrets` is
      // exported and preserves JSON-shaped payloads, and this branch is the
      // one that saw a service-prefixed key with a non-string scalar:
      // `{"githubToken":123456}` became `{"githubToken":[REDACTED]}`, which
      // does not parse. The `_`-separated spelling of the same key went
      // through the branch above and stayed valid, so the two disagreed.
      SENSITIVE_UNQUOTED_CAMEL_RE,
      (m: string, key: string, sep: string, offset: number, whole: string) =>
        unquotedMarker(m, key, sep, whole, offset),
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
