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

  it("safely handles strings masquerading as comments", () => {
    // Attack: Try to hide a semicolon and DROP TABLE inside what looks like a comment but is actually a string due to escaping
    // The previous bug was that `\` was treated as an escape character, meaning `\'` was parsed as a quote inside a string.
    // However, in standard SQL, backslash is just a backslash, and the only escape is `''`.
    // So `SELECT 1 '\'; DROP TABLE users;` was incorrectly parsed as an unterminated string.
    // To handle dialects correctly, the parser uses a union split of both backslash-as-literal (SQLite, Postgres standard)
    // and backslash-as-escape (MySQL, Postgres E''). Both styles are split correctly.
    const sql1 = "SELECT 1 '\\'; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    const sql2 = "SELECT 1 '\\''; DROP TABLE users;";
    expect(classifyStatements(sql2)).toEqual(["read", "admin"]);

    const sql3 = "SELECT 1 \"''\"; DROP TABLE users;";
    expect(classifyStatements(sql3)).toEqual(["read", "admin"]);
  });

  it("safely handles line comments containing strings with unclosed quotes", () => {
    const sql1 = "SELECT 1 -- '\n ; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);
  });

  it("treats a comment marker inside a dollar-quoted string as literal data", () => {
    // PostgreSQL dollar-quoting: `$$ ... $$` content is literal, so the `--` is
    // NOT a comment. If the stripper mistook it for one it would delete the
    // trailing `; DROP ...`, hiding the admin statement (under-split = bypass).
    const sql1 = "SELECT $$ -- not comment $$; DROP TABLE users;";
    expect(classifyStatements(sql1)).toEqual(["read", "admin"]);

    // Tagged dollar-quote with an embedded semicolon stays a single statement —
    // the `;` inside the body is literal, not a separator (no phantom split).
    const sql2 = "SELECT $tag$ a; b $tag$;";
    expect(classifyStatements(sql2)).toEqual(["read"]);

    // A real second statement after a closed dollar-quote is still split off.
    const sql3 = "SELECT $$x$$; DROP TABLE users;";
    expect(classifyStatements(sql3)).toEqual(["read", "admin"]);
  });
});
