import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter, scrubSecrets } from "../../src/toolkit/audit/writer.js";

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
