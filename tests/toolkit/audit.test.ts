import * as fs from "node:fs";
import { inspect } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditWriter,
  isSensitiveFieldPath,
  mentionsSensitiveField,
  scrubSecrets,
} from "../../src/toolkit/audit/writer.js";

/**
 * Best-of-N ratio measurement, INTERLEAVED.
 *
 * Every linear-time test here divides one timing by another, so contention
 * matters only when it lands on one side of the division. Measuring all the
 * small samples and then all the large ones does exactly that: vitest runs
 * files in parallel, and a window where the CPU is taken away inflates the
 * ratio by however long it lasted. That is how the credential-free scan failed
 * CI at 8.02 against a threshold of 8 while measuring 3.2-4.6 locally and
 * passing 3/3 in isolation under coverage.
 *
 * Interleaving puts a contended window on both sides; each size keeps its own
 * minimum, so what survives is the work rather than the scheduler. The
 * Each of these tests also carries `{ retry: 2 }`, and that is not a way of
 * loosening the assertion. What they detect is a COMPLEXITY change: a
 * quadratic scan measures ~16x on a 4x input and fails every attempt, while a
 * scheduler steal is a one-off. Retrying separates those two without touching
 * the threshold, which a larger tolerance would not.
 *
 * The deeper cause is worth naming rather than tuning around: this PR made
 * `scrubSecrets` far more expensive per byte than `origin/main` — measured 12x
 * on plain text and ~300x on a backslash run — so the work these tests time is
 * big enough that noise reaches the ratio. The scaling itself is still linear
 * (x2.0 per doubling at five sizes), so the assertion is not what is wrong.
 *
 * The threshold is untouched — it is the part with teeth, and loosening it would
 * let the quadratic behaviour these tests exist for slip through.
 */
function ratioOf(
  run: (size: number) => void,
  smallN: number,
  largeN: number,
  samples = 5,
): { small: number; large: number } {
  const once = (n: number): number => {
    const t = process.hrtime.bigint();
    run(n);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  once(smallN); // warm both paths before either is timed
  once(largeN);
  let small = Infinity;
  let large = Infinity;
  for (let i = 0; i < samples; i++) {
    small = Math.min(small, once(smallN));
    large = Math.min(large, once(largeN));
  }
  return { small: Math.max(small, 0.5), large };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scrubSecrets", () => {
  it("redacts single-quoted password", () => {
    expect(scrubSecrets("SET password='hunter2'")).toBe(
      "SET password='[REDACTED]'",
    );
  });

  it("redacts double-quoted api_key", () => {
    expect(scrubSecrets(`SET api_key="abc"`)).toBe(`SET api_key="[REDACTED]"`);
  });

  it("redacts common variants", () => {
    const raw = `password='a' passwd='b' pwd='c' token='d' api-key='e' secret='f' auth='g'`;
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).not.toContain("'a'");
    expect(scrubbed).not.toContain("'b'");
    expect(scrubbed).not.toContain("'g'");
    expect(scrubbed).toMatch(/password='\[REDACTED\]'/);
  });

  it("leaves unrelated strings untouched", () => {
    const raw = "SELECT * FROM users WHERE id = 42";
    expect(scrubSecrets(raw)).toBe(raw);
  });

  it("consumes backslash-escaped quotes inside the value", () => {
    // Pins the `\\.` branch of the quoted-value bodies. These are written in
    // the loop-unrolled form `[^'\\]*(?:\\.[^'\\]*)*`; the equivalent nested
    // form `(?:[^'\\]|\\.)*` must stay interchangeable with it, because #95
    // rewrites these same two lines. An escaped quote is part of the value,
    // so redaction must run to the real closing quote, not stop at the escape.
    expect(scrubSecrets("password='he\\'s'")).toBe("password='[REDACTED]'");
    expect(scrubSecrets(`{"password":"a\\"b"}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    // Trailing escaped backslash: the `\\` is consumed as one escape pair, so
    // the following quote still terminates the value.
    expect(scrubSecrets("password='a\\\\'")).toBe("password='[REDACTED]'");
  });

  it("preserves the matched separator in JSON-shaped payloads", () => {
    // `:` must round-trip (don't rewrite to `=`) so events.jsonl stays
    // parseable as JSON-per-line.
    expect(scrubSecrets(`{"password":"hunter2"}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    expect(scrubSecrets(`{"api_key": "abc"}`)).toBe(
      `{"api_key": "[REDACTED]"}`,
    );
    expect(scrubSecrets(`{"token":"sk-abc"}`)).toBe(`{"token":"[REDACTED]"}`);
  });

  it("redacts the full Authorization value for Bearer/Basic schemes", () => {
    expect(scrubSecrets("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(scrubSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [REDACTED]",
    );
  });

  it("redacts a backslash-escaped quoted value", () => {
    // A JSON string serialized into another string arrives with its quotes
    // escaped, so the quoted patterns never fire (their quote must follow the
    // separator directly) and the unquoted one matched the lone backslash and
    // stopped, emitting `password="[REDACTED]""hunter2\\"`.
    expect(scrubSecrets(String.raw`password=\"hunter2\"`)).toBe(
      String.raw`password=\"[REDACTED]\"`,
    );
    expect(scrubSecrets(String.raw`token=\"abc123\"`)).toBe(
      String.raw`token=\"[REDACTED]\"`,
    );
    expect(scrubSecrets(String.raw`password=\'hunter2\'`)).toBe(
      String.raw`password=\'[REDACTED]\'`,
    );
  });

  it("redacts a credential field whose quote is never closed", () => {
    // Same terminator rule as the Authorization patterns: the value runs to
    // its terminator, and an absent terminator is the end of the line. A
    // truncated error message previously matched neither the quoted patterns
    // (no closing quote) nor the unquoted one (which rejects a leading quote),
    // so the value came back verbatim.
    expect(scrubSecrets('request failed: password="hunter2')).toBe(
      'request failed: password="[REDACTED]',
    );
    expect(scrubSecrets("request failed: password='hunter2")).toBe(
      "request failed: password='[REDACTED]",
    );
    expect(scrubSecrets('request failed: token="abc123')).toBe(
      'request failed: token="[REDACTED]',
    );
  });

  it("redacts camelCase compound credential keys", () => {
    // `src/connectors/aws/lib/aws_client.ts` holds credentials as
    // `{ accessKeyId, secretAccessKey }`, so an SDK or custom error renders
    // the camelCase spelling while the CLI writes snake_case. Both reduce to
    // a known prefix plus a known key.
    expect(scrubSecrets('secretAccessKey="hunter2"')).toBe(
      'secretAccessKey="[REDACTED]"',
    );
    expect(scrubSecrets('sessionToken="token"')).toBe(
      'sessionToken="[REDACTED]"',
    );
    // Not named in the report — found by checking the whole prefix class.
    expect(scrubSecrets('accessToken="t1"')).toBe('accessToken="[REDACTED]"');
    expect(scrubSecrets('refreshToken="r"')).toBe('refreshToken="[REDACTED]"');
    expect(scrubSecrets('{"secretAccessKey":"hunter2"}')).toBe(
      '{"secretAccessKey":"[REDACTED]"}',
    );
  });

  it("still refuses to redact run-on words that merely contain a key", () => {
    // The reason camelCase is handled by an enumerated prefix list and not by
    // loosening KEY_START to a lowercase-to-uppercase transition: these
    // patterns are built with `i`, which case-folds `[A-Z]` and would degrade
    // that rule to "letter followed by letter".
    expect(scrubSecrets('mytoken="x"')).toBe('mytoken="x"');
    expect(scrubSecrets('notpassword="y"')).toBe('notpassword="y"');
    expect(scrubSecrets('xsecret="z"')).toBe('xsecret="z"');
  });

  it("redacts a quoted Authorization value embedded mid-string", () => {
    // The inline pattern's value class excluded `"` and `'`, so it stopped at
    // the opening quote and redacted the separator whitespace instead of the
    // token: `Authorization:[REDACTED]"Bearer abc123"` shipped the credential
    // intact into the error envelope and CLI output.
    expect(scrubSecrets('request failed: Authorization: "Bearer abc123"')).toBe(
      'request failed: Authorization: "Bearer [REDACTED]"',
    );
    // Scheme outside the quotes.
    expect(scrubSecrets('request failed: Authorization: Bearer "abc123"')).toBe(
      'request failed: Authorization: Bearer "[REDACTED]"',
    );
    // Single-quoted Basic credential.
    expect(scrubSecrets("request failed: Authorization: 'Basic zzz999'")).toBe(
      "request failed: Authorization: 'Basic [REDACTED]'",
    );
  });

  it("does not consume past a quoted Authorization value into the outer payload", () => {
    // The reason the inline class excluded quotes in the first place. The
    // quoted branch is balanced, so it stops at its own closing quote and the
    // surrounding JSON keys survive.
    expect(
      scrubSecrets('ctx {"a":"b","authorization":"Bearer tok","z":"w"}'),
    ).toBe('ctx {"a":"b","authorization":"Bearer [REDACTED]","z":"w"}');
  });

  it("redacts an unterminated quoted Authorization value to end of line", () => {
    // The rule: the value runs to its terminator, and an absent terminator is
    // the end of the line. A truncated message has nothing structured after
    // the opening quote to protect — everything following it is inside the
    // unclosed string.
    expect(scrubSecrets('request failed: Authorization: "Bearer abc123')).toBe(
      'request failed: Authorization: "Bearer [REDACTED]',
    );
    expect(scrubSecrets("request failed: Authorization: 'Basic zzz999")).toBe(
      "request failed: Authorization: 'Basic [REDACTED]",
    );
    expect(scrubSecrets('request failed: Authorization: Bearer "abc123')).toBe(
      'request failed: Authorization: Bearer "[REDACTED]',
    );
  });

  it("does not invent a closing quote the source never had", () => {
    // The closing quote is captured, not assumed, so a truncated value stays
    // truncated rather than gaining a terminator that changes the text shape.
    expect(scrubSecrets('Authorization: "Bearer abc123')).not.toContain(
      '[REDACTED]"',
    );
  });

  it("is idempotent over an already-redacted quoted Authorization value", () => {
    const once = scrubSecrets('request failed: Authorization: "Bearer abc123"');
    expect(scrubSecrets(once)).toBe(once);
  });

  it("redacts the full Authorization value for non-Bearer/Basic schemes", () => {
    // Regression: previously `[^"'\s\\]+` stopped at the first space so
    // `Authorization: Token abc123` left `abc123` in the log.
    expect(scrubSecrets("Authorization: Token abc123")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(scrubSecrets("authorization=APIKey foo-bar-baz")).toBe(
      "authorization=[REDACTED]",
    );
    expect(scrubSecrets("Authorization: Digest username=u, realm=r")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts quoted Authorization values inside JSON", () => {
    // The closing quote sits outside the regex match, so it is preserved.
    expect(scrubSecrets(`{"authorization": "Token abc123"}`)).toBe(
      `{"authorization": "[REDACTED]"}`,
    );
    expect(scrubSecrets(`{"authorization": "Bearer abc.def"}`)).toBe(
      `{"authorization": "Bearer [REDACTED]"}`,
    );
  });

  it("over-redacts multi-credential lines (safe failure mode)", () => {
    // The unquoted branch consumes to end-of-line — the first Authorization
    // match swallows the second one. We accept the structure loss because
    // the alternative (excluding commas) would leak Digest's comma-separated
    // quoted parameters past the first one.
    const out = scrubSecrets(
      "Authorization: Bearer aaa,Authorization: Basic bbb",
    );
    expect(out).not.toContain("aaa");
    expect(out).not.toContain("bbb");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Digest headers with quoted parameters", () => {
    // Regression (Codex P1 on 0733e81): an internal `"` in
    // `Digest username="u", response="…"` used to terminate the value
    // class, leaving the response= tail in the log.
    const out = scrubSecrets(
      'Authorization: Digest username="u", realm="r", response="abc123"',
    );
    expect(out).toBe("Authorization: [REDACTED]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain('response="');
  });

  it("fails closed when the payload-span budget is exhausted", () => {
    // Regression (Codex P1). `MAX_PAYLOAD_SPAN_ATTEMPTS` bounds the cost of
    // the span scan, but running out used to `return` from the generator, so
    // the loop ended and `scrubOneLayer` ran on text whose candidates had
    // never been examined. The 65th candidate can be the real payload, and
    // here it is: 64 rejected `"{}"` openers, then a thrice-serialized
    // credential whose escaped form the flat patterns cannot read.
    const payload = JSON.stringify(
      JSON.stringify(JSON.stringify({ password: 'pre"hunter2' })),
    );
    const out = scrubSecrets(`${'"{}" '.repeat(64)}${payload}`);
    expect(out).not.toContain("hunter2");
  });

  it("scrubs many embedded payloads without exhausting the stack", () => {
    // Regression (Codex P2). The remainder was processed by a tail call, so N
    // payloads in one message cost N frames while `remainingDepth` stayed put.
    // 10,000 of them threw `RangeError: Maximum call stack size exceeded`,
    // which surfaces as a rejected fetch()/CLI crash INSTEAD of the connector
    // error envelope — the scrubber destroying the diagnostic it protects.
    const one = JSON.stringify(JSON.stringify({ password: "hunter2" }));
    const out = scrubSecrets(Array.from({ length: 10_000 }, () => one).join(" "));
    expect(out).not.toContain("hunter2");
  });

  it("redacts a Digest header whose parameter name is outside the token class", () => {
    // Regression (Codex P1, thread on writer.ts:172). `AUTH_PARAM_NAME`
    // deliberately excludes the apostrophe — it is also a value quote in these
    // patterns, and a name that admits it can run across a quoted value — so
    // `foo'bar=` failed the parameter branch and fell through to the inline
    // one, which stopped at the first quote: `Authorization: [REDACTED]",
    // response="hunter2"`.
    //
    // The fix is NOT a wider name class. Adding backtick alone — the half with
    // no counter-argument, since it is not in the value-quote class — turned
    // seven serialization depths from clean to leaking. It is the FALLBACK
    // that was wrong: it reported success on a header it had only partly
    // parsed. A quote is now part of the value when another parameter follows
    // it, so the fallback consumes the whole list whatever the names contain.
    for (const name of ["foo'bar", "foo`bar", "foo\u00e9bar"]) {
      const out = scrubSecrets(
        `ctx Authorization: Digest ${name}="x", response="hunter2"`,
      );
      expect(out, `leaked for name ${name}`).not.toContain("hunter2");
      expect(out, `leaked for name ${name}`).not.toContain("response=");
    }
  });

  it("stops a continued Digest value at the end of the parameter list", () => {
    // The payload-integrity half. The continuation rule admits a quote only
    // when `, name =` follows it, so the value ends with the last parameter
    // and cannot run on into the object carrying the header — the property the
    // end-of-line rule lacks and the reason this is a lookahead rather than a
    // wider class.
    const out = scrubSecrets(
      `{"err":"authorization: Digest foo'bar=\"x\", response=\"hunter2\"","code":42}`,
    );
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"code":42');
  });

  it("redacts unquoted values", () => {
    // Regression (Codex P2): only quoted values were recognized, so a
    // JSON.parse failure echoing `--params '{"password":hunter2}'` left the
    // secret intact in both the stdout envelope and the stderr line.
    expect(scrubSecrets(`{"password":hunter2}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    // A bare phrase keeps the shape it arrived in; only a MEMBER gets quotes,
    // and only because `{"token":[REDACTED]}` would not parse. The member test
    // is the quoted key, not the separator — see `unquotedMarker`.
    expect(scrubSecrets("password=hunter2")).toBe("password=[REDACTED]");
    expect(scrubSecrets(`{"token":12345}`)).toBe(`{"token":"[REDACTED]"}`);
  });

  it("redacts the unquoted fragment V8 echoes in JSON.parse messages", () => {
    const raw = `Unexpected token 'h', "{"password":hunter2}" is not valid JSON`;
    const out = scrubSecrets(raw);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  it("stops the unquoted branch at structural delimiters", () => {
    // The value class must not swallow the rest of the payload — the same
    // greedy-consumption regression the AUTH anchoring guards against.
    expect(scrubSecrets(`{"token":abc,"user":"bob"}`)).toBe(
      `{"token":"[REDACTED]","user":"bob"}`,
    );
    expect(scrubSecrets("secret=abc; other=keep")).toBe(
      "secret=[REDACTED]; other=keep",
    );
  });

  it("redacts unquoted values that begin with a delimiter", () => {
    // Regression (Codex P2, second round): excluding delimiters from the
    // FIRST character too meant a value starting with one failed to match
    // at all and leaked whole.
    expect(scrubSecrets(`{"password":)hunter2}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    for (const lead of [")", "]", "}", ";", ","]) {
      const out = scrubSecrets(`{"password":${lead}hunter2}`);
      expect(out).not.toContain("hunter2");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("leaves well-formed nested structures alone", () => {
    // This test used to assert that a container under a SENSITIVE key was
    // left untouched, because the regex that would have claimed it stopped at
    // the inner `,` and mangled the payload. The stated intent was payload
    // integrity, and the mechanism it settled on bought that by leaking:
    // `{"token":{"v":1}}` was returned verbatim, and so was
    // `{"password":{"value":"hunter2"}}`.
    //
    // `scrubContainerValues` replaces the whole BALANCED span, so integrity no
    // longer depends on leaving the value alone. The intent is asserted
    // directly below: nothing leaks, and the document still parses.
    for (const src of [
      `{"token":[1,2]}`,
      `{"token":{"v":1}}`,
      `{"password":{"value":"hunter2"}}`,
    ]) {
      const out = scrubSecrets(src);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("hunter2");
      expect(() => JSON.parse(out)).not.toThrow();
    }
    // A NON-sensitive key keeps its container — this is the half of "leaves
    // well-formed nested structures alone" that still has to hold.
    expect(scrubSecrets(`{"config":{"v":1},"items":[1,2]}`)).toBe(
      `{"config":{"v":1},"items":[1,2]}`,
    );
  });

  it("redacts a container value under every sensitive key, at any depth", () => {
    // Codex P1: `SENSITIVE_UNQUOTED_RE` excludes `{` and `[` from its value
    // class, so no pattern claimed a container and every sensitive key except
    // `authorization` leaked one.
    for (const key of ["password", "token", "api_key", "secret", "private_key"]) {
      const out = scrubSecrets(`{"${key}":{"value":"hunter2"}}`);
      expect(out).not.toContain("hunter2");
      expect(() => JSON.parse(out)).not.toThrow();
    }
    // Codex P2: `authorization` was the exception only because its pattern
    // hand-unrolled three levels of nesting. At four the alternation failed
    // and the catch-all returned `{"authorization":[REDACTED]"}}}},...` —
    // redacted but unparseable. Depth is unbounded in the grammar, so the
    // scan counts delimiters instead of enumerating levels.
    const deep = `{"authorization":{"a":{"b":{"c":{"d":"hunter2"}}}},"tail":"K"}`;
    const out = scrubSecrets(deep);
    expect(out).not.toContain("hunter2");
    expect(JSON.parse(out).tail).toBe("K");
    // A delimiter inside a string value must not move the depth.
    const braceInString = `{"token":{"a":"}"},"tail":"K"}`;
    expect(JSON.parse(scrubSecrets(braceInString)).tail).toBe("K");
  });

  it("fails closed when the container scan cannot vouch for the extent", () => {
    // Codex P1, the round after the container fix. `containerEnd` returning
    // "not a container" on an oversized span was a fail-OPEN: the generic
    // patterns deliberately refuse values starting with `{`/`[`, so nothing
    // claimed the value at all.
    const pad = "x".repeat(66 * 1024);
    const oversized = `{"password":{"pad":"${pad}","value":"hunter2"}}`;
    expect(scrubSecrets(oversized)).not.toContain("hunter2");

    // Codex P1, same round: a combined depth let a `]` close a `{`, so only
    // `{]` was replaced and the bare credential stayed in the tail. The scan
    // stacks delimiter TYPES.
    expect(scrubSecrets(`{"password":{]hunter2,"tail":"K"}`)).not.toContain(
      "hunter2",
    );
    // An unterminated container is the truncated-payload shape and is unsafe
    // for the same reason.
    expect(scrubSecrets(`{"password":{"value":"hunter2"`)).not.toContain(
      "hunter2",
    );
    // A balanced container is still redacted precisely, tail intact.
    expect(JSON.parse(scrubSecrets(`{"password":{"v":1},"tail":"K"}`)).tail).toBe(
      "K",
    );
  });

  it("does not treat a run-on word as sensitive just because its value is a container", () => {
    // Codex P2, same round. `KEY_CAMEL` needs a case-SENSITIVE match to see
    // the lowercase-to-uppercase boundary; folding it into a combined `gi`
    // regex case-folded that boundary away, so `mytoken` and `notpassword`
    // matched and their containers were deleted — while the scalar patterns
    // kept them. This is the trap documented above SENSITIVE_WORDS, reached
    // from the other side.
    for (const k of ["mytoken", "notpassword", "xsecret"]) {
      expect(scrubSecrets(`{"${k}":{"ordinary":"safe"}}`)).toBe(
        `{"${k}":{"ordinary":"safe"}}`,
      );
    }
    // A genuine camelCase credential key still loses its container.
    for (const k of ["myToken", "clientSecret", "apiKey"]) {
      const out = scrubSecrets(`{"${k}":{"v":"hunter2"}}`);
      expect(out).not.toContain("hunter2");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("redacts a container named credentials, in both spellings", () => {
    // Codex P1. `isCredentialContainerPath("credentials")` was already true
    // and the connector walk marks everything beneath it sensitive; only the
    // shape scrubber disagreed, so a hook that serializes an environment-derived
    // bundle put it on stdout whole. Both matchers needed it: KEY_START anchors
    // on the separator in `credentials`, and nothing anchors `awsCredentials`
    // except the case-sensitive camel transition.
    for (const k of [
      "credentials",
      "credential",
      "awsCredentials",
      "appCredential",
    ]) {
      for (const v of [`{"pat":"hunter2"}`, `["hunter2"]`]) {
        const out = scrubSecrets(`{"${k}":${v}}`);
        expect(out, `${k} -> ${v}`).not.toContain("hunter2");
        expect(out, `${k} -> ${v}`).toContain("[REDACTED]");
      }
    }
  });

  it("keeps a SCALAR credentials value, which is a path and not a secret", () => {
    // The other half of the rule above, and the reason `credentials?` is in the
    // container-only vocabulary rather than the shared one: the container
    // matchers carry a `(?=[{[])` lookahead, so a filename keeps the diagnostic
    // that redact-rather-than-drop exists to preserve.
    for (const k of ["credentials", "credential", "awsCredentials"]) {
      expect(scrubSecrets(`{"${k}":"./creds.json"}`)).toContain("./creds.json");
    }
  });

  it("redacts a container behind a PLURAL key, service-prefixed or bare", () => {
    // Codex P1, the round after the plural fix landed in the connector walk.
    // That fix only covered values arriving as action PARAMETERS; a classify
    // hook or SDK error that serializes an environment-derived bundle reaches
    // the envelope through scrubSecrets alone, with no candidate set behind
    // it, and neither container matcher knew the plural. Measured, the gap was
    // wider than reported: the bare `tokens` leaked too, not just the
    // service-prefixed forms.
    //
    // The `s?` is safe HERE and not on the scalar path, which is the whole
    // point: `max_tokens` is a count, and a count is never spelled `{` or `[`,
    // so the `(?=[{[])` lookahead settles the ambiguity the name cannot.
    for (const k of [
      "tokens",
      "github_tokens",
      "githubTokens",
      "db_passwords",
      "dbPasswords",
      "credentials",
    ]) {
      for (const v of [`{"p":"hunter2"}`, `["hunter2"]`]) {
        const out = scrubSecrets(`{"${k}":${v}}`);
        expect(out, `${k} -> ${v}`).not.toContain("hunter2");
      }
    }
    // And the count the plural collides with is still a diagnostic, because it
    // is a scalar and no container matcher can reach it.
    expect(scrubSecrets(`{"max_tokens":4096}`)).toContain("4096");
    expect(scrubSecrets(`{"maxTokens":4096}`)).toContain("4096");
  });

  it("treats a backtick as a container string delimiter", () => {
    // Codex P1. `util.inspect` switches to backtick quoting when a string
    // holds both a single and a double quote, so a `}` inside that string
    // closed the container scan early: the marker landed mid-string, the tail
    // of the secret survived, AND the payload came back malformed. Built with
    // util.inspect rather than hand-written so the premise cannot drift.
    const rendered = inspect({ password: { ordinary: "}'\"hunter2" }, tail: "K" });
    expect(rendered).toContain("`");
    const out = scrubSecrets(rendered);
    expect(out).not.toContain("hunter2");
    // The sibling after the container survives — this was corrupted before.
    expect(out).toContain("tail: 'K'");
  });

  it("redacts authorization behind a service prefix, every separator", () => {
    // Codex P1. `isSensitiveFieldPath("github_authorization")` was true while
    // scrubSecrets returned the value whole: `authorization` is deliberately
    // absent from SENSITIVE_WORDS, and each of the five AUTH patterns anchors
    // on the BARE word — one needs a quote immediately before it, two need it
    // to touch its `:`. `\b` cannot rescue them because `_` is itself a word
    // character. Measured, every separator spelling leaked, not just the one
    // reported.
    for (const k of [
      "github_authorization",
      "gh-authorization",
      "client_authorization",
      "githubAuthorization",
    ]) {
      expect(scrubSecrets(`{"${k}":"hunter2"}`), k).not.toContain("hunter2");
    }
  });

  it("leaves the bare authorization header to the AUTH patterns", () => {
    // The reason the rule above is COMPOUND-only. The AUTH family preserves
    // the scheme and consumes a whole multi-parameter list; a generic key
    // match would blank the scheme instead, and stop at the first parameter.
    const out = scrubSecrets(
      'ctx "authorization": AWS4-HMAC-SHA256 Credential="AKIA/foo", Signature="hunter2"',
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("AKIA/foo");
  });

  it("keeps a container member quoted when the key matched at its SUFFIX", () => {
    // Codex P2, against my own previous commit. The container matchers anchor
    // on KEY_START, which `_` satisfies, so on `{"github_token":…}` the match
    // begins at `token` and the capture is `token"` — no opening quote. A
    // member test that reads the capture alone therefore called a real JSON
    // member prose and emitted a bare marker into a value position.
    //
    // Worth pinning in both directions, because the previous commit fixed the
    // prose half and broke this half in the same edit.
    for (const k of [
      "github_token",
      "github_tokens",
      "github_password",
      "token",
      "credentials",
      "githubToken",
    ]) {
      const out = scrubSecrets(
        JSON.stringify({ [k]: { value: "hunter2" }, tail: "K" }),
      );
      expect(out, k).not.toContain("hunter2");
      expect(() => JSON.parse(out), `${k} -> ${out}`).not.toThrow();
      expect((JSON.parse(out) as { tail: string }).tail, k).toBe("K");
    }
    // And the prose half still holds: a quote precedes that key run too — the
    // containing string's own — but the capture has no trailing quote, so it
    // is still read as prose and the marker stays bare.
    const prose = scrubSecrets(
      JSON.stringify({ message: "github_token=[]", tail: "K" }),
    );
    expect(() => JSON.parse(prose), prose).not.toThrow();
    expect(prose).toContain("github_token=[REDACTED]");
  });

  it("quotes the marker for a MEMBER and not for prose, whatever the separator", () => {
    // Codex P2 against my own previous fix here, which keyed on the separator.
    // `:` appears in prose as readily as in JSON, so `prefix token: abc` inside
    // a string was treated as an object member and got quotes that ended the
    // containing string: `{"message":"prefix token: "[REDACTED]"","tail":"K"}`.
    // This shape is the one case in this file where origin/main was VALID and
    // this branch was not — main leaves the secret alone entirely — so it is a
    // regression this PR introduced rather than a gap it failed to close.
    //
    // The key answers it independently of the separator: a member has a quoted
    // key, prose does not.
    const prose = [
      JSON.stringify({ message: "prefix token: abc", tail: "K" }),
      JSON.stringify({ message: "prefix password: hunter2", tail: "K" }),
    ];
    for (const input of prose) {
      const out = scrubSecrets(input);
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("abc");
      expect(() => JSON.parse(out), out).not.toThrow();
      expect((JSON.parse(out) as { tail: string }).tail).toBe("K");
    }
    // A real member still gets the quotes it needs, with either separator.
    expect(scrubSecrets(`{"token":12345}`)).toBe(`{"token":"[REDACTED]"}`);
    expect(scrubSecrets(`{"password": hunter2}`)).toBe(
      `{"password": "[REDACTED]"}`,
    );
    // And the quote it gets is the quote its key carried: closing a repr
    // member with `"` is as unparseable as not closing it.
    expect(scrubSecrets(`{'token': 12345}`)).toBe(`{'token': '[REDACTED]'}`);
  });

  it("consumes escaped delimiters in a value inside a JSON string", () => {
    // Codex P1, the round after the simple in-string case. A `}` is structural
    // in plain text and NOT structural inside a serialized string, and the
    // matcher took the first reading: the marker landed after `abc` and the
    // rest of the secret survived verbatim. The tell is an escaped quote —
    // `\"` only appears where a JSON string is quoted inside another — so the
    // delimiters up to the next UNESCAPED quote belong to the value.
    for (const secret of ["abc'\"}hunter2", "abc'\"}hunter2 tail", "plain"]) {
      const input = JSON.stringify({ message: `password=${secret}`, tail: "K" });
      const out = scrubSecrets(input);
      expect(out, secret).not.toContain("hunter2");
      expect(() => JSON.parse(out), out).not.toThrow();
      expect((JSON.parse(out) as { tail: string }).tail).toBe("K");
    }
  });

  it("redacts a backtick-quoted SCALAR value", () => {
    // Codex P1, and the scalar sibling of the container fix one round earlier:
    // `util.inspect` reaches for backticks whenever a string holds both quote
    // kinds, and without a branch of its own the value fell through to the
    // unquoted pattern, which stops at the first delimiter INSIDE it.
    for (const obj of [
      { password: "abc'\"}hunter2", tail: "K" },
      { apiKey: "x'\"y-hunter2", tail: "K" },
    ]) {
      const raw = inspect(obj);
      expect(raw).toContain("`");
      const out = scrubSecrets(raw);
      expect(out, raw).not.toContain("hunter2");
      // The marker keeps the quoting it replaced, and the sibling survives.
      expect(out).toContain("`[REDACTED]`");
      expect(out).toContain("tail: 'K'");
    }
  });

  it("does not redact an already-redacted value a second time", () => {
    // The guard on the in-JSON-string branch. Every other value class excludes
    // the quote a marker opens with, so none can re-claim one; that branch has
    // no first-character restriction and re-redacted the escaped-quote
    // pattern's own output into a broken marker. Idempotence is the assertion
    // that catches this class generally.
    for (const input of [
      String.raw`password=\"hunter2\"`,
      JSON.stringify({ message: "password=abc'\"}hunter2" }),
      inspect({ password: "abc'\"}hunter2" }),
    ]) {
      const once = scrubSecrets(input);
      expect(scrubSecrets(once), once).toBe(once);
    }
  });

  it("keeps a payload parseable when the credential is inside a JSON string", () => {
    // Codex P2. A `key=value` literal embedded in a JSON string got a marker
    // wrapped in quotes the input never had, so the containing string ended
    // early and the document stopped parsing. No leak either way — this is the
    // payload-integrity property, the same one the container scan protects.
    for (const input of [
      JSON.stringify({ message: "password=hunter2", tail: "K" }),
      JSON.stringify({ message: "token=abc123", tail: "K" }),
      JSON.stringify({ msg: "connect failed: api_key=zzz" }),
    ]) {
      const out = scrubSecrets(input);
      expect(out).not.toContain("hunter2");
      expect(() => JSON.parse(out), out).not.toThrow();
      // The sibling after the string survives.
      const parsed = JSON.parse(out) as Record<string, unknown>;
      if ("tail" in parsed) expect(parsed["tail"]).toBe("K");
    }
    // The `:` member still gets its quotes, which is why they existed:
    // `{"token":[REDACTED]}` does not parse.
    expect(scrubSecrets(`{"token":12345}`)).toBe(`{"token":"[REDACTED]"}`);
  });

  it("does not treat a run-on credentials word as a container key", () => {
    // The run-on exclusion documented above SENSITIVE_WORDS, checked against
    // the word this change added rather than assumed to carry over.
    for (const k of ["mycredentials", "credentialsx", "credentialing"]) {
      expect(scrubSecrets(`{"${k}":{"ordinary":"safe"}}`)).toBe(
        `{"${k}":{"ordinary":"safe"}}`,
      );
    }
  });

  it("redacts an encrypted PEM including its RFC 1421 metadata", () => {
    // Codex P1: `Proc-Type:` and `DEK-Info:` carry `:`, `,` and `-`, which are
    // outside the base64 body class, so the complete-block match failed and
    // the truncated-block fallback removed only the BEGIN header — the
    // metadata, the body and the END marker all survived.
    const body =
      "MIIEowIBAAKCAQEAvBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const lines = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,7A9B2C3D4E5F60718293A4B5C6D7E8F9",
      "",
      body,
      "-----END RSA PRIVATE KEY-----",
    ];
    // Real newlines and the `\n` escapes a serialized PEM arrives with.
    for (const sep of ["\n", "\\n"]) {
      const out = scrubSecrets(`load failed: ${lines.join(sep)} (retry)`);
      expect(out).not.toContain("DEK-Info");
      expect(out).not.toContain(body);
      expect(out).not.toContain("END RSA PRIVATE KEY");
      expect(out).toContain("[REDACTED]");
      expect(out).toContain("(retry)");
    }
    // A truncated encrypted block — metadata present, END marker absent.
    const truncated = scrubSecrets(`load failed: ${lines.slice(0, 5).join("\n")}`);
    expect(truncated).not.toContain("DEK-Info");
    expect(truncated).not.toContain(body);
    // `Proc-Type:` outside a PEM is ordinary prose.
    expect(scrubSecrets("Proc-Type: not a pem")).toBe("Proc-Type: not a pem");
  });

  it("unquoted redaction is idempotent and leaves quoted forms alone", () => {
    const once = scrubSecrets("SET password='hunter2'");
    expect(once).toBe("SET password='[REDACTED]'");
    expect(scrubSecrets(once)).toBe(once);
  });

  it("redacts compound credential field names", () => {
    // Regression (Codex P2, third round): `_` is a word character, so
    // `\btoken\b` missed `session_token` and `\bsecret\b` / `\baccess_key\b`
    // both missed `secret_access_key` — the field names
    // src/connectors/aws/cli.ts uses for AWS credentials.
    expect(scrubSecrets(`{"session_token":"hunter2"}`)).toBe(
      `{"session_token":"[REDACTED]"}`,
    );
    expect(scrubSecrets(`{"secret_access_key":"hunter2"}`)).toBe(
      `{"secret_access_key":"[REDACTED]"}`,
    );
    expect(scrubSecrets("secret_access_key='hunter2'")).toBe(
      "secret_access_key='[REDACTED]'",
    );
    expect(scrubSecrets("refresh-token=abc123")).toBe(
      "refresh-token=[REDACTED]",
    );
  });

  it("redacts Authorization headers embedded mid-string", () => {
    // Regression (Codex P2, fourth round): thrown messages routinely carry a
    // prefix, so the header is neither quote-preceded nor at a line start
    // and both anchored patterns missed it.
    expect(scrubSecrets("request failed: Authorization: Bearer abc.def")).toBe(
      "request failed: Authorization: Bearer [REDACTED]",
    );
    expect(scrubSecrets("upstream 401 (authorization=Token xyz789)")).not.toContain(
      "xyz789",
    );
  });

  it("the inline Authorization pattern cannot mangle surrounding JSON", () => {
    // The original single-unanchored-pattern regression: a greedy value class
    // consumed past the JSON value's closing quote, producing unterminated
    // JSON. Excluding quotes from the value class is what makes the
    // unanchored pass safe.
    expect(scrubSecrets(`{"message":"authorization: Bearer abc"}`)).toBe(
      `{"message":"authorization: Bearer [REDACTED]"}`,
    );
    expect(scrubSecrets(`{"authorization": "Token abc123"}`)).toBe(
      `{"authorization": "[REDACTED]"}`,
    );
  });

  it("matches a sensitive keyword only as a whole trailing segment", () => {
    // Deliberate boundary, not an oversight. The keyword must run to the end
    // of the field name, so a trailing segment stops the match:
    // `access_key_id` is AWS's non-secret key identifier (the username half
    // of the pair), and widening to arbitrary suffixes would re-introduce
    // the over-redaction that the `\b` boundaries were added to prevent —
    // `token_count`, `password_hint` and friends would start erasing debug
    // context. The secret half, `secret_access_key`, IS matched above.
    expect(scrubSecrets(`{"access_key_id":"AKIA123"}`)).toBe(
      `{"access_key_id":"AKIA123"}`,
    );
  });

  it("redacts the password in a connection-URL userinfo", () => {
    // Regression (Codex P2, fifth round): every other pattern keys off a
    // field name, but a DSN carries the credential positionally, so a driver
    // error echoing its connection string matched nothing and leaked whole.
    // src/connectors/db/lib/drivers/mongodb.ts builds exactly this shape.
    expect(scrubSecrets("mongodb://user:hunter2@host:27017")).toBe(
      "mongodb://user:[REDACTED]@host:27017",
    );
    expect(
      scrubSecrets("connect failed: postgres://admin:p%40ss@db.internal/app"),
    ).toBe("connect failed: postgres://admin:[REDACTED]@db.internal/app");
    expect(scrubSecrets("mongodb+srv://u:pw@cluster.example.net")).toBe(
      "mongodb+srv://u:[REDACTED]@cluster.example.net",
    );
  });

  it("URL userinfo redaction keeps the rest of the URL and is idempotent", () => {
    // The value class excludes `/` and `@` so the match stops at the
    // authority instead of swallowing the path — the same greedy-consumption
    // guard the AUTH patterns carry.
    const once = scrubSecrets("mongodb://user:hunter2@host:27017/db?tls=true");
    expect(once).toBe("mongodb://user:[REDACTED]@host:27017/db?tls=true");
    expect(scrubSecrets(once)).toBe(once);
    expect(scrubSecrets(`{"dsn":"mongodb://u:pw@h/db"}`)).toBe(
      `{"dsn":"mongodb://u:[REDACTED]@h/db"}`,
    );
  });

  it("leaves credential-free URLs alone", () => {
    // A colon-less userinfo is left alone by design: that position is far
    // more often a bare username than a token.
    expect(scrubSecrets("GET https://api.example.com/v1/users?id=7")).toBe(
      "GET https://api.example.com/v1/users?id=7",
    );
    expect(scrubSecrets("postgres://myuser@localhost/db")).toBe(
      "postgres://myuser@localhost/db",
    );
  });

  it("does not redact non-sensitive keys that merely end in a sensitive token", () => {
    // Regression (Codex P2 on 0733e81): removing `\b` caused
    // `mytoken='x'` / `notpassword='x'` to match the `token`/`password`
    // suffix and erase unrelated debug context.
    expect(scrubSecrets("mytoken='x'")).toBe("mytoken='x'");
    expect(scrubSecrets("notpassword='x'")).toBe("notpassword='x'");
    expect(scrubSecrets('xsecret="y"')).toBe('xsecret="y"');
    // The bare sensitive keyword still matches.
    expect(scrubSecrets("token='x'")).toBe("token='[REDACTED]'");
    // Hyphenated variants still match.
    expect(scrubSecrets("api-key='x'")).toBe("api-key='[REDACTED]'");
  });

  it("handles long unterminated quote strings linearly", () => {
    const start = performance.now();
    const payload = 'password="' + '\\a'.repeat(100000) + '!';
    scrubSecrets(payload);
    const duration = performance.now() - start;
    // Bounded well under 1 second
    expect(duration).toBeLessThan(1000);
  });

  it("handles JSON-escaped quotes inside double-quoted secret values", () => {
    // Regression (Codex P1 on 683b907): `"[^"]*"` terminated at the escaped
    // quote inside `"abc\"def"`, leaving `def"}` in the log.
    expect(scrubSecrets(`{"password":"abc\\"def"}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    expect(scrubSecrets(`{"token":"a\\"b\\"c"}`)).toBe(
      `{"token":"[REDACTED]"}`,
    );
    // Single-quoted form mirrored.
    expect(scrubSecrets(`{password:'a\\'b'}`)).toBe(`{password:'[REDACTED]'}`);
  });

  it("handles JSON-escaped quotes inside quoted Authorization values", () => {
    // Regression (Codex P1 on 683b907): the quoted branch's value class
    // used to terminate at the first `"` even when it was escaped, so
    // JSON-encoded Digest headers leaked their `response=` tail.
    const input = `{"authorization":"Digest username=\\"u\\", response=\\"abc123\\""}`;
    const out = scrubSecrets(input);
    expect(out).toBe(`{"authorization":"[REDACTED]"}`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("response");
  });

  it("does not mangle JSON when 'authorization' appears inside a string value", () => {
    // Regression (Codex P2 on 6e3bf0f): the unquoted AUTH branch's
    // `[^\r\n]+` value class used to consume the JSON closing `"` and
    // `}`, producing unterminated JSON for inputs like
    // `{"message":"authorization: Bearer abc"}`.
    const input = `{"message":"authorization: Bearer abc"}`;
    const out = scrubSecrets(input);
    // The credential must still be redacted, but the JSON structure
    // must remain valid.
    expect(out).toBe(`{"message":"authorization: Bearer [REDACTED]"}`);
    expect(out).not.toContain("abc");
    // Structural sanity: still parseable as JSON.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("still redacts HTTP-style Authorization headers at line start", () => {
    // The line-anchored pattern handles `^Authorization:` and the
    // post-`\n` form. We accept that mid-line non-JSON occurrences are
    // not matched (trade-off for not mangling JSON).
    expect(scrubSecrets("Authorization: Bearer abc")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    const multiline = "GET /api\nAuthorization: Bearer xyz\nHost: example.com";
    const out = scrubSecrets(multiline);
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).not.toContain("xyz");
    expect(out).toContain("Host: example.com");
  });
});

describe("AuditWriter", () => {
  it("disabled writer is a no-op", () => {
    const w = createAuditWriter({ enabled: false });
    expect(() => w.logEvent({ event_type: "action" } as never)).not.toThrow();
    expect(w.enabled).toBe(false);
    // No path — nothing to read back.
  });

  it("enabled writer requires a path", () => {
    expect(() => createAuditWriter({ enabled: true })).toThrow(/'path' is required/);
  });

  it("appends JSONL with stamped timestamp + session_id", () => {
    const logPath = path.join(tmpDir, "events.jsonl");
    const w = createAuditWriter({ enabled: true, path: logPath, sessionId: "abc123" });
    w.logEvent({ event_type: "action", connector: "aws", action: "list_functions" } as never);
    w.logEvent({ event_type: "action", connector: "aws", action: "describe_db" } as never);

    const raw = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(raw).toHaveLength(2);
    const first = JSON.parse(raw[0]!);
    expect(first.event_type).toBe("action");
    expect(first.session_id).toBe("abc123");
    expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(first.action).toBe("list_functions");
  });

  it("creates parent directory if missing", () => {
    const logPath = path.join(tmpDir, "nested", "deep", "events.jsonl");
    const w = createAuditWriter({ enabled: true, path: logPath });
    w.logEvent({ event_type: "test" } as never);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("swallows disk errors (does not throw into caller)", () => {
    // Write to /dev/null/impossible (not writable) — should not raise.
    const w = createAuditWriter({
      enabled: true,
      path: "/dev/null/cannot/create/here",
    });
    expect(() => w.logEvent({ event_type: "test" } as never)).not.toThrow();
  });

  it("generates a random sessionId when not provided", () => {
    const w = createAuditWriter({ enabled: false });
    expect(w.sessionId).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("isSensitiveFieldPath", () => {
  it("recognises credential field paths in every spelling", () => {
    for (const path of [
      "password",
      "api_key",
      "apiKey",
      "secretAccessKey",
      "auth.token",
      "creds.password",
      "a.b.sessionToken",
    ]) {
      expect(isSensitiveFieldPath(path)).toBe(true);
    }
  });

  it("matches a credential word after ANY prefix, not only the enumerated ones", () => {
    // `KEY_PREFIX` enumerates credential-side prefixes (`secret`, `session`,
    // `access`, …), which covers `secret_access_key` and misses the far
    // commoner SERVICE-side naming. Every one of these is an ordinary field
    // holding a real credential, and every one contributed no candidate.
    for (const path of [
      "github_token",
      "githubToken",
      "gitlab_token",
      "slack_token",
      "db_password",
      "dbPassword",
      "stripe_secret",
      "user_api_key",
      "userApiKey",
      "githubApiKey",
      "params.github_token",
      "a[0].db_password",
    ]) {
      expect(isSensitiveFieldPath(path), path).toBe(true);
    }
  });

  it("a plural count with an arbitrary prefix stays benign", () => {
    // The `s?` plural exists for a CONTAINER (`{tokens: [...]}`), which is
    // meaningful when the prefix is itself a credential word. With an
    // arbitrary prefix it collides with counts, and matching those blanks an
    // ordinary validation diagnostic. So the arbitrary-prefix rule is
    // singular-only, while `tokens` and `api_keys` still match on their own.
    for (const path of ["max_tokens", "estimated_tokens", "total_estimated_tokens", "maxTokens"]) {
      expect(isSensitiveFieldPath(path), path).toBe(false);
    }
    for (const path of ["tokens", "api_keys"]) {
      expect(isSensitiveFieldPath(path), path).toBe(true);
    }
  });

  it("the run-on exclusion survives the generalized prefix", () => {
    // A separator or a camel boundary is REQUIRED, so widening the prefix
    // cannot start redacting a word that merely contains a credential term.
    for (const path of [
      "mytoken",
      "notpassword",
      "xsecret",
      "author",
      "authority",
      "authorId",
      "tokenizer",
      "tokenized",
      "passwordless",
      "secretary",
      "secretariat",
    ]) {
      expect(isSensitiveFieldPath(path), path).toBe(false);
    }
  });

  it("the credential word must be TERMINAL under the generalized prefix", () => {
    for (const path of ["access_key_id", "password_hint", "token_count", "tokenCount", "token_budget"]) {
      expect(isSensitiveFieldPath(path), path).toBe(false);
    }
  });

  it("does not match a key word that is only a prefix of the segment", () => {
    // The path check throws away a whole diagnostic message, so over-matching
    // costs information rather than erring safe. `access_key_id` and
    // `password_hint` are not credentials, and the scrubber already leaves
    // them alone because no separator follows the key word — the path check
    // has no separator to anchor on, so it anchors on the segment end.
    for (const path of ["access_key_id", "password_hint", "token_count"]) {
      expect(isSensitiveFieldPath(path)).toBe(false);
    }
  });

  it("does not match benign paths that merely contain a key word", () => {
    // `passwordless` is the one that matters: the key boundary has to hold
    // here or every schema field starting with a credential word gets its
    // diagnostic message thrown away.
    for (const path of [
      "name",
      "mytoken",
      "notpassword",
      "passwordless",
      "user.email",
      "limit",
    ]) {
      expect(isSensitiveFieldPath(path)).toBe(false);
    }
  });
});

describe("scrubSecrets — credential leak matrix", () => {
  // Four rounds of review each reported one more shape of the same bug, and
  // each fix covered one pattern family and missed its siblings. Enumerating
  // the cross-product instead of hand-picking examples is what closed it: the
  // first run of this matrix found 567 leaking combinations across 1440, from
  // two root causes, where the two reported cases were single cells.
  const SECRET = "hunter2XYZ";
  const KEYS = [
    "password",
    "token",
    "api_key",
    "secretAccessKey",
    // A service-account credential. `KEY_PREFIX` could consume `private`, but
    // with no `key` word to complete it the value passed through intact.
    "private_key",
    "privateKey",
    "authorization",
  ];
  const KEY_FORMS: Array<(k: string) => string> = [
    (k) => k,
    (k) => `"${k}"`,
    (k) => `\\"${k}\\"`,
    // Single-quoted keys: a Python-style repr of a credential object reaches
    // these logs as readily as JSON does.
    (k) => `'${k}'`,
    (k) => `\\'${k}\\'`,
  ];
  const VALUE_FORMS: Array<(v: string) => string> = [
    (v) => v,
    (v) => `"${v}"`,
    (v) => `'${v}'`,
    (v) => `\\"${v}\\"`,
    (v) => `\\'${v}\\'`,
    (v) => `"${v}`,
    (v) => `'${v}`,
    (v) => `\\"${v}`,
    // An escaped quote *inside* the value, not merely around it. Review found
    // this axis after the first matrix shipped: the escaped branch treated the
    // inner quote as its terminator and returned the tail of the credential.
    (v) => `\\"pre\\\\\\"${v}\\"`,
    // No opening delimiter at all, and a quote part-way through the value.
    // The unquoted branch excluded the quote from its trailing class, so it
    // consumed `pre` and stopped, emitting `password="[REDACTED]""hunter2`
    // with the tail intact. An internal quote cannot end a value that never
    // opened one, so the branch has to run to a real delimiter instead.
    (v) => `pre"${v}`,
    (v) => `pre'${v}`,
  ];
  const CONTEXTS: Array<(b: string) => string> = [
    (b) => b,
    (b) => `request failed: ${b}`,
    (b) => `{${b}}`,
    (b) => `request payload: {${b}}`,
  ];
  const SEPARATORS = [": ", "=", ":"];
  /**
   * Digest parameter lists, varying which parameters are quoted. `q` marks a
   * quoted value, `t` a bare token; RFC 7616 allows both in one list and only
   * requires quoting for `username`, `realm`, `nonce`, `uri`, `response`,
   * `cnonce` and `opaque` — `algorithm`, `qop` and `nc` are sent bare.
   */
  const DIGEST_PARAM_SHAPES: Array<(secret: string) => string> = [
    (s) => `username="alice", response="${s}"`,
    (s) => `username=alice, response=${s}`,
    (s) => `username="alice", algorithm=MD5, response="${s}"`,
    (s) => `username=alice, algorithm="MD5", response=${s}`,
    (s) => `algorithm=MD5, response="${s}"`,
    (s) => `username="alice", nc=00000001, qop=auth, response="${s}", opaque="x"`,
    (s) => `username="alice",response="${s}"`,
    (s) => `username="alice" , response="${s}"`,
    // Escaped quoting, which is how a Digest header arrives once the error
    // carrying it has been serialized into another string. The params branch
    // required a bare quote, so these fell through to the inline branch and
    // stopped at the first quote with `response` still standing.
    (s) => `username=\\"alice\\", response=\\"${s}\\"`,
    (s) => `username=\\"alice\\", algorithm=MD5, response=\\"${s}\\"`,
    (s) => `username=\\'alice\\', algorithm=MD5, response=\\'${s}\\'`,
    // Parameter NAMES are an HTTP token, not `\w+`. RFC 7616 defines
    // `username*` for the RFC 5987 extended encoding, whose value carries
    // apostrophes (`charset'language'value`) that the plain token class
    // excludes — so both the name and the value needed widening, and a
    // token-only rule stopped at `UTF-8`.
    (s) => `username*=UTF-8''alice, response="${s}"`,
    (s) => `username*=UTF-8'en'alice, algorithm=MD5, response="${s}"`,
    // Other token characters the old `\w+` rejected.
    (s) => `user-name="alice", x.y=1, response="${s}"`,
    (s) => `username="alice", algorithm=MD5-sess, response="${s}"`,
    // A quoted-pair INSIDE a parameter value, rather than escaped delimiters
    // around it. The params branch matched each value lazily up to the next
    // bare quote, so the `\"` in a non-final parameter ended that parameter
    // early, the list walk stopped there, and every parameter after it —
    // `response` included — stayed in the message.
    (s) => `username="alice", opaque="a\\"b", response="${s}"`,
    (s) => `username="a\\"b", response="${s}"`,
    (s) => `username="alice", opaque="a\\"b", nc=1, response="${s}"`,
    (s) => `username="alice", opaque="tail\\"", response="${s}"`,
  ];

  function everyShape(): string[] {
    const out: string[] = [];
    for (const key of KEYS) {
      const isAuth = key === "authorization";
      for (const kf of KEY_FORMS) {
        for (const vf of VALUE_FORMS) {
          for (const sep of SEPARATORS) {
            for (const ctx of CONTEXTS) {
              out.push(ctx(`${kf(key)}${sep}${vf(isAuth ? `Bearer ${SECRET}` : SECRET)}`));
              // Scheme placement is its own axis: `Authorization: "Bearer x"`
              // and `Authorization: Bearer "x"` reach different branches, and
              // the second was unhandled for the escaped forms.
              if (isAuth) {
                out.push(ctx(`${kf(key)}${sep}Bearer ${vf(SECRET)}`));
                // A parameterised scheme is a third shape: the value is a list
                // of `key="value"` pairs, so every single-token branch stopped
                // at the first quote and left `response` standing.
                //
                // Parameter *quoting* is its own axis. The first matrix only
                // ever built all-quoted lists, and the params branch required
                // every parameter to be quoted — so a real header mixing
                // quoted and token values (`username="alice", algorithm=MD5,
                // response="…"`, which RFC 7616 permits and servers send)
                // failed that branch, fell through to the quoted branch, and
                // stopped at the first quote with `response` still standing.
                for (const shape of DIGEST_PARAM_SHAPES) {
                  out.push(ctx(`${kf(key)}${sep}Digest ${shape(SECRET)}`));
                }
              }
            }
          }
        }
      }
    }
    return out;
  }

  it("leaks no credential in any key/value/separator/context combination", () => {
    const leaked = everyShape().filter((s) => scrubSecrets(s).includes(SECRET));
    expect(leaked).toEqual([]);
  });

  it("is idempotent over every combination", () => {
    const unstable = everyShape().filter((s) => {
      const once = scrubSecrets(s);
      return scrubSecrets(once) !== once;
    });
    expect(unstable).toEqual([]);
  });
});

describe("scrubSecrets — private-key vocabulary", () => {
  it("redacts compound private-key fields", () => {
    for (const k of ["private_key", "privateKey", "private-key", "PRIVATE_KEY"]) {
      for (const q of ["'", '"']) {
        expect(scrubSecrets(`${k}=${q}hunter2${q}`)).not.toContain("hunter2");
      }
      expect(scrubSecrets(`{"${k}":"hunter2"}`)).not.toContain("hunter2");
    }
  });

  it("does not redact ordinary *_key columns", () => {
    // Why the compound is named rather than adding a bare `key` alternative:
    // these are ordinary SQL and config fields, and redacting them would
    // destroy the message the log exists to carry.
    for (const k of ["primary_key", "sort_key", "partition_key", "foreign_key", "key"]) {
      expect(scrubSecrets(`${k}="not-a-secret"`)).toContain("not-a-secret");
    }
  });
});

describe("scrubSecrets — PEM private keys", () => {
  // Every value pattern treats whitespace as a terminator, which is right for
  // a token and wrong for PEM: the body is newline-separated, so
  // `private_key=-----BEGIN PRIVATE KEY-----\nMIIE...` redacted the first
  // token and left the key material standing.
  const BODY = "MIIEhunter2secret";
  const pem = (kind: string): string =>
    `-----BEGIN ${kind}-----\n${BODY}\n-----END ${kind}-----`;

  it("redacts armored key material in every context", () => {
    const key = pem("PRIVATE KEY");
    for (const input of [
      `private_key=${key}`,
      `private_key="${key}"`,
      key,
      pem("RSA PRIVATE KEY"),
      pem("EC PRIVATE KEY"),
      `failed to parse: ${key} (bad)`,
      JSON.stringify({ private_key: key, user: "bob" }),
      JSON.stringify(JSON.stringify({ private_key: key })),
    ]) {
      expect(scrubSecrets(input)).not.toContain(BODY);
    }
  });

  it("redacts an unterminated block, which is the parser-error shape", () => {
    // A truncated key is what an error echoing incomplete material carries,
    // and the terminated pattern cannot match it — so it fell through to the
    // field rules, which redacted `-----BEGIN` as the value and left the body
    // on the next line. Four shapes leaked, not the one reported.
    const B = "MIIEhunter2AAAAAAAAAAAAAAAAAAAA";
    for (const input of [
      `private_key=-----BEGIN PRIVATE KEY-----\n${B}`,
      `-----BEGIN PRIVATE KEY-----\n${B}`,
      `-----BEGIN RSA PRIVATE KEY-----\n${B}\n${B}`,
      `parse failed: -----BEGIN PRIVATE KEY-----\n${B}`,
      JSON.stringify({ private_key: `-----BEGIN PRIVATE KEY-----\n${B}` }),
    ]) {
      expect(scrubSecrets(input)).not.toContain(B);
    }
  });

  it("does not eat the message around an unterminated block", () => {
    // Without a terminator there is nothing to stop at, so the body is matched
    // as base64 LINES rather than base64 characters. Prose is mostly letters:
    // a character class would run on and delete the diagnostic.
    const B = "MIIEhunter2AAAAAAAAAAAAAAAAAAAA";
    const withProse = scrubSecrets(
      `-----BEGIN PRIVATE KEY-----\n${B}\nthe request then failed at line 12`,
    );
    expect(withProse).not.toContain(B);
    expect(withProse).toContain("the request then failed at line 12");

    // A header with no body at all must not consume the sentence after it.
    expect(scrubSecrets("-----BEGIN PRIVATE KEY-----\nplease supply a key")).toContain(
      "please supply a key",
    );

    // And the surrounding JSON payload survives.
    const json = scrubSecrets(
      JSON.stringify({ private_key: `-----BEGIN PRIVATE KEY-----\n${B}`, user: "bob", n: 7 }),
    );
    expect(json).not.toContain(B);
    expect(JSON.parse(json)).toMatchObject({ user: "bob", n: 7 });
  });

  it("keeps the payload parseable for a container-valued authorization", () => {
    // The scalar branch added last round covered number/boolean/null and left
    // the other two JSON value types out, so the catch-all still ran through
    // the container and the structure after it. Five shapes, not the one
    // reported: `{}`, a populated object, `[]`, a populated array, and a
    // nested object.
    for (const raw of [
      '{"authorization":{},"tail":"K"}',
      '{"authorization":{"scheme":"Bearer","t":"abc"},"tail":"K"}',
      '{"authorization":[],"tail":"K"}',
      '{"authorization":["Bearer abc"],"tail":"K"}',
      '{"authorization":{"a":{"b":1}},"tail":"K"}',
      '{"authorization":{"a":[1,2,{"b":3}]},"tail":"K"}',
      // A brace or bracket inside a string must not unbalance the count.
      '{"authorization":{"t":"a}b{c"},"tail":"K"}',
      '{"authorization":["a]b[c"],"tail":"K"}',
      '{"authorization":{"t":"a\\"b"},"tail":"K"}',
    ]) {
      const out = scrubSecrets(raw);
      expect(out, raw).toContain('"[REDACTED]"');
      expect(JSON.parse(out), raw).toMatchObject({ tail: "K" });
      expect(out, raw).not.toContain("abc");
    }
  });

  it("keeps the payload parseable for an authorization scalar", () => {
    // The camelCase branch was corrected to a quoted marker last round; this
    // one still emitted a bare `[REDACTED]`. That was only half the defect:
    // the general unquoted branch also ran past the scalar, consuming the `,`
    // and the NEXT key/value pair, so quoting alone still produced invalid
    // JSON —
    //   before        {"authorization":[REDACTED]"}
    //   quoting only  {"authorization":"[REDACTED]""}
    // Matching the JSON scalar itself stops at its own boundary.
    for (const raw of [
      '{"authorization":123,"tail":"K"}',
      '{"authorization":true,"tail":"K"}',
      '{"authorization":null,"tail":"K"}',
      '{"Authorization":123,"tail":"K"}',
    ]) {
      const out = scrubSecrets(raw);
      expect(out, raw).toContain('"[REDACTED]"');
      expect(JSON.parse(out), raw).toMatchObject({ tail: "K" });
    }
    // A quoted value is untouched by the new branch, scheme preserved.
    expect(scrubSecrets('{"authorization":"Bearer abc","tail":"K"}')).toBe(
      '{"authorization":"Bearer [REDACTED]","tail":"K"}',
    );
    // And a bare header outside JSON keeps its unquoted marker.
    expect(scrubSecrets("authorization: Bearer abc123")).toBe(
      "authorization: Bearer [REDACTED]",
    );
  });

  it("names authorization as a sensitive field in prose", () => {
    // `isSensitiveFieldPath` keys off a structured path; a refinement raised
    // on the object has none, so this prose predicate is the only guard. It
    // used the NARROW vocabulary, which omits `authorization` — the AUTH
    // patterns cover that word for a `key = value` literal, and prose has no
    // literal for them to find. `auth` alone is rejected by the run-on
    // lookahead, so the word matched nothing at all.
    expect(mentionsSensitiveField("authorization rejected hunter2")).toBe(true);
    expect(mentionsSensitiveField("auth failed")).toBe(true);
    expect(mentionsSensitiveField("password rejected")).toBe(true);
    // Run-on words are still not matches — over-matching here costs a dropped
    // message, so the boundary still has to hold.
    for (const t of [
      "unauthorized request",
      "authorize the user",
      "authenticator broke",
      "ordinary failure",
    ]) {
      expect(mentionsSensitiveField(t), t).toBe(false);
    }
  });

  it("redacts a PEM whose line breaks are JSON escapes", () => {
    // An SDK or mapped error that serializes a response object writes the
    // PEM's newlines as the two characters `\\` `n`. The body class accepted
    // only real line breaks, so only the header matched — via the truncated
    // fallback — and every base64 line plus the end marker stood.
    const L = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    const pem = `-----BEGIN PRIVATE KEY-----\n${L}\n${L}\n-----END PRIVATE KEY-----`;
    const truncated = `-----BEGIN PRIVATE KEY-----\n${L}\n${L}`;
    for (const body of [pem, truncated]) {
      const out = scrubSecrets(JSON.stringify({ message: body, user: "bob", n: 7 }));
      expect(out).not.toContain(L);
      expect(out).not.toContain("-----END PRIVATE KEY-----");
      // Payload preserved: this is a redaction, not a truncation.
      expect(JSON.parse(out)).toMatchObject({ user: "bob", n: 7 });
    }
    // A CERTIFICATE is still published by design, escaped or not.
    const cert = `-----BEGIN CERTIFICATE-----\n${L}\n-----END CERTIFICATE-----`;
    expect(scrubSecrets(JSON.stringify({ message: cert }))).toContain(L);
  });

  it("consumes an escaped quote inside an inline Authorization value", () => {
    // Inside JSON a quote in the value is `\\"`. The unquoted branch excluded
    // the backslash, so it stopped there and reported a partial match as
    // complete, leaving the rest of the token standing.
    const out = scrubSecrets(
      JSON.stringify({ message: 'err Authorization: Bearer pre"SECRETVALUE', z: "tail" }),
    );
    expect(out).not.toContain("SECRETVALUE");
    expect(JSON.parse(out)).toMatchObject({ z: "tail" });
  });

  it("bounds an unterminated value at the JSON string, not the end of input", () => {
    // A value whose closing quote never arrives fell to a `[^\\r\\n]*`
    // fallback, and a serialized payload has no newline — so it ran to the end
    // of the document. The credential was redacted and the message destroyed:
    // invalid JSON, every sibling field after it gone.
    //
    // The report named the Authorization parameter form. Measuring the class
    // found the same fallback in the key/value patterns and the escaped-quote
    // patterns: six reachable shapes, all of them doing it.
    const shapes = [
      "request Authorization: Bearer ='x",
      "request Authorization: Bearer 'x",
      "db failed password='x",
      'db failed password="x',
      "svc failed githubToken='x",
      'svc failed githubToken="x',
    ];
    for (const message of shapes) {
      const out = scrubSecrets(JSON.stringify({ message, z: "tail" }));
      expect(() => JSON.parse(out), message).not.toThrow();
      expect(JSON.parse(out), message).toMatchObject({ z: "tail" });
      // Still redacted — the bound must not cost the redaction.
      expect(out, message).toContain("[REDACTED]");
      expect(out, message).not.toMatch(/=['"]?x/);
    }
  });

  it("keeps the redacted payload parseable for a camelCase key", () => {
    // `scrubSecrets` is exported and preserves JSON-shaped payloads, but the
    // service-prefixed branch emitted a BARE marker while the `_`-separated
    // spelling of the same key emitted a quoted one. So a non-string scalar
    // under a camelCase key produced `{"githubToken":[REDACTED]}`, which does
    // not parse — the two spellings disagreed on the same input.
    for (const raw of [
      '{"githubToken":123456}',
      '{"githubToken":true}',
      '{"githubToken":null}',
      '{"gitlabToken":42,"user":"bob"}',
    ]) {
      const out = scrubSecrets(raw);
      expect(out).not.toContain("123456");
      expect(() => JSON.parse(out)).not.toThrow();
    }
    // The value is gone and the rest of the object survives.
    const parsed = JSON.parse(scrubSecrets('{"gitlabToken":42,"user":"bob"}'));
    expect(parsed).toMatchObject({ gitlabToken: "[REDACTED]", user: "bob" });
    // The `_` spelling is unchanged, and the two now agree.
    expect(scrubSecrets('{"github_token":123456}')).toBe(scrubSecrets('{"github_token":123456}'));
  });

  it("redacts every line of an oversized body, terminated or not", () => {
    // The body repetition was capped at 256 lines, so a longer block matched
    // the header plus the first 256 lines and left the rest standing verbatim
    // — a partial match treated as complete. Measured on the capped version:
    // 257 lines leaked 1, 300 leaked 44, 600 leaked 344.
    //
    // The same defect sat at a second site. PEM_BLOCK_RE caps its body at
    // 8192 base64 characters, so a *terminated* block longer than that fails
    // to match and falls through here — where the 256-line cap then leaked
    // 344 of its 600 lines. Removing this cap closes both, because a
    // terminated block's `-----END` line is not base64 and stops the scan on
    // its own.
    //
    // The cap was never what bounds the cost: a body line must start with a
    // newline and carry 16+ unbroken base64 characters, so the scan is a
    // single forward pass with nothing to rescan. The linear-time test below
    // still holds. What bounds cost is PEM_BLOCK_RE's terminator search, and
    // that cap is untouched.
    const LINE = "A".repeat(64);
    for (const n of [256, 257, 300, 600]) {
      const body = Array(n).fill(LINE).join("\n");
      const truncated = `-----BEGIN PRIVATE KEY-----\n${body}`;
      expect(scrubSecrets(truncated)).not.toContain(LINE);
      const terminated = `${truncated}\n-----END PRIVATE KEY-----`;
      expect(scrubSecrets(terminated)).not.toContain(LINE);
    }

    // Still a redaction, not a message drop: the diagnostic after a 500-line
    // body survives.
    const long = Array(500).fill(LINE).join("\n");
    const out = scrubSecrets(
      `parse failed\n-----BEGIN PRIVATE KEY-----\n${long}\nfailed at line 12`,
    );
    expect(out).not.toContain(LINE);
    expect(out).toContain("parse failed");
    expect(out).toContain("failed at line 12");
  });

  it("redacts a body truncated inside its first line", () => {
    // The truncated-block body is matched as base64 LINES of 16+ characters,
    // which is what keeps it from running into prose. A cut inside the first
    // line leaves a shorter fragment, and that fragment sat outside the match:
    // `private_key=-----BEGIN PRIVATE KEY-----\nhunter2` redacted the header
    // and echoed the key material after it.
    //
    // One final short line is now admitted, and only when nothing but
    // whitespace follows it on that line — so a truncated body is consumed
    // whether the message ends there or continues with a stack frame.
    for (const input of [
      "private_key=-----BEGIN PRIVATE KEY-----\nhunter2",
      "private_key=-----BEGIN PRIVATE KEY-----\nhunter2\n  at parseKey (k.js:1)",
      "-----BEGIN EC PRIVATE KEY-----\nhunter2",
      "-----BEGIN RSA PRIVATE KEY-----\r\nhunter2\r\n",
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
    // The frame after the fragment is diagnostic, not key material.
    expect(
      scrubSecrets("private_key=-----BEGIN PRIVATE KEY-----\nhunter2\n  at parseKey (k.js:1)"),
    ).toContain("at parseKey");
  });

  it("leaves prose after a header alone when it is not a bare line", () => {
    // Over-matching is safe for a value and not for the message carrying it,
    // which is why the body is line-shaped in the first place. A short base64
    // fragment only counts when the line holds nothing else.
    const out = scrubSecrets("-----BEGIN PRIVATE KEY-----\nthe quick brown fox jumped");
    expect(out).toContain("quick brown fox jumped");
  });

  it("keeps a certificate, which is published by design", () => {
    // Redacting one would remove the most useful thing in a TLS diagnostic.
    const cert = "-----BEGIN CERTIFICATE-----\nMIIEpublicdata\n-----END CERTIFICATE-----";
    expect(scrubSecrets(cert)).toContain("MIIEpublicdata");
  });

  it("scans a malformed block in linear time", { retry: 2 }, () => {
    // An unbounded body ran to the end of the input from every unterminated
    // `-----BEGIN`, which measured 0.8ms at 10k chars and 12.6ms at 80k.
    //
    // Best of three, and `hrtime` rather than `Date.now()`. The ratio is the
    // assertion, so one descheduling spike moves it, and `Date.now()`'s
    // millisecond granularity made `small` a 1ms floor that any noise in
    // `large` cleared. It passed locally and failed under CI's coverage run,
    // where instrumentation slows and roughens everything: 10 against a floor
    // of 1. The minimum measures the work rather than the scheduler, without
    // loosening the threshold and costing the test its teeth.
    const costRun = (n: number): void => {
      scrubSecrets("-----BEGIN PRIVATE KEY-----\n".repeat(Math.floor(n / 28)));
    };
    // n raised from 40k/160k. The threshold is untouched — the failure it
    // started producing was noise, not complexity. Measured best-of-5 at five
    // sizes, each doubling costs exactly 2.00x (0.64 / 1.16 / 2.33 / 4.66 /
    // 9.27 ms at 20k..320k), so the scan is linear; at 40k the real work is
    // ~1.2ms and one GC pause inside the full suite moved `large` enough to
    // clear 8x. Bigger inputs put the work far above that noise floor and
    // keep the ratio the assertion.
    const { small, large } = ratioOf(costRun, 160_000, 640_000);
    // 4x the input; linear predicts ~4x, quadratic ~16x.
    expect(large).toBeLessThan(small * 8);
  });
});

describe("scrubSecrets — a serialized payload behind a prefix", () => {
  it("unwraps a payload that is not the whole message", () => {
    // The peel required the ENTIRE string to be a JSON string, and an SDK
    // exception routinely prefixes one. With the prefix present nothing was
    // unwrapped and the escaped form went straight to the pattern chain,
    // which copes at one and two layers and stops coping at three.
    const leaks: string[] = [];
    for (const val of ["hunter2", 'pre"hunter2', "pre'hunter2"]) {
      for (let depth = 1; depth <= 5; depth++) {
        let s = JSON.stringify({ password: val });
        for (let i = 1; i < depth; i++) s = JSON.stringify(s);
        for (const input of [s, `Error payload: ${s}`, `${s} <- failed`]) {
          if (scrubSecrets(input).includes("hunter2")) leaks.push(input);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("was non-monotonic in depth, which is the tell", () => {
    // Three and five leaked while four did not — a regex resolving a genuine
    // ambiguity, not a threshold set too low. Pinned so a future change to the
    // escape classes cannot quietly reintroduce it at some other depth.
    const nested = JSON.stringify(JSON.stringify(JSON.stringify({ password: 'pre"hunter2' })));
    expect(scrubSecrets(`Error payload: ${nested}`)).not.toContain("hunter2");
  });

  it("rewrites only spans it can reproduce byte for byte", () => {
    // Re-serializing is not identity: `"aAb"` comes back as `"aAb"`.
    // Silently rewriting the message around a credential is the failure mode
    // this file exists to prevent, so a span that does not round-trip is left
    // to the pattern chain untouched.
    for (const input of [
      'unicode "a\\u0041b" span',
      'he said "hello" then "goodbye"',
      'request failed: "some quoted thing" and more',
      "ends with a quote \"",
      "no quotes at all here",
    ]) {
      expect(scrubSecrets(input)).toBe(input);
    }
  });

  it("does not mistake an ordinary quoted value for a payload", () => {
    // Both parse as JSON strings. The difference is that unwrapping an
    // ordinary value hands it straight back, and the prefix scrubbed on its
    // own no longer has a value to redact — a leak the unwrap itself would
    // introduce. Twelve existing tests caught this; these pin the boundary.
    expect(scrubSecrets('api_key="hunter2"')).not.toContain("hunter2");
    expect(scrubSecrets('ctx api_key="hunter2"')).not.toContain("hunter2");
    expect(scrubSecrets('{"password":"hunter2"}')).not.toContain("hunter2");
    expect(scrubSecrets('msg: "say \\"hi\\"" and password="hunter2"')).not.toContain("hunter2");
  });

  it("finds the payload when the prose has quotes of its own", () => {
    // The first version took the first quote to the last, so any quoted
    // fragment in the surrounding prose produced a span that was not valid
    // JSON — nothing unwrapped, and the leak came straight back. Spans are
    // located in one left-to-right pass now, so an unrelated `"request"` is
    // tried and rejected rather than swallowing the payload.
    const n3 = JSON.stringify(JSON.stringify(JSON.stringify({ password: 'pre"hunter2' })));
    for (const input of [
      `Error payload: ${n3}`,
      `Error "request": payload: ${n3}`,
      `Error payload: ${n3} in "handler"`,
      `"a" "b" ${n3} "c" "d"`,
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
  });

  it("redacts a second payload in the same message", () => {
    // Locating one span and scrubbing the rest as a flat layer would leave the
    // second one escaped. A message carrying two is no less plausible than one.
    const a = JSON.stringify(JSON.stringify({ password: "hunter2" }));
    const b = JSON.stringify(JSON.stringify({ api_key: "sk-live-xyz" }));
    const out = scrubSecrets(`first ${a} then ${b}`);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-live-xyz");
  });

  it("does not treat a value that merely opens with a quote as a payload", () => {
    // `{"password":"\"hunter2"}` has a value whose inner is `"hunter2` — it
    // opens with a quote and is not a JSON string. Recursing into it scrubbed
    // the prefix with no value beside it and leaked at every depth from 1 to
    // 7. A further layer now has to BE a string, not just start like one.
    let s: string = JSON.stringify({ password: '"hunter2', user: "bob" });
    for (let depth = 1; depth <= 7; depth++) {
      expect(scrubSecrets(s), `depth ${depth}`).not.toContain("hunter2");
      s = JSON.stringify(s);
    }
  });

  it("stays linear when the message is nothing but quotes", { retry: 2 }, () => {
    // The span pass must not become the cost it was written to avoid: each
    // span's end follows from its start, so the scan is one pass, not a search
    // over quote pairs. Same 4x ratio and threshold as the other cost tests.
    const costRun = (n: number): void => {
      scrubSecrets('"'.repeat(n));
    };
    // Same reason as the backslash test: raised so `small` clears the noise.
    const { small, large } = ratioOf(costRun, 100_000, 400_000);
    expect(large).toBeLessThan(small * 8);
  });

  it("recovers after an unmatched quote in the prose", () => {
    // Pairing every quote with the next unescaped quote let an unmatched prose
    // quote swallow the payload's OPENING quote: the scanner yielded
    // `" payload: "` and never offered the real span. Candidate starts are
    // now only quotes followed by `{`, `[` or a backslash — the only things a
    // serialized payload can open with — so the pass resynchronises instead of
    // pairing quotes off against each other.
    let x: string = JSON.stringify({ password: 'pre"hunter2' });
    for (let i = 1; i < 5; i++) x = JSON.stringify(x);
    for (const input of [
      `Error payload: ${x}`,
      `Error unmatched " payload: ${x}`,
      `" ${x}`,
      `Error "a "b payload: ${x}`,
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
  });

  it("is idempotent over every prefixed shape", () => {
    for (const input of [
      `Error payload: ${JSON.stringify(JSON.stringify({ password: "hunter2" }))}`,
      'api_key="hunter2"',
      'unicode "a\\u0041b" span',
      '{"a":1,"password":"x","b":2}',
      JSON.stringify({ password: '{"ordinary":"hunter2"}' }),
      JSON.stringify({ password: '""hunter2"', tail: "K" }),
    ]) {
      const once = scrubSecrets(input);
      expect(scrubSecrets(once)).toBe(once);
    }
  });

  it("does not unwrap a sensitive key's value as a payload", () => {
    // A credential that happens to BE a JSON document. The unwrap scrubs the
    // prefix WITHOUT the value, so the field patterns have no `key = value`
    // pair left to match, and the value is then scrubbed as a document in its
    // own right — where nothing is sensitively named. A sensitive key's value
    // is never a payload to unwrap; it is a value to redact.
    const out = scrubSecrets(JSON.stringify({ password: '{"ordinary":"hunter2"}' }));
    expect(out).not.toContain("hunter2");
  });

  it("does not treat an escaped quote as a payload opener", () => {
    // The opener test accepts quote-then-backslash, which is also how an
    // ESCAPED quote presents. The span started mid-value, split it, and
    // emitted text that was not valid JSON any more, with the secret standing
    // outside any span the later input-aware pass could match.
    const out = scrubSecrets(JSON.stringify({ password: '""hunter2"', tail: "K" }));
    expect(out).not.toContain("hunter2");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("the three sensitive-key predicates agree on every spelling", () => {
    // ONE vocabulary question, asked by three predicates that were built
    // separately and drifted apart twice in one review cycle:
    //
    //   A  the SHAPE patterns          — `{"k":"hunter2"}` is redacted
    //   B  `isSensitiveFieldPath(k)`   — the path-scoped candidate collector
    //   C  the UNWRAP guard            — `{"k":"{\"ordinary\":\"hunter2\"}"}`
    //
    // `authorization` was A-only: the five SENSITIVE_AUTH_*_RE patterns carry
    // their own literal, so the shared vocabulary never listed it. Service-
    // prefixed camelCase was B-only: KEY_PREFIX enumerates CREDENTIAL-side
    // prefixes, so `secretAccessKey` matched and `githubToken` did not, while
    // the path matcher accepts an arbitrary prefix. Either disagreement is a
    // leak on whichever caller reaches the value through the losing predicate.
    //
    // Asserting the RELATION means a word added to one place and not the
    // others fails here rather than in the next review round.
    const keys = [
      "password", "passwd", "pwd", "token", "api_key", "apiKey", "secret",
      "access_key", "private_key", "privateKey", "auth", "authorization",
      "Authorization", "session_token", "secret_access_key", "secretAccessKey",
      "refresh_token", "client_secret", "x-api-key",
      "githubToken", "dbPassword", "github_token", "db_password",
      "stripeSecret", "gitlabToken", "linearApiKey", "awsSecretAccessKey",
      "notionToken",
    ];
    const disagreed: string[] = [];
    for (const k of keys) {
      const a = !scrubSecrets(JSON.stringify({ [k]: "hunter2" })).includes("hunter2");
      const b = isSensitiveFieldPath(k);
      const c = !scrubSecrets(
        JSON.stringify({ [k]: JSON.stringify({ ordinary: "hunter2" }) }),
      ).includes("hunter2");
      if (!(a === b && b === c)) disagreed.push(`${k} [shape=${a} path=${b} payload=${c}]`);
    }
    expect(disagreed).toEqual([]);
    // Not vacuous: every key above must actually be sensitive in all three.
    expect(isSensitiveFieldPath("githubToken")).toBe(true);
    expect(isSensitiveFieldPath("authorization")).toBe(true);
  });

  it("widening to an arbitrary camelCase prefix keeps the narrowings", () => {
    // The control for the rule above. It inherits the path matcher's two
    // narrowings — the credential word must be TERMINAL and SINGULAR — plus
    // the run-on protection, which is why the case-sensitive family exists at
    // all: under `i` the uppercase transition folds away and the rule degrades
    // to "letter followed by letter", redacting `mytoken`.
    const benign = [
      "maxTokens", "max_tokens", "estimatedTokens", "tokenCount", "token_count",
      "accessKeyId", "access_key_id", "passwordHint", "password_hint",
      "primaryKey", "sortKey", "projectKey", "userName",
      "mytoken", "notpassword", "passwordless", "secretary", "tokenized",
    ];
    const overMatched: string[] = [];
    for (const k of benign) {
      const out = scrubSecrets(JSON.stringify({ [k]: "ordinary-value-42" }));
      if (!out.includes("ordinary-value-42")) overMatched.push(k);
    }
    expect(overMatched).toEqual([]);
    // `myToken` DOES match, and that is the rule working, not a miss: an
    // arbitrary prefix plus a terminal singular credential word. The path
    // matcher has always classified it that way; the shape patterns now agree.
    expect(scrubSecrets('{"myToken":"hunter2"}')).not.toContain("hunter2");
  });

  it("still unwraps a payload embedded in prose", () => {
    // The control for the two guards above: neither may disable the unwrap
    // generally. A payload behind PROSE has no sensitive key before it and
    // its opening quote is unescaped, so both guards stay out of the way.
    const out = scrubSecrets(
      "Error payload: " + JSON.stringify(JSON.stringify({ password: "hunter2" })),
    );
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });
});

describe("scrubSecrets — serialization depth", () => {
  // Rounds 1-3 of review on this PR each reported the same predicate with one
  // more escaping layer: an escaped value, then an escaped Digest parameter
  // list, then a doubly-serialized object. The patterns had been widened by
  // one layer each time (`\\?` — an OPTIONAL single backslash), so each fix
  // moved the boundary rather than removing it, and depth 3 leaked again.
  //
  // Every quote in this file now accepts a RUN of backslashes (`\\*` / `\\+`)
  // instead of at most one, so depth is no longer a dimension the patterns
  // can be behind. This test walks it rather than pinning the one depth that
  // was reported.
  const KEYS = [
    { password: "hunter2", user: "bob" },
    { api_key: "hunter2", z: 1 },
    { authorization: "Bearer hunter2", z: 1 },
    { secretAccessKey: "hunter2" },
    { private_key: "hunter2" },
    // Depth and an embedded quote are independent axes, and each was covered
    // alone: the shapes above walk depth with clean values, and the matrix
    // walks embedded quotes at depth 1. Their cross-product was the gap. Past
    // two layers the backslash run in front of the value's own quote is
    // indistinguishable from the run in front of the terminator, so matching
    // stopped early and returned `"[REDACTED]"hunter2`.
    { password: 'pre"hunter2', user: "bob" },
    { api_key: "pre'hunter2", z: 1 },
    { authorization: 'Bearer pre"hunter2', z: 1 },
    { password: 'hunter2"', user: "bob" },
    { password: '"hunter2', user: "bob" },
  ];

  it("leaks nothing at any serialization depth up to 7", () => {
    const leaked: string[] = [];
    for (const seed of KEYS) {
      let v: string = JSON.stringify(seed);
      for (let depth = 1; depth <= 7; depth++) {
        if (scrubSecrets(v).includes("hunter2")) leaked.push(`depth ${depth}: ${v}`);
        v = JSON.stringify(v);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("is idempotent at any serialization depth up to 7", () => {
    const unstable: string[] = [];
    for (const seed of KEYS) {
      let v: string = JSON.stringify(seed);
      for (let depth = 1; depth <= 7; depth++) {
        const once = scrubSecrets(v);
        if (scrubSecrets(once) !== once) unstable.push(`depth ${depth}: ${once}`);
        v = JSON.stringify(v);
      }
    }
    expect(unstable).toEqual([]);
  });

  it("leaks nothing past the unwrap ceiling", () => {
    // The first cap stopped decoding and handed the still-escaped remainder to
    // the escape-counting patterns — restoring the exact ambiguity the unwrap
    // exists to remove, so 11 layers leaked where 8 did not. Depth beyond the
    // ceiling now fails closed instead of falling through.
    //
    // Depth stops at 16 because each layer roughly doubles the text — the
    // escape run is re-escaped every time — so this is already ~500x the
    // original and 64 layers would not fit in memory. That is the same
    // arithmetic that makes the ceiling unreachable for a real message, which
    // is why it can afford to fail closed rather than fall through.
    let v: string = JSON.stringify({ password: 'pre"hunter2' });
    for (let depth = 1; depth <= 16; depth++) {
      expect(scrubSecrets(v)).not.toContain("hunter2");
      v = JSON.stringify(v);
    }
  });

  it("fails closed at the unwrap ceiling instead of falling through", () => {
    // The first cap stopped decoding and handed the still-escaped remainder to
    // the escape-counting patterns, restoring the exact ambiguity the unwrap
    // removes — 11 layers leaked where 8 did not.
    //
    // The real ceiling cannot be reached from a test: each layer roughly
    // doubles the text, so 64 would not fit in memory. That is also why it can
    // afford to fail closed. Passing the limit explicitly makes the branch
    // reachable, which is the only way to show it is not decorative.
    //
    // The residual depth matters. One layer left over still scrubs correctly,
    // so a test built on that passes with the fail-closed branch removed and
    // proves nothing. Three or more residual layers is where the escape run
    // becomes ambiguous — which is the same threshold as the original finding,
    // eleven layers against a cap of eight.
    const nest = (n: number): string => {
      let v: string = JSON.stringify({ password: 'pre"hunter2' });
      for (let i = 1; i < n; i++) v = JSON.stringify(v);
      return v;
    };
    for (const [total, limit] of [
      [4, 1],
      [5, 2],
      [6, 3],
      [8, 1],
    ] as const) {
      const out = scrubSecrets(nest(total), limit);
      expect(out).not.toContain("hunter2");
      expect(out).toContain("REDACTED");
    }
    // With room to finish, the payload is scrubbed normally rather than blanked.
    const full = scrubSecrets(nest(3), 8);
    expect(full).not.toContain("hunter2");
    expect(JSON.parse(JSON.parse(JSON.parse(full)))).toMatchObject({});
  });

  it("still leaves non-credential fields in the payload", () => {
    // The escape runs must not let a pattern swallow the rest of the object.
    const out = scrubSecrets(JSON.stringify({ password: "hunter2", user: "bob" }));
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"user":"bob"');
  });

  it("preserves the payload through the JSON unwrap, at every depth", () => {
    // Peeling a serialization layer and restoring it must round-trip: the
    // decoded text is scrubbed and re-serialized, so a caller re-parsing the
    // result has to get an object back with its non-credential fields whole.
    for (let depth = 1; depth <= 5; depth++) {
      let v: string = JSON.stringify({ password: 'pre"hunter2', user: "bob", n: 7 });
      for (let i = 1; i < depth; i++) v = JSON.stringify(v);

      let out: unknown = scrubSecrets(v);
      expect(out as string).not.toContain("hunter2");
      // Unwrap the same number of layers the input carried.
      for (let i = 0; i < depth; i++) out = JSON.parse(out as string);

      expect(out).toMatchObject({ user: "bob", n: 7 });
      expect((out as Record<string, unknown>)["password"]).not.toContain("hunter2");
    }
  });

  it("leaves a payload that is not a JSON string untouched by the unwrap", () => {
    // The unwrap is a fast path, not a rewrite. Anything that is not a
    // JSON-encoded string must reach the pattern chain byte-for-byte.
    for (const s of [
      "plain prose with no secret",
      '{"user":"bob"}',
      '"unterminated',
      '"not json \\"',
      "42",
      '["a","b"]',
    ]) {
      expect(scrubSecrets(s)).toBe(s);
    }
  });
});

describe("scrubSecrets — single-parameter auth headers", () => {
  it("redacts a one-parameter quoted auth value", () => {
    // The parameter-list branch required `(?:, name=value)+` — at least one
    // REPEAT — so a header carrying exactly one parameter fell through to the
    // inline branch and stopped at the first quote. A single auth-param is
    // valid, and a truncated Digest header can carry only `response=`.
    //
    // The reported example (`OAuth oauth_token="…"`) was already clean, but
    // for an unrelated reason: `oauth_token` matches the credential
    // vocabulary, so the key/value patterns caught it before the auth family
    // ran. `response` is not a credential word, which is what exposes the
    // arity gap.
    for (const input of [
      'request failed: Authorization: Digest response="hunter2"',
      'request failed: Authorization: OAuth oauth_token="hunter2"',
      'ctx "authorization": Digest response="hunter2"',
      'Authorization: Digest response="hunter2"',
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
  });

  it("still redacts multi-parameter lists after the arity change", () => {
    expect(
      scrubSecrets('ctx "authorization": Digest username="alice", response="hunter2"'),
    ).not.toContain("hunter2");
  });
});

describe("scrubSecrets — auth header grammar and scan cost", () => {
  it("redacts an unterminated quoted parameter to end of line", () => {
    // Every other quoted-value branch already documents the rule: the value
    // runs to its terminator, and an absent terminator is the end of the line.
    // The parameter branch did not follow it, so a truncated header fell
    // through to the inline fallback, which stopped at the opening quote.
    for (const input of [
      'ctx Authorization: Digest response="hunter2',
      'ctx "authorization": Digest response="hunter2',
      "ctx Authorization: Digest response='hunter2",
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
  });

  it("redacts a scheme carrying digits and hyphens", () => {
    // An authentication scheme is an HTTP token too. `[A-Za-z]+` could not
    // recognise `AWS4-HMAC-SHA256`, so the parameter branch failed entirely
    // and the fallback stopped at the first quoted value, leaving `Signature`.
    for (const input of [
      'ctx Authorization: AWS4-HMAC-SHA256 Credential="AKIA/foo", Signature="hunter2"',
      'ctx "authorization": AWS4-HMAC-SHA256 Credential="AKIA/foo", Signature="hunter2"',
    ]) {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    }
  });

  it("scans a long credential-free message in linear time", { retry: 2 }, () => {
    // `URL_USERINFO_RE` had no left anchor, so the engine retried its greedy
    // scheme prefix from EVERY character of a long alphabetic message,
    // backtracking each time in search of `://`. Measured before the fix:
    // 10k chars 48ms, 30k 376ms, 60k 1633ms — quadratic, on a synchronous
    // path fed by externally derived exception text.
    //
    // Asserts the SHAPE, not a wall-clock budget, so it is not flaky on shared
    // CI. The input ratio is 4x deliberately: linear predicts ~4x the time and
    // quadratic ~16x, so a threshold of 8 sits cleanly between them. A 2x
    // ratio does NOT work here — quadratic predicts only ~4x there, which
    // slips under any threshold loose enough to be stable, and the test then
    // passes against the very bug it is written for. Checked by reverting the
    // fix: at 2x it stayed green, at 4x it fails.
    // Best-of-N and INTERLEAVED, not one sample and not one size after the
    // other. The ratio is the assertion, so a descheduling spike in either
    // measurement moves it, and vitest runs files in parallel: measuring all
    // the small samples first and all the large ones after means a contended
    // window lands entirely on one side of the division and inflates the ratio
    // by however long the CPU was taken away. That is exactly how this failed
    // on CI at 8.02 against a threshold of 8, while the same run measured 3.2
    // to 4.6 locally and passed 3/3 in isolation under coverage.
    //
    // Interleaving puts contention on both sides, and taking each size's own
    // minimum keeps what is being measured — the work, not the scheduler.
    // Neither changes the threshold, which is the part that has teeth: the
    // shape being tested is 4x input, so linear predicts ~4x and quadratic
    // ~16x, and 8 sits between them.
    const { small, large } = ratioOf((n) => scrubSecrets("a".repeat(n)), 100_000, 400_000);
    expect(large).toBeLessThan(small * 8);
  });

  it("does not backtrack exponentially on a run of backslashes in a quoted parameter value", () => {
    // The quoted-value body was `(?:\\.|[^\r\n])*`, and the two alternatives
    // BOTH match a backslash, so a run of them had exponentially many
    // partitions to explore before the end-of-line fallback was taken.
    // Measured before the fix, on the same synchronous path: 36 backslashes
    // 315ms, 40 backslashes 2183ms, 44 backslashes 14925ms — about 2.8x per
    // extra pair. After: under a millisecond at every size.
    //
    // An absolute budget is right here, unlike the linear/quadratic test
    // above: the gap is four orders of magnitude, so 2s is far below the
    // broken cost and far above the fixed one, and cannot go flaky between.
    const input = 'ctx Authorization: Digest username="' + "\\".repeat(44);
    const t = process.hrtime.bigint();
    const out = scrubSecrets(input);
    const elapsed = Number(process.hrtime.bigint() - t) / 1e6;
    expect(elapsed).toBeLessThan(2_000);
    expect(out).toContain("[REDACTED]");
  });

  it("scans a long run of backslashes in linear time", { retry: 2 }, () => {
    // The key-quote prefix `(?:\\*["'])?` is optional, so it was attempted at
    // EVERY index; on a backslash run each attempt consumed the whole
    // remaining run before failing to find a quote. Four patterns share that
    // prefix. Measured before: 5k 67ms, 20k 974ms, 80k 15418ms — quadratic on
    // externally derived error text. Same 4x ratio and threshold as the test
    // above, and for the same reason.
    const slashRun = (n: number): void => {
      scrubSecrets("\\".repeat(n));
    };
    // Sizes raised with the code: at 10k the scan now costs a few tenths of
    // a millisecond, so the ratio measured scheduler noise rather than work.
    const { small, large } = ratioOf(slashRun, 100_000, 400_000);
    expect(large).toBeLessThan(small * 8);
  });
});

describe("scrubSecrets — unterminated values, every family", () => {
  // Round 7 added the end-of-line fallback to the FIRST quoted parameter and
  // not to the repeated one, so `username="alice", response="hunter2` (no
  // closing quote on the later parameter) still leaked. A per-instance test
  // would have missed it exactly the way the fix did.
  //
  // So this covers the CLASS: every pattern family in this file that ends a
  // value at a delimiter, fed an input whose delimiter never arrives. Two
  // families solve it with an optional closing group rather than a fallback
  // alternative, which is why they are listed here rather than assumed.
  const cases: Array<[string, string]> = [
    ["squote", "password='hunter2"],
    ["dquote", 'password="hunter2'],
    ["escaped quote", 'password=\\"hunter2'],
    ["auth escaped", 'ctx "authorization": \\"Bearer hunter2'],
    ["auth quoted", 'ctx "authorization": "Bearer hunter2'],
    ["auth inline", 'req failed: Authorization: "Bearer hunter2'],
    ["params, first parameter", 'ctx Authorization: Digest response="hunter2'],
    ["params, later parameter", 'ctx Authorization: Digest username="alice", response="hunter2'],
    ["params, later, with a bare parameter between", 'ctx Authorization: Digest username="alice", algorithm=MD5, response="hunter2'],
  ];

  for (const [name, input] of cases) {
    it(`redacts an unterminated value: ${name}`, () => {
      expect(scrubSecrets(input)).not.toContain("hunter2");
    });
  }

  it("leaves the surrounding payload intact and stays idempotent", () => {
    // An end-of-line fallback inside a REPEATED group is the shape most able
    // to run away, so the guard is checked rather than assumed.
    const payloads = [
      '{"a":1,"authorization":"Digest username=\\"alice\\", response=\\"hunter2\\"","z":2}',
      '{"a":1,"authorization":"Digest username=alice, response=hunter2","z":2}',
      '[{"authorization":"Digest a=1, b=hunter2"},{"user":"bob"}]',
    ];
    for (const p of payloads) {
      const once = scrubSecrets(p);
      expect(once).not.toContain("hunter2");
      expect(scrubSecrets(once)).toBe(once);
      // Count structure on the marker-free text: `[REDACTED]` contributes its
      // own bracket pair, so counting them raw compares the payload against
      // the redaction marker rather than against the payload.
      const structural = (text: string): string => text.split("[REDACTED]").join("");
      for (const ch of ["{", "}", "[", "]"]) {
        expect(structural(once).split(ch).length).toBe(structural(p).split(ch).length);
      }
      // The sibling key must survive: over-consumption is the failure mode an
      // end-of-line fallback inside a repeated group can produce.
      if (p.includes('"z":2')) expect(once).toContain('"z":2');
      if (p.includes('"user":"bob"')) expect(once).toContain('"user":"bob"');
    }
  });
});

describe("scrubSecrets — URL userinfo character classes", () => {
  it("redacts a password containing an apostrophe", () => {
    // `encodeURIComponent` leaves `'` alone, so `_buildUri` emits this shape
    // for a MongoDB password containing one. The class excluded `'`, so it
    // stopped early, the required trailing `@` was never reached, and the
    // whole credential survived untouched.
    for (const input of [
      "mongodb://user:abc'def@host/db",
      "failed: mongodb://user:abc'def@host/db",
      "mongodb://us'er:abcdef@host/db",
      `{"u":"mongodb://user:abc'def@host/db","z":2}`,
    ]) {
      expect(scrubSecrets(input)).toContain("[REDACTED]");
      expect(scrubSecrets(input)).not.toMatch(/:abc'?def@/);
    }
  });

  it("stays inside the surrounding payload after admitting apostrophes", () => {
    // The double quote is what keeps the match inside a JSON string value, and
    // `@` / `/` are what bound it within the authority — so a Python-style
    // repr, where `'` IS the string delimiter, is the case to check.
    const strip = (t: string): string => t.split("[REDACTED]").join("");
    for (const p of [
      `{"u":"mongodb://user:pw@host/db","z":2}`,
      `{'u': 'mongodb://user:pw@host/db', 'z': 2}`,
      `[{"u":"postgres://a:b@h/d"},{"user":"bob"}]`,
    ]) {
      const once = scrubSecrets(p);
      expect(scrubSecrets(once)).toBe(once);
      for (const ch of ["{", "}", "[", "]"]) {
        expect(strip(once).split(ch).length).toBe(strip(p).split(ch).length);
      }
    }
    expect(scrubSecrets(`[{"u":"postgres://a:b@h/d"},{"user":"bob"}]`)).toContain('"user":"bob"');
  });
});
