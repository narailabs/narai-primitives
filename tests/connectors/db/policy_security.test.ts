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

  it("rejects a boundary disagreement even when both modes find the same count", () => {
    // Pins the parity check in `_splitStatements` at the *position* level, not
    // just the count. Both escape modes find exactly one semicolon here, but at
    // different offsets: without backslash-as-escape the boundary is the `;`
    // inside `'a\\';x'`, with it the string runs on and the boundary is the `;`
    // after `x'`. A length-only comparison would let this through and split the
    // statement at the attacker-chosen offset.
    const sql = "SELECT 'a\\';x'; SELECT 2";
    expect(() => classifyStatements(sql)).toThrow(/Ambiguous SQL statement boundaries/);
  });

  it("splits a multi-statement script at every boundary in order", () => {
    // The boundary scan is a single forward pass, so the indices it collects
    // are already ascending and duplicate-free. This pins that the split still
    // walks all four boundaries in order.
    expect(classifyStatements("SELECT 1; INSERT INTO t VALUES (1); DELETE FROM t; DROP TABLE t")).toEqual([
      "read",
      "write",
      "delete",
      "admin",
    ]);
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
