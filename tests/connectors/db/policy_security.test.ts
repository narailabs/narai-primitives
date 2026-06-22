import { describe, expect, it } from "vitest";
import { classifyStatements, Policy } from "../../../src/connectors/db/lib/policy.js";

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

  it("stops line comments at carriage returns (CR-only line endings)", () => {
    // SQL Server accepts a bare CR as a line terminator. `--\r` must end the
    // line comment so the following `; DROP TABLE users;` is not swallowed
    // into a single READ while the driver executes the batch.
    const sql = "SELECT 1 --\r; DROP TABLE users;";
    expect(classifyStatements(sql)).toEqual(["read", "admin"]);
  });

  it("safely handles dollar quotes containing identical subtags", () => {
    // Attack: `$` character in an identifier preceding the dollar-quote
    // The previous bug allowed `col$$tag$` to start a dollar quote.
    // This correctly parses as [read, admin, read] instead of swallowing the drop table.
    const sql = "SELECT 1 AS col$$tag$; DROP TABLE users; SELECT 2 AS col$$tag$";
    expect(classifyStatements(sql)).toEqual(["read", "admin", "read"]);
  });

  it("does not open dollar quotes after SQL Server identifier prefixes", () => {
    // Attack: a temp table name `#$tag$` makes `$` part of the identifier (SQL
    // Server temp-table prefix `#`), so it must not start a dollar quote that
    // swallows the `; DROP TABLE users;` into a single READ.
    const sql = "SELECT * FROM #$tag$; DROP TABLE users; SELECT * FROM #$tag$";
    expect(classifyStatements(sql)).toEqual(["read", "admin", "read"]);

    // Same for the `@` variable prefix.
    const sql2 = "SELECT @x$tag$; DROP TABLE users; SELECT @x$tag$";
    expect(classifyStatements(sql2)).toEqual(["read", "admin", "read"]);
  });
});
