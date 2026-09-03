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

  it("still leaves non-credential fields in the payload", () => {
    // The escape runs must not let a pattern swallow the rest of the object.
    const out = scrubSecrets(JSON.stringify({ password: "hunter2", user: "bob" }));
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"user":"bob"');
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
