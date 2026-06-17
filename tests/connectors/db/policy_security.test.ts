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

  it("over-splits on a backslash before a closing quote (dialect-safe)", () => {
    // Codex P1 regression: in SQLite, SQL Server, Oracle and standard-conforming
    // PostgreSQL, backslash is NOT a string escape, so `'\'` is a complete
    // literal and the trailing `; DROP ...` is a separate statement. The parser
    // must therefore treat the quote after the backslash as a real terminator —
    // treating `\` as an escape would keep it in-string across the `;` and hide
    // the DROP (under-split = bypass). Over-split is the safe bias for a gate.
    const sql1 = "SELECT 1 '\\'; DROP TABLE users;"; // actual SQL: SELECT 1 '\'; DROP TABLE users;
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    // An escaped backslash followed by a real closing quote is still two stmts.
    const sql2 = "SELECT 1 '\\\\'; DROP TABLE users;"; // actual SQL: SELECT 1 '\\'; DROP TABLE users;
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);
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
