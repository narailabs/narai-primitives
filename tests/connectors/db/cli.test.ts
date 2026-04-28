/**
 * Tests for cli.ts — the db-agent-connector CLI.
 *
 * Exercises the policy gate + SQLite driver path end-to-end via the
 * `--action/--params` envelope. Uses temp SQLite files so tests are
 * self-contained and fast.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { main } from "../../../src/connectors/db/cli.js";
import { argsFor, parseResult, runCli } from "./fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_CLI = path.resolve(__dirname, "..", "..", "..", "dist", "connectors", "db", "cli.js");

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

function makeFixtureDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-query-test-"));
  const dbPath = path.join(tmp, "test.db");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);",
  );
  db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(
    "Alice",
    "alice@example.com",
  );
  db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(
    "Bob",
    "bob@example.com",
  );
  db.close();
  return dbPath;
}

describe("cli main() — argument parsing", () => {
  it("requires --action", async () => {
    const stderr = await captureStderr(async () => {
      const code = await main([]);
      expect(code).toBe(2);
    });
    expect(stderr).toContain("--action");
  });

  it("rejects unknown --action", async () => {
    // Framework: unknown action → VALIDATION_ERROR envelope on stdout, exit 1.
    const stdout = await captureStdout(async () => {
      const code = await main(["--action", "bogus"]);
      expect(code).toBe(1);
    });
    const result = parseResult(stdout);
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("VALIDATION_ERROR");
    expect(result.message).toContain("bogus");
  });

  it("malformed --params JSON: stderr message and exit code 2", async () => {
    // Framework: malformed --params is treated as a POSIX arg error (exit 2)
    // rather than a runtime VALIDATION_ERROR envelope — consistent with the
    // rest of the @narai/*-agent-connector family.
    const stderr = await captureStderr(async () => {
      const code = await main(["--action", "query", "--params", "{not json"]);
      expect(code).toBe(2);
    });
    expect(stderr).toContain("--params");
  });

  it("returns VALIDATION_ERROR when neither env nor sqlite_path is provided", async () => {
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", { sql: "SELECT 1" }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout);
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("VALIDATION_ERROR");
  });

  it("rejects both env and sqlite_path together", async () => {
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sqlite_path: ":memory:",
          sql: "SELECT 1",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout);
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("cli main() — query action on sqlite_path", () => {
  it("runs a read query and returns structured JSON", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "SELECT id, name, email FROM users WHERE id > 0 ORDER BY id LIMIT 10",
          }),
        );
        expect(code).toBe(0);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("ok");
      expect(result.row_count).toBe(2);
      expect(result.columns).toEqual(["id", "name", "email"]);
      expect((result.rows as Array<{ name: string }>)[0]!.name).toBe("Alice");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("escalates unbounded SELECT (no WHERE/LIMIT)", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "SELECT * FROM users",
          }),
        );
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("escalate");
      expect((result as Record<string, unknown>)["message"]).toContain("Unbounded");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  // V2.0: DROP=admin defaults to present, not denied.
  it("returns DROP (admin) as present_only by default", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "DROP TABLE users",
          }),
        );
        expect(code).toBe(0);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("present_only");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  // V2.0: INSERT (write) defaults to escalate.
  it("returns INSERT (write) as escalate by default", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "INSERT INTO users (name) VALUES ('Mallory')",
          }),
        );
        expect(code).toBe(1);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("escalate");
      const db = new Database(dbPath);
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM users")
        .get() as { c: number };
      expect(count.c).toBe(2);
      db.close();
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  // V2.0: DELETE remains present_only by default — formatted SQL returned.
  it("returns DELETE (delete) as present_only by default", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "DELETE FROM users WHERE id=1",
          }),
        );
        expect(code).toBe(0);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("present_only");
      const ext = (result as Record<string, unknown>)["extension"] as Record<string, unknown>;
      expect(ext["formatted_sql"]).toContain("DELETE");
      const db = new Database(dbPath);
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM users")
        .get() as { c: number };
      expect(count.c).toBe(2);
      db.close();
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  // V2.0: PRIVILEGE remains denied by default.
  it("blocks GRANT (privilege) with status=denied", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", {
            sqlite_path: dbPath,
            sql: "GRANT SELECT ON users TO u",
          }),
        );
        expect(code).toBe(1);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("denied");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("rejects empty sql with a validation error", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("query", { sqlite_path: dbPath, sql: "" }),
        );
        expect(code).toBe(1);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("error");
      expect(result.error_code).toBe("VALIDATION_ERROR");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("cli main() — schema action on sqlite_path", () => {
  it("returns table metadata", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        const code = await main(
          argsFor("schema", { sqlite_path: dbPath }),
        );
        expect(code).toBe(0);
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("ok");
      expect(result.table_count).toBeGreaterThanOrEqual(1);
      const names = (result.tables as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("users");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("honours a filter param", async () => {
    const dbPath = makeFixtureDb();
    try {
      const stdout = await captureStdout(async () => {
        await main(
          argsFor("schema", { sqlite_path: dbPath, filter: "user%" }),
        );
      });
      const result = parseResult(stdout);
      expect(result.status).toBe("ok");
      const names = (result.tables as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("users");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("compiled CLI (dist/cli.js)", () => {
  it("prints help with --help", () => {
    if (!fs.existsSync(DIST_CLI)) return; // only runs after `npm run build`
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--action");
    expect(stdout).toContain("query");
    expect(stdout).toContain("schema");
  });
});
