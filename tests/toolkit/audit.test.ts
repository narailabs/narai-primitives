import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditWriter,
  isSensitiveFieldPath,
  scrubSecrets,
} from "../../src/toolkit/audit/writer.js";

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

  it("redacts unquoted values", () => {
    // Regression (Codex P2): only quoted values were recognized, so a
    // JSON.parse failure echoing `--params '{"password":hunter2}'` left the
    // secret intact in both the stdout envelope and the stderr line.
    expect(scrubSecrets(`{"password":hunter2}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    expect(scrubSecrets("password=hunter2")).toBe(`password="[REDACTED]"`);
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
      `secret="[REDACTED]"; other=keep`,
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
    // The structure openers `{` and `[` must NOT match in first position:
    // redacting from `[` would stop at the inner `,` and mangle the array.
    expect(scrubSecrets(`{"token":[1,2]}`)).toBe(`{"token":[1,2]}`);
    expect(scrubSecrets(`{"token":{"v":1}}`)).toBe(`{"token":{"v":1}}`);
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
      `refresh-token="[REDACTED]"`,
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

  it("scans a malformed block in linear time", () => {
    // An unbounded body ran to the end of the input from every unterminated
    // `-----BEGIN`, which measured 0.8ms at 10k chars and 12.6ms at 80k.
    const cost = (n: number): number => {
      const s = "-----BEGIN PRIVATE KEY-----\n".repeat(Math.floor(n / 28));
      const t = Date.now();
      scrubSecrets(s);
      return Date.now() - t;
    };
    cost(20_000);
    const small = cost(40_000);
    const large = cost(160_000);
    // 4x the input; linear predicts ~4x, quadratic ~16x.
    expect(large).toBeLessThan(Math.max(small, 1) * 8);
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

  it("stays linear when the message is nothing but quotes", () => {
    // The span pass must not become the cost it was written to avoid: each
    // span's end follows from its start, so the scan is one pass, not a search
    // over quote pairs. Same 4x ratio and threshold as the other cost tests.
    const cost = (n: number): number => {
      const text = '"'.repeat(n);
      scrubSecrets(text); // warm
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        scrubSecrets(text);
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      return best;
    };
    const small = Math.max(cost(10_000), 0.2);
    const large = cost(40_000);
    expect(large).toBeLessThan(small * 8);
  });

  it("is idempotent over every prefixed shape", () => {
    for (const input of [
      `Error payload: ${JSON.stringify(JSON.stringify({ password: "hunter2" }))}`,
      'api_key="hunter2"',
      'unicode "a\\u0041b" span',
      '{"a":1,"password":"x","b":2}',
    ]) {
      const once = scrubSecrets(input);
      expect(scrubSecrets(once)).toBe(once);
    }
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

  it("scans a long credential-free message in linear time", () => {
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
    // Best of three, not one sample. The ratio is the assertion, so a single
    // descheduling spike in either measurement moves it — and the small one is
    // short enough that noise dominates it. Vitest runs files in parallel, so
    // this flaked roughly one full-suite run in three while passing 8/8 in
    // isolation, both before and after the change that surfaced it. Taking the
    // minimum keeps what is being measured (the work, not the scheduler)
    // without loosening the threshold, which would cost the test its teeth.
    const timeFor = (n: number): number => {
      const text = "a".repeat(n);
      scrubSecrets(text); // warm
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        scrubSecrets(text);
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      return best;
    };
    const small = Math.max(timeFor(10_000), 0.2);
    const large = timeFor(40_000);
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

  it("scans a long run of backslashes in linear time", () => {
    // The key-quote prefix `(?:\\*["'])?` is optional, so it was attempted at
    // EVERY index; on a backslash run each attempt consumed the whole
    // remaining run before failing to find a quote. Four patterns share that
    // prefix. Measured before: 5k 67ms, 20k 974ms, 80k 15418ms — quadratic on
    // externally derived error text. Same 4x ratio and threshold as the test
    // above, and for the same reason.
    const timeForSlashes = (n: number): number => {
      const text = "\\".repeat(n);
      scrubSecrets(text); // warm
      const t = process.hrtime.bigint();
      scrubSecrets(text);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const small = Math.max(timeForSlashes(10_000), 0.2);
    const large = timeForSlashes(40_000);
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
