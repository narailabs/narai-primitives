import { describe, expect, it } from "vitest";
import { classifyStatements } from "../../../src/connectors/db/lib/policy.js";

describe("SQL policy parser security", () => {
  it("safely handles comments masquerading as strings", () => {
    // Attack: Use a block comment start inside a string literal
    const sql1 = "SELECT 1 '/*' ; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    const sql2 = "SELECT 1 \"--\" ; DROP TABLE users;";
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);
  });

  it("splits across a backslash-quote under both escape conventions", () => {
    // The two SQL escape conventions disagree on what `'\'` means, so the gate
    // splits at the UNION of statement boundaries from both — never hiding a
    // statement any supported dialect would execute.

    // SQLite / SQL Server / Oracle / standard-PostgreSQL: backslash is a literal
    // char, so `'\'` is a complete string and `; DROP ...` is a 2nd statement.
    const sqliteStyle = "SELECT 1 '\\'; DROP TABLE users;"; // actual SQL: SELECT 1 '\'; DROP TABLE users;
    expect(classifyStatements(sqliteStyle)).toEqual(["read", "admin"]);

    // MySQL/MariaDB (default sql_mode) and PostgreSQL E'': backslash escapes the
    // quote, so `'\''` closes on the 3rd quote and `; DROP ...` is a 2nd
    // statement. The naive single-mode scanner would stay in-string here.
    const mysqlStyle = "SELECT 1 '\\''; DROP TABLE users;"; // actual SQL: SELECT 1 '\''; DROP TABLE users;
    expect(classifyStatements(mysqlStyle)).toEqual(["read", "admin"]);

    // An escaped backslash followed by a real closing quote is still two stmts.
    const escapedBackslash = "SELECT 1 '\\\\'; DROP TABLE users;"; // actual SQL: SELECT 1 '\\'; DROP TABLE users;
    expect(classifyStatements(escapedBackslash)).toEqual(["read", "admin"]);
  });

  it("treats SQL-standard doubled quotes as in-string escapes", () => {
    // `''` / `""` are escaped quotes in every supported dialect; the embedded
    // `;` stays inside the literal and must not split off a phantom statement.
    const sql = "SELECT 1 \"''\"; DROP TABLE users;";
    expect(classifyStatements(sql)).toEqual(["read", "admin"]);
  });

  it("safely handles line comments containing strings with unclosed quotes", () => {
    const sql1 = "SELECT 1 -- '\n ; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);
  });
});
