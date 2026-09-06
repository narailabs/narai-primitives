/**
 * Tests for audit.ts — ported 1:1 from `test_audit.py`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  disableAudit,
  enableAudit,
  logEvent,
  logQuery,
  scrubSqlSecrets,
} from "../../../src/connectors/db/lib/audit.js";
import { cleanupTmpPath, makeTmpPath } from "./fixtures.js";

describe("wiki_db.audit", () => {
  let tmpPath: string;

  // pytest: autouse=True _clean_audit
  beforeEach(() => {
    disableAudit();
    tmpPath = makeTmpPath("wiki-db-audit-");
  });
  afterEach(() => {
    disableAudit();
    cleanupTmpPath(tmpPath);
  });

  // ---------- 1. enable_disable ----------
  it("test_enable_disable", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "abc123");
    logQuery({
      env: "dev",
      query: "SELECT 1",
      status: "ok",
      row_count: 1,
      execution_time_ms: 5,
    });
    disableAudit();
    // After disable, further writes should be no-ops.
    logQuery({
      env: "dev",
      query: "SELECT 2",
      status: "ok",
      row_count: 1,
      execution_time_ms: 3,
    });
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  // ---------- 2. disabled_by_default ----------
  it("test_disabled_by_default", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    // Should not raise and should not create the file.
    logQuery({
      env: "dev",
      query: "SELECT 1",
      status: "ok",
      row_count: 0,
      execution_time_ms: 1,
    });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  // ---------- 3. log_query_event ----------
  it("test_log_query_event", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "sess01");
    logQuery({
      env: "dev",
      query: "SELECT * FROM t",
      status: "ok",
      row_count: 42,
      execution_time_ms: 120,
      error: null,
      context: "unit-test",
    });
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    expect(record["event_type"]).toBe("query");
    expect(record["env"]).toBe("dev");
    expect(record["query"]).toBe("SELECT * FROM t");
    expect(record["status"]).toBe("ok");
    expect(record["row_count"]).toBe(42);
    expect(record["execution_time_ms"]).toBe(120);
    expect(record["session_id"]).toBe("sess01");
    expect(record["context"]).toBe("unit-test");
    expect(record).toHaveProperty("timestamp");
  });

  // ---------- 4. query_truncated_2000 ----------
  it("test_query_truncated_2000", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "trunc");
    const longQuery = "X".repeat(3000);
    logQuery({
      env: "dev",
      query: longQuery,
      status: "ok",
      row_count: 0,
      execution_time_ms: 1,
    });
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    expect((record["query"] as string).length).toBe(2000);
  });

  // ---------- 5. session_id_auto ----------
  it("test_session_id_auto", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath); // no explicit session_id
    logQuery({
      env: "dev",
      query: "SELECT 1",
      status: "ok",
      row_count: 0,
      execution_time_ms: 1,
    });
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    const sid = record["session_id"];
    expect(typeof sid).toBe("string");
    expect((sid as string).length).toBe(12);
    // Must be valid hex — parseInt rejects non-hex.
    expect(/^[0-9a-fA-F]{12}$/.test(sid as string)).toBe(true);
  });

  // ---------- 6. custom_session_id ----------
  it("test_custom_session_id", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "my-custom-id");
    logQuery({
      env: "dev",
      query: "SELECT 1",
      status: "ok",
      row_count: 0,
      execution_time_ms: 1,
    });
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    expect(record["session_id"]).toBe("my-custom-id");
  });

  // ---------- 7. non_failing_write_error ----------
  it("test_non_failing_write_error", () => {
    // Point audit to a path that cannot be written (directory does not exist).
    const badPath = path.join(tmpPath, "no", "such", "dir", "audit.jsonl");
    enableAudit(badPath, "fail-safe");
    // Should NOT raise.
    expect(() =>
      logQuery({
        env: "dev",
        query: "SELECT 1",
        status: "ok",
        row_count: 0,
        execution_time_ms: 1,
      }),
    ).not.toThrow();
  });

  // ---------- 8. log_non_query_event ----------
  it("test_log_non_query_event", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "evt01");
    logEvent({
      event_type: "schema_inspect",
      details: { table: "users" },
    });
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    expect(record["event_type"]).toBe("schema_inspect");
    expect(record["details"]).toEqual({ table: "users" });
    expect(record["session_id"]).toBe("evt01");
    expect(record).toHaveProperty("timestamp");
  });

  // ---------- 9. multiple_append ----------
  it("test_multiple_append", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "multi");
    logQuery({
      env: "dev",
      query: "Q1",
      status: "ok",
      row_count: 1,
      execution_time_ms: 1,
    });
    logQuery({
      env: "dev",
      query: "Q2",
      status: "ok",
      row_count: 2,
      execution_time_ms: 2,
    });
    logEvent({ event_type: "connect", details: { host: "localhost" } });
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // ---------- 10. creates parent directories ----------
  it("creates parent directories for the audit file", () => {
    const logPath = path.join(tmpPath, "nested", "deep", "events.jsonl");
    enableAudit(logPath, "mkdir-test");
    logEvent({ event_type: "guardrail_deny", details: { rule: "x" } });
    expect(fs.existsSync(logPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(logPath, "utf-8").trim()) as
      Record<string, unknown>;
    expect(record["event_type"]).toBe("guardrail_deny");
  });

  // ---------- scrubSqlSecrets unit tests ----------

  it("scrubSqlSecrets redacts compound credential keys", () => {
    // `\b` treats `_` as a word character, so `\btoken\b` never matched
    // `session_token` and `\bsecret\b` / `\baccess[_-]?key\b` both missed
    // `secret_access_key` — the field names `src/connectors/aws/cli.ts`
    // writes. Measured before the fix: every key below passed the credential
    // through untouched, while the toolkit's own `scrubSecrets` redacted it.
    const keys = [
      "secret_access_key",
      "session_token",
      "secretAccessKey",
      "refresh_token",
      "client_secret",
      "access_key",
      "api_key",
      "apiKey",
      "password",
      "token",
      "secret",
      "private_key",
      "privateKey",
    ];
    const leaked: string[] = [];
    for (const k of keys) {
      for (const q of ["'", '"']) {
        for (const sep of ["=", " = ", ":", ": "]) {
          const input = `${k}${sep}${q}hunter2${q}`;
          if (scrubSqlSecrets(input).includes("hunter2")) leaked.push(input);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it("scrubSqlSecrets redacts a single-quoted key", () => {
    // The key-quote group was `"?`, so only a JSON-style key terminated. A
    // Python-style repr reaches a SQL audit log as readily as JSON does — a
    // JSONB literal, or an ORM echoing its parameters — and every key leaked
    // in that shape, `password` included, not just the compound ones.
    const leaked: string[] = [];
    for (const k of ["password", "token", "secret_access_key", "session_token", "private_key"]) {
      for (const input of [`{'${k}': 'hunter2'}`, `{'${k}':'hunter2'}`]) {
        if (scrubSqlSecrets(input).includes("hunter2")) leaked.push(input);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("scrubSqlSecrets redacts a SQL-doubled embedded object", () => {
    // A Python-style object embedded in a SQL single-quoted literal doubles
    // its own apostrophes, and that doubled form is what reaches the database.
    // The single-quote pattern read `''hunter2''` as an EMPTY literal followed
    // by `hunter2''`, matched, redacted nothing, and wrote the credential out.
    //
    // The first version of the test above hid this: it built the doubled form
    // and then called `.replace(/''/g, "'")` on it, asserting against a shape
    // no database ever sees. The input here is left as valid SQL.
    const leaked: string[] = [];
    for (const k of ["password", "token", "secret_access_key", "session_token", "private_key"]) {
      for (const input of [
        `UPDATE t SET x = '{''${k}'': ''hunter2''}'`,
        `UPDATE t SET x = '{''${k}'':''hunter2''}'`,
        `INSERT INTO t VALUES ('{''a'': 1, ''${k}'': ''hunter2''}')`,
      ]) {
        if (scrubSqlSecrets(input).includes("hunter2")) leaked.push(input);
      }
    }
    expect(leaked).toEqual([]);
  });

  it("scrubSqlSecrets keeps the SQL valid after redacting a doubled literal", () => {
    // Redacting must not break the escaping: the replacement re-emits the
    // doubled quotes, so the statement still parses and the apostrophe count
    // inside the outer literal stays even.
    const sql = `UPDATE t SET x = '{''session_token'': ''hunter2''}'`;
    const out = scrubSqlSecrets(sql);
    expect(out).toBe(`UPDATE t SET x = '{''session_token'': ''[REDACTED]''}'`);
    expect(out.split("'").length % 2).toBe(sql.split("'").length % 2);
    expect(scrubSqlSecrets(out)).toBe(out);
  });

  it("scrubSqlSecrets consumes doubled apostrophes inside the value", () => {
    // `[^']*` stopped at the first `''` INSIDE the value, so a secret holding
    // an escaped apostrophe was half-redacted and its tail stayed in the log:
    // `''abc''''def''` came back as `''[REDACTED]''''def''`.
    for (const [sql, expected] of [
      [
        "UPDATE t SET x = '{''password'': ''abc''''def''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]''}'",
      ],
      [
        "UPDATE t SET x = '{''password'': ''a''''b''''c''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]''}'",
      ],
      [
        "UPDATE t SET x = '{''a'': ''1'', ''token'': ''s''''t''}' WHERE id = 3",
        "UPDATE t SET x = '{''a'': ''1'', ''token'': ''[REDACTED]''}' WHERE id = 3",
      ],
    ] as const) {
      expect(scrubSqlSecrets(sql)).toBe(expected);
    }
  });

  it("scrubSqlSecrets ends a value only at a run boundary", () => {
    // A comma-only rule ended the value inside a four-quote run: the secret
    // `abc',def` encodes as `''abc'''',def''`, and the last two of the four
    // are followed by a comma, so `,def` stayed in the log. A closing `''` is
    // a run of exactly TWO as well as being followed by a separator.
    for (const [sql, expected] of [
      [
        "UPDATE t SET x = '{''password'': ''abc'''',def''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]''}'",
      ],
      [
        "UPDATE t SET x = '{''password'': ''abc'''',def'', ''u'': ''b''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]'', ''u'': ''b''}'",
      ],
    ] as const) {
      expect(scrubSqlSecrets(sql)).toBe(expected);
    }
  });

  it("scrubSqlSecrets stops a doubled value at its own field", () => {
    // `''` is genuinely ambiguous: an escaped apostrophe INSIDE a value, and
    // the quote that ENDS one. A greedy body resolved it by running to the
    // last `''` in the statement and swallowed every field after the secret —
    // `{''password'': ''p'', ''user'': ''bob''}` lost `''user'': ''bob''`.
    // Structure is what tells the two apart: a closing `''` is followed by a
    // separator or the end of the object.
    for (const [sql, expected] of [
      [
        "UPDATE t SET x = '{''password'': ''p'', ''user'': ''bob''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]'', ''user'': ''bob''}'",
      ],
      [
        "UPDATE t SET x = '{''token'': ''t'', ''a'': ''1'', ''b'': ''2''}'",
        "UPDATE t SET x = '{''token'': ''[REDACTED]'', ''a'': ''1'', ''b'': ''2''}'",
      ],
      // Both readings at once: an embedded double AND a following field.
      [
        "UPDATE t SET x = '{''password'': ''abc''''def'', ''user'': ''bob''}'",
        "UPDATE t SET x = '{''password'': ''[REDACTED]'', ''user'': ''bob''}'",
      ],
    ] as const) {
      expect(scrubSqlSecrets(sql)).toBe(expected);
    }
  });

  it("scrubSqlSecrets does not run a doubled value past its own object", () => {
    // The other direction: a second literal later in the statement.
    const sql =
      "UPDATE t SET x = '{''password'': ''p''}', y = '{''note'': ''keep''}' WHERE id = 3";
    const out = scrubSqlSecrets(sql);
    expect(out).toContain("''keep''");
    expect(out).toContain("WHERE id = 3");
    expect(out).not.toContain("''p''");
    expect(out.split("'").length).toBe(sql.split("'").length);
  });

  it("scrubSqlSecrets leaves every redacted statement parseable", () => {
    // The apostrophe COUNT is not the invariant — a redacted secret takes its
    // own escaped apostrophes with it, so `''abc''''def''` legitimately comes
    // back shorter. What has to hold is that every literal is still closed,
    // i.e. the count stays even.
    for (const sql of [
      "UPDATE t SET x = '{''session_token'': ''hunter2''}'",
      "UPDATE t SET x = '{''password'': ''abc''''def''}'",
      "UPDATE t SET x = '{''password'': ''a''''b''''c''}'",
      "UPDATE t SET x = '{''a'': ''1'', ''token'': ''s''''t''}' WHERE id = 3",
      "UPDATE t SET password = '' WHERE note = ''",
      "SELECT * FROM t WHERE token = '' AND a = '' AND b = ''",
    ]) {
      const out = scrubSqlSecrets(sql);
      expect((out.split("'").length - 1) % 2, sql).toBe(0);
      expect(scrubSqlSecrets(out), sql).toBe(out);
    }
  });

  it("scrubSqlSecrets leaves ordinary empty literals alone", () => {
    // With the doubled key quotes optional the pattern had no left anchor, so
    // two ordinary empty literals read as one doubled value: the match ran
    // from the first `''` to the second and deleted everything between them.
    // Over-matching is safe for a value and not for the statement carrying it
    // — an audit log that rewrites the query has lost what it exists to keep.
    for (const [sql, expected] of [
      [
        "UPDATE t SET password = '' WHERE note = ''",
        "UPDATE t SET password = '[REDACTED]' WHERE note = ''",
      ],
      [
        "SELECT * FROM t WHERE token = '' AND a = '' AND b = ''",
        "SELECT * FROM t WHERE token = '[REDACTED]' AND a = '' AND b = ''",
      ],
      [
        "UPDATE t SET password = 'x' WHERE note = 'y'",
        "UPDATE t SET password = '[REDACTED]' WHERE note = 'y'",
      ],
    ] as const) {
      expect(scrubSqlSecrets(sql)).toBe(expected);
    }
  });

  it("scrubSqlSecrets preserves the statement around every doubled match", () => {
    // The structural property behind the case above, asserted directly: what
    // is outside the redacted value has to survive intact.
    for (const sql of [
      "UPDATE t SET x = '{''session_token'': ''hunter2''}' WHERE id = 7",
      "INSERT INTO t VALUES ('{''a'': 1, ''password'': ''p''}'), ('plain')",
      "SELECT '' AS empty, '{''token'': ''t''}' AS payload FROM t",
    ]) {
      const out = scrubSqlSecrets(sql);
      // Same number of apostrophes: the redaction re-emits the doubling.
      expect(out.split("'").length, sql).toBe(sql.split("'").length);
      expect(scrubSqlSecrets(out), sql).toBe(out);
    }
    expect(
      scrubSqlSecrets("UPDATE t SET x = '{''session_token'': ''hunter2''}' WHERE id = 7"),
    ).toContain("WHERE id = 7");
  });

  it("scrubSqlSecrets does not redact a doubled non-credential column", () => {
    // The doubled pattern must respect the same key list as the others.
    const sql = `UPDATE t SET x = '{''primary_key'': ''not-a-secret''}'`;
    expect(scrubSqlSecrets(sql)).toContain("not-a-secret");
  });

  it("keeps the statement intact for every Python-repr escape shape", () => {
    // Regression (Codex P2) against the escape-aware branch added an hour
    // earlier in this same PR: `\''` was written as one alternative, so a value
    // ENDING in a backslash had its final `\` consumed together with the
    // closing quote pair, the match ran on through the next field, and
    // `''user'': ''bob''` was deleted from the audited statement.
    //
    // Hand-picked examples are exactly what let that through, so this pins
    // the whole space instead. Nothing may leak, and — the property the
    // regression broke — the statement around the credential must survive.
  // Generated from Python: for each value below, `repr({'password': v,
  // 'user': 'bob'})` embedded in a SQL literal with every apostrophe
  // doubled. Values are every string of length 1-3 over {a, ', ", \\} —
  // the three characters that decide which quoting repr picks, plus one
  // ordinary letter. Hand-picked examples are what let the trailing-
  // backslash case through; this is the whole space.
  const REPR_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ["\"", "INSERT INTO t VALUES ('{''password'': ''\"'', ''user'': ''bob''}')"],
    ["\"\"", "INSERT INTO t VALUES ('{''password'': ''\"\"'', ''user'': ''bob''}')"],
    ["\"\"\"", "INSERT INTO t VALUES ('{''password'': ''\"\"\"'', ''user'': ''bob''}')"],
    ["\"\"'", "INSERT INTO t VALUES ('{''password'': ''\"\"\\'''', ''user'': ''bob''}')"],
    ["\"\"\\", "INSERT INTO t VALUES ('{''password'': ''\"\"\\\\'', ''user'': ''bob''}')"],
    ["\"\"a", "INSERT INTO t VALUES ('{''password'': ''\"\"a'', ''user'': ''bob''}')"],
    ["\"'", "INSERT INTO t VALUES ('{''password'': ''\"\\'''', ''user'': ''bob''}')"],
    ["\"'\"", "INSERT INTO t VALUES ('{''password'': ''\"\\''\"'', ''user'': ''bob''}')"],
    ["\"''", "INSERT INTO t VALUES ('{''password'': ''\"\\''\\'''', ''user'': ''bob''}')"],
    ["\"'\\", "INSERT INTO t VALUES ('{''password'': ''\"\\''\\\\'', ''user'': ''bob''}')"],
    ["\"'a", "INSERT INTO t VALUES ('{''password'': ''\"\\''a'', ''user'': ''bob''}')"],
    ["\"\\", "INSERT INTO t VALUES ('{''password'': ''\"\\\\'', ''user'': ''bob''}')"],
    ["\"\\\"", "INSERT INTO t VALUES ('{''password'': ''\"\\\\\"'', ''user'': ''bob''}')"],
    ["\"\\'", "INSERT INTO t VALUES ('{''password'': ''\"\\\\\\'''', ''user'': ''bob''}')"],
    ["\"\\\\", "INSERT INTO t VALUES ('{''password'': ''\"\\\\\\\\'', ''user'': ''bob''}')"],
    ["\"\\a", "INSERT INTO t VALUES ('{''password'': ''\"\\\\a'', ''user'': ''bob''}')"],
    ["\"a", "INSERT INTO t VALUES ('{''password'': ''\"a'', ''user'': ''bob''}')"],
    ["\"a\"", "INSERT INTO t VALUES ('{''password'': ''\"a\"'', ''user'': ''bob''}')"],
    ["\"a'", "INSERT INTO t VALUES ('{''password'': ''\"a\\'''', ''user'': ''bob''}')"],
    ["\"a\\", "INSERT INTO t VALUES ('{''password'': ''\"a\\\\'', ''user'': ''bob''}')"],
    ["\"aa", "INSERT INTO t VALUES ('{''password'': ''\"aa'', ''user'': ''bob''}')"],
    ["'", "INSERT INTO t VALUES ('{''password'': \"''\", ''user'': ''bob''}')"],
    ["'\"", "INSERT INTO t VALUES ('{''password'': ''\\''\"'', ''user'': ''bob''}')"],
    ["'\"\"", "INSERT INTO t VALUES ('{''password'': ''\\''\"\"'', ''user'': ''bob''}')"],
    ["'\"'", "INSERT INTO t VALUES ('{''password'': ''\\''\"\\'''', ''user'': ''bob''}')"],
    ["'\"\\", "INSERT INTO t VALUES ('{''password'': ''\\''\"\\\\'', ''user'': ''bob''}')"],
    ["'\"a", "INSERT INTO t VALUES ('{''password'': ''\\''\"a'', ''user'': ''bob''}')"],
    ["''", "INSERT INTO t VALUES ('{''password'': \"''''\", ''user'': ''bob''}')"],
    ["''\"", "INSERT INTO t VALUES ('{''password'': ''\\''\\''\"'', ''user'': ''bob''}')"],
    ["'''", "INSERT INTO t VALUES ('{''password'': \"''''''\", ''user'': ''bob''}')"],
    ["''\\", "INSERT INTO t VALUES ('{''password'': \"''''\\\\\", ''user'': ''bob''}')"],
    ["''a", "INSERT INTO t VALUES ('{''password'': \"''''a\", ''user'': ''bob''}')"],
    ["'\\", "INSERT INTO t VALUES ('{''password'': \"''\\\\\", ''user'': ''bob''}')"],
    ["'\\\"", "INSERT INTO t VALUES ('{''password'': ''\\''\\\\\"'', ''user'': ''bob''}')"],
    ["'\\'", "INSERT INTO t VALUES ('{''password'': \"''\\\\''\", ''user'': ''bob''}')"],
    ["'\\\\", "INSERT INTO t VALUES ('{''password'': \"''\\\\\\\\\", ''user'': ''bob''}')"],
    ["'\\a", "INSERT INTO t VALUES ('{''password'': \"''\\\\a\", ''user'': ''bob''}')"],
    ["'a", "INSERT INTO t VALUES ('{''password'': \"''a\", ''user'': ''bob''}')"],
    ["'a\"", "INSERT INTO t VALUES ('{''password'': ''\\''a\"'', ''user'': ''bob''}')"],
    ["'a'", "INSERT INTO t VALUES ('{''password'': \"''a''\", ''user'': ''bob''}')"],
    ["'a\\", "INSERT INTO t VALUES ('{''password'': \"''a\\\\\", ''user'': ''bob''}')"],
    ["'aa", "INSERT INTO t VALUES ('{''password'': \"''aa\", ''user'': ''bob''}')"],
    ["\\", "INSERT INTO t VALUES ('{''password'': ''\\\\'', ''user'': ''bob''}')"],
    ["\\\"", "INSERT INTO t VALUES ('{''password'': ''\\\\\"'', ''user'': ''bob''}')"],
    ["\\\"\"", "INSERT INTO t VALUES ('{''password'': ''\\\\\"\"'', ''user'': ''bob''}')"],
    ["\\\"'", "INSERT INTO t VALUES ('{''password'': ''\\\\\"\\'''', ''user'': ''bob''}')"],
    ["\\\"\\", "INSERT INTO t VALUES ('{''password'': ''\\\\\"\\\\'', ''user'': ''bob''}')"],
    ["\\\"a", "INSERT INTO t VALUES ('{''password'': ''\\\\\"a'', ''user'': ''bob''}')"],
    ["\\'", "INSERT INTO t VALUES ('{''password'': \"\\\\''\", ''user'': ''bob''}')"],
    ["\\'\"", "INSERT INTO t VALUES ('{''password'': ''\\\\\\''\"'', ''user'': ''bob''}')"],
    ["\\''", "INSERT INTO t VALUES ('{''password'': \"\\\\''''\", ''user'': ''bob''}')"],
    ["\\'\\", "INSERT INTO t VALUES ('{''password'': \"\\\\''\\\\\", ''user'': ''bob''}')"],
    ["\\'a", "INSERT INTO t VALUES ('{''password'': \"\\\\''a\", ''user'': ''bob''}')"],
    ["\\\\", "INSERT INTO t VALUES ('{''password'': ''\\\\\\\\'', ''user'': ''bob''}')"],
    ["\\\\\"", "INSERT INTO t VALUES ('{''password'': ''\\\\\\\\\"'', ''user'': ''bob''}')"],
    ["\\\\'", "INSERT INTO t VALUES ('{''password'': \"\\\\\\\\''\", ''user'': ''bob''}')"],
    ["\\\\\\", "INSERT INTO t VALUES ('{''password'': ''\\\\\\\\\\\\'', ''user'': ''bob''}')"],
    ["\\\\a", "INSERT INTO t VALUES ('{''password'': ''\\\\\\\\a'', ''user'': ''bob''}')"],
    ["\\a", "INSERT INTO t VALUES ('{''password'': ''\\\\a'', ''user'': ''bob''}')"],
    ["\\a\"", "INSERT INTO t VALUES ('{''password'': ''\\\\a\"'', ''user'': ''bob''}')"],
    ["\\a'", "INSERT INTO t VALUES ('{''password'': \"\\\\a''\", ''user'': ''bob''}')"],
    ["\\a\\", "INSERT INTO t VALUES ('{''password'': ''\\\\a\\\\'', ''user'': ''bob''}')"],
    ["\\aa", "INSERT INTO t VALUES ('{''password'': ''\\\\aa'', ''user'': ''bob''}')"],
    ["a", "INSERT INTO t VALUES ('{''password'': ''a'', ''user'': ''bob''}')"],
    ["a\"", "INSERT INTO t VALUES ('{''password'': ''a\"'', ''user'': ''bob''}')"],
    ["a\"\"", "INSERT INTO t VALUES ('{''password'': ''a\"\"'', ''user'': ''bob''}')"],
    ["a\"'", "INSERT INTO t VALUES ('{''password'': ''a\"\\'''', ''user'': ''bob''}')"],
    ["a\"\\", "INSERT INTO t VALUES ('{''password'': ''a\"\\\\'', ''user'': ''bob''}')"],
    ["a\"a", "INSERT INTO t VALUES ('{''password'': ''a\"a'', ''user'': ''bob''}')"],
    ["a'", "INSERT INTO t VALUES ('{''password'': \"a''\", ''user'': ''bob''}')"],
    ["a'\"", "INSERT INTO t VALUES ('{''password'': ''a\\''\"'', ''user'': ''bob''}')"],
    ["a''", "INSERT INTO t VALUES ('{''password'': \"a''''\", ''user'': ''bob''}')"],
    ["a'\\", "INSERT INTO t VALUES ('{''password'': \"a''\\\\\", ''user'': ''bob''}')"],
    ["a'a", "INSERT INTO t VALUES ('{''password'': \"a''a\", ''user'': ''bob''}')"],
    ["a\\", "INSERT INTO t VALUES ('{''password'': ''a\\\\'', ''user'': ''bob''}')"],
    ["a\\\"", "INSERT INTO t VALUES ('{''password'': ''a\\\\\"'', ''user'': ''bob''}')"],
    ["a\\'", "INSERT INTO t VALUES ('{''password'': \"a\\\\''\", ''user'': ''bob''}')"],
    ["a\\\\", "INSERT INTO t VALUES ('{''password'': ''a\\\\\\\\'', ''user'': ''bob''}')"],
    ["a\\a", "INSERT INTO t VALUES ('{''password'': ''a\\\\a'', ''user'': ''bob''}')"],
    ["aa", "INSERT INTO t VALUES ('{''password'': ''aa'', ''user'': ''bob''}')"],
    ["aa\"", "INSERT INTO t VALUES ('{''password'': ''aa\"'', ''user'': ''bob''}')"],
    ["aa'", "INSERT INTO t VALUES ('{''password'': \"aa''\", ''user'': ''bob''}')"],
    ["aa\\", "INSERT INTO t VALUES ('{''password'': ''aa\\\\'', ''user'': ''bob''}')"],
    ["aaa", "INSERT INTO t VALUES ('{''password'': ''aaa'', ''user'': ''bob''}')"],
  ];
    for (const [value, sql] of REPR_SHAPES) {
      const out = scrubSqlSecrets(sql);
      expect(out, `statement mangled for value ${JSON.stringify(value)}`).toContain(
        "''user'': ''bob''",
      );
      expect(out, `not redacted for value ${JSON.stringify(value)}`).toContain(
        "[REDACTED]",
      );
    }
  });

  it("scrubSqlSecrets ends a doubled value at an escaped trailing apostrophe", () => {
    // Regression (Codex P1). Python reaches the backslash-escaped form only
    // when the value contains BOTH quote types: repr of `abc"'` is
    // `'abc"\''`, and SQL-doubling makes the tail a backslash plus FOUR
    // apostrophes — an escaped data apostrophe followed by the closing quote.
    // `(?<!')` rejected that closing pair, because a doubled data apostrophe
    // sits immediately before it.
    //
    // The report said the credential came back unchanged. It does not: the
    // value ran PAST its own field and swallowed the rest of the object, so
    // the failure is statement corruption rather than a leak. That is the
    // worse half by this file's own rule — an audit log that rewrites the
    // query has lost the thing it exists to keep.
    const sql =
      "INSERT INTO t VALUES ('{''password'': ''abc\"\\'''', ''user'': ''bob''}')";
    const out = scrubSqlSecrets(sql);
    expect(out).not.toContain("abc");
    expect(out, "the value ran past its own field").toContain(
      "''user'': ''bob''",
    );
  });

  it("scrubSqlSecrets handles escaped apostrophes throughout a doubled value", () => {
    // Not only at the terminator. `a'b"c'd` escapes twice mid-value, which the
    // pre-fix pattern already handled — pinned so the escape-aware branch
    // cannot regress the interior case while fixing the trailing one.
    const sql =
      "INSERT INTO t VALUES ('{''password'': ''a\\''b\"c\\''d'', ''user'': ''bob''}')";
    const out = scrubSqlSecrets(sql);
    expect(out).not.toContain("b\"c");
    expect(out).toContain("''user'': ''bob''");
  });

  it("scrubSqlSecrets redacts a doubled key whose value is double-quoted", () => {
    // Python switches a value to double quotes exactly when the value itself
    // contains an apostrophe, so this is the shape a leaked credential takes
    // when it is the *awkward* one: `repr({"password": "abc'def"})` embedded in
    // a SQL literal doubles the key to `''password''` but leaves the value's
    // `"` single. The doubled pattern wanted `''` after the separator and the
    // double-quote pattern allowed only one key quote, so neither fired.
    const sql = `INSERT INTO t VALUES ('{''password'': "abc''def"}')`;
    const out = scrubSqlSecrets(sql);
    expect(out).not.toContain("abc");
    expect(out).toBe(`INSERT INTO t VALUES ('{''password'': "[REDACTED]"}')`);
  });

  it("scrubSqlSecrets keeps the fields after a doubled/double-quoted credential", () => {
    // The value run stops at the first unescaped `"`, so the match cannot eat
    // the rest of the object the way an end-of-line rule would. This is the
    // payload-integrity half of the pattern above.
    const sql = `INSERT INTO t VALUES ('{''password'': "hunter2", ''user'': ''bob''}')`;
    const out = scrubSqlSecrets(sql);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("''user'': ''bob''");
  });

  it("scrubSqlSecrets covers every key/value quoting a SQL literal can carry", () => {
    // The axes are the forms that can actually occur INSIDE a single-quoted
    // SQL literal: an apostrophe from the payload is always doubled, a double
    // quote never is. So `'password'` and `'value'` are not reachable shapes —
    // they would end the literal. That leaves bare, doubled and double-quoted.
    //
    // Pinning the whole grid rather than the one reported cell: the two
    // covered-by-a-serializer diagonals (Python repr, JSON) plus the mixed
    // form this commit adds. The unquoted-value column is a different axis
    // (connection strings, not objects) and leaks identically on main.
    const KEYS = ["''password''", '"password"'];
    const VALS = ["''SEKRIT''", '"SEKRIT"'];
    for (const k of KEYS) {
      for (const v of VALS) {
        // A doubled key pairs with a doubled or double-quoted value; a plain
        // double-quoted key (JSON) pairs with a double-quoted value. The
        // remaining cell — JSON key, doubled value — no serializer emits.
        if (k === '"password"' && v === "''SEKRIT''") continue;
        const sql = `INSERT INTO t VALUES ('{${k}: ${v}, ''user'': ''bob''}')`;
        const out = scrubSqlSecrets(sql);
        expect(out, `leaked for key=${k} value=${v}`).not.toContain("SEKRIT");
        expect(out, `mangled for key=${k} value=${v}`).toContain("''user'': ''bob''");
      }
    }
  });

  it("scrubSqlSecrets still refuses run-on words", () => {
    // What the `\b` boundary was there to protect. Widening it must not cost
    // this: a column literally named `authority` or `tokenizer` is ordinary
    // SQL, and redacting it destroys the query the audit log exists to record.
    for (const k of ["mytoken", "notpassword", "xsecret", "tokenizer", "authority", "passwords"]) {
      expect(scrubSqlSecrets(`${k}='hunter2'`)).toContain("hunter2");
    }
  });

  it("scrubSqlSecrets does not redact ordinary *_key columns", () => {
    // Why `private[_-]?key` is named rather than a bare `key` alternative:
    // these are everyday SQL identifiers, and redacting them would destroy
    // the query the audit log exists to record.
    for (const k of ["primary_key", "sort_key", "partition_key", "foreign_key", "key"]) {
      expect(scrubSqlSecrets(`${k}='not-a-secret'`)).toContain("not-a-secret");
    }
  });

  it("scrubSqlSecrets leaves the surrounding payload intact and is idempotent", () => {
    // The unrolled value class must still stop at its own closing quote —
    // consuming past it would mangle events.jsonl for every downstream reader.
    const payloads = [
      `{"a":1,"secret_access_key":"hunter2","user":"bob"}`,
      `INSERT INTO t VALUES ('x', session_token='hunter2', 'y')`,
      `{"session_token":"a\\"bhunter2","z":2}`,
    ];
    for (const p of payloads) {
      const once = scrubSqlSecrets(p);
      expect(once).not.toContain("hunter2");
      expect(scrubSqlSecrets(once)).toBe(once);
      expect(once.split("{").length).toBe(p.split("{").length);
      expect(once.split("}").length).toBe(p.split("}").length);
    }
  });

  it("scrubSqlSecrets masks single-quoted credential literals", () => {
    expect(
      scrubSqlSecrets("SELECT * FROM u WHERE password = 'p4ss' AND id = 1"),
    ).toBe("SELECT * FROM u WHERE password = '[REDACTED]' AND id = 1");
    expect(scrubSqlSecrets("WHERE token='sk-abc123'")).toBe(
      "WHERE token='[REDACTED]'",
    );
    expect(scrubSqlSecrets("WHERE api_key = 'k1' OR api-key = 'k2'")).toBe(
      "WHERE api_key = '[REDACTED]' OR api-key = '[REDACTED]'",
    );
  });

  it("scrubSqlSecrets masks double-quoted credential literals", () => {
    expect(scrubSqlSecrets('WHERE secret = "s3cr3t"')).toBe(
      'WHERE secret = "[REDACTED]"',
    );
  });

  it("scrubSqlSecrets preserves the matched separator in JSON payloads", () => {
    // Regression: replacement used to hard-code `=`, mangling JSON keys —
    // `{"password":"x"}` became `{"password"='[REDACTED]'}` which breaks
    // downstream consumers parsing events.jsonl as JSON-per-line.
    expect(scrubSqlSecrets(`{"password":"hunter2"}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    expect(scrubSqlSecrets(`{"api_key": "abc"}`)).toBe(
      `{"api_key": "[REDACTED]"}`,
    );
  });

  it("scrubSqlSecrets redacts the full Authorization value regardless of scheme", () => {
    // Bearer/Basic preserve the scheme name for log readability.
    expect(scrubSqlSecrets("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(scrubSqlSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [REDACTED]",
    );
    // Regression: previously `[^"'\s\\]+` stopped at the first space so
    // `Authorization: Token abc123` left `abc123` in the audit log.
    expect(scrubSqlSecrets("Authorization: Token abc123")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(scrubSqlSecrets(`{"authorization": "Token abc123"}`)).toBe(
      `{"authorization": "[REDACTED]"}`,
    );
  });

  it("scrubSqlSecrets redacts Digest headers with quoted parameters", () => {
    // Regression (Codex P1 on 0733e81): the unquoted-form branch must
    // consume to end-of-line so Digest's embedded `username="u"` and
    // `response="…"` don't terminate the value class early.
    const out = scrubSqlSecrets(
      'Authorization: Digest username="u", realm="r", response="abc123"',
    );
    expect(out).toBe("Authorization: [REDACTED]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain('response="');
  });

  it("scrubSqlSecrets does not redact non-sensitive keys that merely end in a sensitive token", () => {
    // Regression (Codex P2 on 0733e81): `\b` keeps `mytoken='x'` and
    // `notpassword='x'` from being clobbered by the `token`/`password`
    // suffix match.
    expect(scrubSqlSecrets("WHERE mytoken='x'")).toBe("WHERE mytoken='x'");
    expect(scrubSqlSecrets("WHERE notpassword = 'x'")).toBe(
      "WHERE notpassword = 'x'",
    );
    // The bare sensitive keyword still matches.
    expect(scrubSqlSecrets("WHERE token='x'")).toBe("WHERE token='[REDACTED]'");
  });

  it("scrubSqlSecrets handles long unterminated quote strings linearly", () => {
    const start = performance.now();
    const payload = 'password="' + '\\a'.repeat(100000) + '!';
    scrubSqlSecrets(payload);
    const duration = performance.now() - start;
    // Bounded well under 1 second
    expect(duration).toBeLessThan(1000);
  });

  it("scrubSqlSecrets handles JSON-escaped quotes inside secret values", () => {
    // Regression (Codex P1 on 683b907): `"[^"]*"` used to terminate at
    // an escaped `\"`, leaking the value tail.
    expect(scrubSqlSecrets(`{"password":"abc\\"def"}`)).toBe(
      `{"password":"[REDACTED]"}`,
    );
    expect(scrubSqlSecrets(`{"token":"a\\"b\\"c"}`)).toBe(
      `{"token":"[REDACTED]"}`,
    );
  });

  it("scrubSqlSecrets handles JSON-escaped quotes in Authorization values", () => {
    // Regression (Codex P1 on 683b907): the quoted-branch value class
    // used to stop at the first inner `"`, even when it was an escaped
    // `\"`, leaking the Digest `response=` parameter.
    const input = `{"authorization":"Digest username=\\"u\\", response=\\"abc123\\""}`;
    const out = scrubSqlSecrets(input);
    expect(out).toBe(`{"authorization":"[REDACTED]"}`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("response");
  });

  it("scrubSqlSecrets does not mangle JSON when 'authorization' appears inside a string value", () => {
    // Regression (Codex P2 on 6e3bf0f): the unquoted AUTH branch's
    // `[^\r\n]+` value class used to consume the JSON closing `"}` and
    // produce unterminated JSON for inputs like
    // `{"message":"authorization: Bearer abc"}`.
    const input = `{"message":"authorization: Bearer abc"}`;
    const out = scrubSqlSecrets(input);
    expect(out).toBe(`{"message":"authorization: Bearer [REDACTED]"}`);
    expect(out).not.toContain("abc");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("scrubSqlSecrets still redacts HTTP-style Authorization headers at line start", () => {
    expect(scrubSqlSecrets("Authorization: Bearer abc")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    const multiline =
      "GET /api\nAuthorization: Bearer xyz\nHost: example.com";
    const out = scrubSqlSecrets(multiline);
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).not.toContain("xyz");
    expect(out).toContain("Host: example.com");
  });

  it("scrubSqlSecrets leaves non-credential literals alone", () => {
    expect(scrubSqlSecrets("SELECT name FROM u WHERE id = 1")).toBe(
      "SELECT name FROM u WHERE id = 1",
    );
    expect(scrubSqlSecrets("WHERE name = 'alice'")).toBe(
      "WHERE name = 'alice'",
    );
  });

  it("logQuery scrubs credentials before persisting to the audit file", () => {
    const logPath = path.join(tmpPath, "audit.jsonl");
    enableAudit(logPath, "abc123");
    logQuery({
      env: "dev",
      query: "SELECT * FROM users WHERE password = 'leaked' LIMIT 1",
      status: "ok",
      row_count: 1,
      execution_time_ms: 5,
    });
    const line = fs.readFileSync(logPath, "utf-8").trim();
    const record = JSON.parse(line) as { query: string };
    expect(record.query).toBe(
      "SELECT * FROM users WHERE password = '[REDACTED]' LIMIT 1",
    );
    expect(record.query).not.toContain("leaked");
  });
});
