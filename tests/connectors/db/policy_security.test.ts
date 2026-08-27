import { describe, expect, it } from "vitest";
import { classifyStatements, Decision, Policy } from "../../../src/connectors/db/lib/policy.js";

describe("SQL policy parser security", () => {
  it("safely handles comments masquerading as strings", () => {
    const sql1 = "SELECT 1 '/*' ; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    const sql2 = "SELECT 1 \"--\" ; DROP TABLE users;";
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);
  });

  it("safely handles strings masquerading as comments", () => {
    // Test the fail-closed approach for ambiguous SQL statement boundaries
    // where `\` causes a mismatch between dialects.
    const sql1 = "SELECT 1 '\\'; DROP TABLE users;";
    expect(() => classifyStatements(sql1)).toThrow(/Ambiguous SQL statement boundaries/);

    const sql3 = "SELECT 1 \"''\"; DROP TABLE users;";
    expect(classifyStatements(sql3)).toEqual(["read", "admin"]);
  });

  it("safely handles line comments containing strings with unclosed quotes", () => {
    const sql1 = "SELECT 1 -- '\n ; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    // Also stop at carriage returns (\r)
    const sql2 = "SELECT 1 --\r; DROP TABLE users;";
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);
  });

  it("safely handles line comments without whitespace suffixes", () => {
    // Attack: Using `--` without whitespace to hide commands in MySQL
    // where `--` isn't a comment unless followed by space/control char.
    const sql1 = "SELECT 1--1 UNION SELECT password FROM users";
    expect(() => classifyStatements(sql1)).toThrow(/Ambiguous or unrecognized SQL construct/);

    // A variant with an actual hidden statement boundary
    const sql2 = "SELECT 1--; DROP TABLE users;";
    expect(() => classifyStatements(sql2)).toThrow(/Ambiguous or unrecognized SQL construct/);
  });

  it("safely handles PostgreSQL dollar quotes", () => {
    const sql1 = "SELECT $$ -- not comment $$; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    const sql2 = "SELECT $tag$ SELECT 1; $tag$; DROP TABLE users;";
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);

    const sql3 = "SELECT 1 AS col$tag$ WHERE 1=1; DROP TABLE users;";
    expect(classifyStatements(sql3)).toEqual(["read", "admin"]);
  });

  it("safely masks string literals in unbounded select checks", () => {
    // Attack: Use a bounding keyword inside a string literal to try and make an unbounded SELECT appear bounded
    const sql = "SELECT '/* LIMIT */', * FROM users";
    expect(Policy._isUnboundedSelect(sql)).toBe(true);
  });

  it("throws error for ambiguous dialect-specific escapes", () => {
    // Escape `\'` is ambiguous between MySQL and SQLite
    const sql2 = "SELECT 1 '\\''; DROP TABLE users;";
    expect(() => classifyStatements(sql2)).toThrow(/Ambiguous SQL statement boundaries/);
  });

  it("throws error for SQL Server brackets and MySQL executable comments", () => {
    const sql1 = "SELECT 1 AS [--]; DROP TABLE users;";
    expect(() => classifyStatements(sql1)).toThrow(/Ambiguous or unrecognized SQL construct/);

    const sql2 = "SELECT 1 /*!50000 */; DROP TABLE users;";
    expect(() => classifyStatements(sql2)).toThrow(/Ambiguous or unrecognized SQL construct/);

    const sql3 = "SELECT 1 /*M!100000 UNION SELECT password FROM users */;";
    expect(() => classifyStatements(sql3)).toThrow(/Ambiguous or unrecognized SQL construct/);
  });

  it("preserves the bracket defense for the sqlserver dialect", () => {
    // The SQL Server bracket-identifier bypass must still be rejected when the
    // configured dialect is sqlserver.
    const sql = "SELECT 1 AS [--]; DROP TABLE users;";
    expect(() => classifyStatements(sql, "sqlserver")).toThrow(
      /Ambiguous or unrecognized SQL construct/,
    );
  });

  it("allows legitimate Postgres array brackets when dialect is postgres", () => {
    expect(classifyStatements("SELECT ARRAY[1,2,3]", "postgres")).toEqual([
      "read",
    ]);
    expect(classifyStatements("SELECT '{1}'::int[]", "postgres")).toEqual([
      "read",
    ]);
  });

  it("allows array brackets for mysql/sqlite/oracle dialects too", () => {
    expect(classifyStatements("SELECT ARRAY[1,2,3]", "mysql")).toEqual(["read"]);
    expect(classifyStatements("SELECT ARRAY[1,2,3]", "sqlite")).toEqual(["read"]);
    expect(classifyStatements("SELECT ARRAY[1,2,3]", "oracle")).toEqual(["read"]);
  });

  it("still rejects executable comments regardless of dialect", () => {
    expect(() => classifyStatements("SELECT 1 /*!50000 */", "postgres")).toThrow(
      /Ambiguous or unrecognized SQL construct/,
    );
  });

  it("end-to-end: postgres dialect allows a bounded ARRAY read", () => {
    const p = new Policy("auto", undefined, undefined, "postgres");
    const r = p.checkQuery("SELECT ARRAY[1,2,3] FROM t WHERE id=1");
    expect(r.decision).toBe(Decision.ALLOW);
  });

  it("checkQuery returns a controlled deny (never throws) on fail-closed ambiguous SQL", () => {
    // Regression: _splitStatements / _maskStringLiterals throw on dialect-
    // disputed constructs. checkQuery must catch those and return a deny,
    // because _preCheckPolicy (dispatcher.ts) calls checkQuery without its
    // own try/catch — an escaping throw would surface as an unhandled error
    // instead of a policy denial.
    const p = new Policy("auto", undefined, undefined, "postgres");

    const execComment = p.checkQuery("SELECT 1 /*!50000 */; DROP TABLE users;");
    expect(execComment.decision).toBe(Decision.DENY);
    expect(execComment.reason).toMatch(/Ambiguous or unrecognized SQL construct/);

    // Backslash dialect-differential. This one is caught by the statement
    // splitter, not the string mask — its semicolon lands at different
    // offsets under the two escape modes. Kept because it pins the deny,
    // but see the semicolon-free case below for the mask itself.
    const ambiguousString = p.checkQuery("SELECT 1 '\\'; DROP TABLE users;");
    expect(ambiguousString.decision).toBe(Decision.DENY);
    expect(ambiguousString.reason).toMatch(/Ambiguous SQL statement boundaries/);
  });

  it("denies a semicolon-free string-mask differential instead of allowing it", () => {
    // The statement splitter cannot see this one: with no semicolon, both
    // escape modes agree on (zero) boundaries. It reaches _maskStringLiterals,
    // which scanned backslash-as-literal only.
    //
    // Under that single reading the string is just `\`, so `WHERE fake=` sits
    // outside it and _isUnboundedSelect called the read bounded — decision
    // `allow`. MySQL reads `\'` as an escaped quote, making ` WHERE fake=`
    // literal text, so what actually executes is an unbounded read of `users`.
    //
    // Both scans now run and disagreement fails closed.
    const p = new Policy("auto", undefined, undefined, "mysql");
    const sql = "SELECT '\\' WHERE fake=', col FROM users";

    let result: ReturnType<Policy["checkQuery"]> | null = null;
    expect(() => {
      result = p.checkQuery(sql);
    }).not.toThrow();
    expect(result!.decision).toBe(Decision.DENY);
    expect(result!.reason).toMatch(/Ambiguous SQL string boundaries/);

    // And the mask itself refuses rather than returning one dialect's reading.
    expect(() => Policy._maskStringLiterals(sql)).toThrow(
      /Ambiguous SQL string boundaries/,
    );
  });

  it("still masks literals when the two escape modes agree", () => {
    // The fail-closed path must not swallow ordinary SQL. No backslash here,
    // so both scans mark the same span and masking proceeds as before.
    const masked = Policy._maskStringLiterals("SELECT 'WHERE x' FROM t");
    expect(masked).toBe("SELECT '       ' FROM t");
    expect(Policy._isUnboundedSelect("SELECT 'WHERE x' FROM t")).toBe(true);
  });

  it("formats present_only statements under the policy dialect, not `generic`", () => {
    // `_formatStatement` re-strips comments before echoing the statement back.
    // It must do so under the policy's own dialect: for postgres, `[` opens an
    // array literal, while `generic`/sqlserver fail closed on it as an
    // ambiguous identifier quote. Formatting under the wrong dialect turned a
    // legitimate postgres DELETE into a bogus "ambiguous construct" deny.
    const p = new Policy("auto", undefined, undefined, "postgres");
    const r = p.checkQuery("DELETE FROM t WHERE ids = ARRAY[1,2]");
    expect(r.decision).toBe(Decision.PRESENT_ONLY);
    if (r.decision === Decision.PRESENT_ONLY) {
      expect(r.formatted_sql).toBe("DELETE FROM t WHERE ids = ARRAY[1,2]");
    }
  });

  it("formats a present_only compound under the policy dialect", () => {
    // The compound branch re-formats *every* statement, including ones whose
    // own decision was `allow`. A postgres array literal in the leading SELECT
    // must not blow up the formatter for the trailing ADMIN statement.
    const p = new Policy("auto", undefined, undefined, "postgres");
    const r = p.checkQuery(
      "SELECT ARRAY[1,2,3] FROM t WHERE id=1; DROP TABLE users",
    );
    expect(r.decision).toBe(Decision.PRESENT_ONLY);
    if (r.decision === Decision.PRESENT_ONLY) {
      expect(r.formatted_sql).toContain("ARRAY[1,2,3]");
      expect(r.formatted_sql).toContain("DROP TABLE users");
    }
  });

  it("keeps the bracket defense on a present_only compound under sqlserver", () => {
    // Mirror of the postgres compound above on a dialect where `[` *is*
    // ambiguous. The statement is rejected at classification (inside
    // checkQuery's fail-closed try), so the caller sees a controlled deny and
    // never an escaping throw — _preCheckPolicy (dispatcher.ts) invokes
    // checkQuery without its own try/catch.
    const p = new Policy("auto", undefined, undefined, "sqlserver");
    let result: ReturnType<Policy["checkQuery"]> | null = null;
    expect(() => {
      result = p.checkQuery("SELECT [c] FROM t WHERE id=1; DROP TABLE users");
    }).not.toThrow();
    expect(result!.decision).toBe(Decision.DENY);
    expect(result!.reason).toMatch(/Ambiguous or unrecognized SQL construct/);
  });

  it("throws error for SQL Server nested block comments", () => {
    // Nested block comments are treated as a single comment in T-SQL
    // but the inner `/*` is treated as comment text in MySQL/Postgres/SQLite.
    const sql = "SELECT 1 /* outer /* inner */ ' still comment */; DROP TABLE users;";
    expect(() => classifyStatements(sql)).toThrow(/Ambiguous or unrecognized SQL construct/);
  });

  it("safely replaces comments with a space to prevent token fusing", () => {
    // Attack: `password/**/FROM` becomes `passwordFROM` if the comment is completely deleted.
    // By replacing comments with a space, `password/**/FROM` safely evaluates to `password FROM`.
    const sql = "SELECT password/**/FROM users";
    const masked = Policy._maskStringLiterals(sql);

    // Test that the unbounded check correctly flags this as unbounded since FROM is preserved
    // and not fused into passwordFROM.
    expect(Policy._isUnboundedSelect(sql)).toBe(true);
    expect(Policy._isUnboundedSelect(masked)).toBe(true);

    const sql2 = "SELECT 1--1\nUNION SELECT password FROM users";
    expect(() => classifyStatements(sql2)).toThrow(/Ambiguous or unrecognized SQL construct/);
  });

  it("safely handles dollar quotes containing identical subtags", () => {
    // Attack: `$` character in an identifier preceding the dollar-quote
    // The previous bug allowed `col$$tag$` to start a dollar quote.
    // This correctly parses as [read, admin, read] instead of swallowing the drop table.
    const sql = "SELECT 1 AS col$$tag$; DROP TABLE users; SELECT 2 AS col$$tag$";
    expect(classifyStatements(sql)).toEqual(["read", "admin", "read"]);

    // Test SQL Server `#` and `@` prefixes
    const sql2 = "SELECT * FROM #$tag$; DROP TABLE users; SELECT * FROM #$tag$";
    expect(classifyStatements(sql2)).toEqual(["read", "admin", "read"]);
    const sql3 = "SELECT * FROM @$tag$; DROP TABLE users; SELECT * FROM @$tag$";
    expect(classifyStatements(sql3)).toEqual(["read", "admin", "read"]);

    // Test Unicode identifiers
    const sql4 = "SELECT 1 AS é$tag$; DROP TABLE users; SELECT 2 AS é$tag$";
    expect(classifyStatements(sql4)).toEqual(["read", "admin", "read"]);
  });
});
