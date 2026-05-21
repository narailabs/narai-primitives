/**
 * Framework integration tests for the db-agent-connector's 2.x surface.
 *
 * Exercises the createConnector wrapper's envelope translation and the
 * toolkit's hardship/curate integrations. The existing cli/cli_env/policy
 * tests continue to cover the internal dispatcher's behavior in depth;
 * this file adds coverage specifically for the framework boundary.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import connector, { buildDbConnector } from "../../../src/connectors/db/index.js";

let tmpHome: string;
let tmpCwd: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "db-fw-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "db-fw-cwd-"));
  origHome = process.env["HOME"];
  origCwd = process.cwd();
  process.env["HOME"] = tmpHome;
  process.chdir(tmpCwd);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function makeFixtureDb(): string {
  const dbPath = path.join(tmpCwd, "test.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
  db.prepare("INSERT INTO users (name) VALUES (?)").run("Alice");
  db.close();
  return dbPath;
}

describe("framework envelope translation", () => {
  it("query on sqlite_path → success envelope with data.rows/columns", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("query", {
      sqlite_path: dbPath,
      sql: "SELECT id, name FROM users WHERE id = 1",
    });
    expect(env.status).toBe("success");
    if (env.status === "success") {
      const data = env.data as {
        rows: Array<Record<string, unknown>>;
        columns: string[];
        row_count: number;
      };
      expect(data.columns).toEqual(["id", "name"]);
      expect(data.rows[0]?.["name"]).toBe("Alice");
      expect(data.row_count).toBe(1);
    }
  });

  // V2.0: DELETE defaults to present, so DELETE drives this assertion now.
  it("DELETE on sqlite_path → present_only extended envelope with formatted_sql", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("query", {
      sqlite_path: dbPath,
      sql: "DELETE FROM users WHERE id=1",
    });
    expect(env.status).toBe("present_only");
    const extended = env as Record<string, unknown>;
    expect(extended["action"]).toBe("query");
    const ext = extended["extension"] as Record<string, unknown>;
    expect(ext["formatted_sql"]).toContain("DELETE");
    expect(extended["message"]).toBeDefined();
    expect(extended["formatted_sql"]).toBeUndefined();
    expect(extended["reason"]).toBeUndefined();
  });

  // V2.0: WRITE (INSERT) defaults to escalate.
  it("WRITE on sqlite_path → escalate extended envelope", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("query", {
      sqlite_path: dbPath,
      sql: "INSERT INTO users (name) VALUES ('Mallory')",
    });
    expect(env.status).toBe("escalate");
    const extended = env as Record<string, unknown>;
    expect(extended["message"]).toBeDefined();
  });

  // V2.0: ADMIN (DROP) defaults to present, not denied.
  it("ADMIN on sqlite_path → present_only extended envelope", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("query", {
      sqlite_path: dbPath,
      sql: "DROP TABLE users",
    });
    expect(env.status).toBe("present_only");
    const extended = env as Record<string, unknown>;
    expect(extended["message"]).toBeDefined();
  });

  it("unbounded SELECT → escalate extended envelope", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("query", {
      sqlite_path: dbPath,
      sql: "SELECT * FROM users",
    });
    expect(env.status).toBe("escalate");
    const extended = env as Record<string, unknown>;
    expect((extended["message"] as string).toLowerCase()).toContain("unbounded");
  });

  it("validation error → error envelope with error_code and message", async () => {
    const env = await connector.fetch("query", {
      // Missing both sqlite_path and env — dispatcher rejects.
      sql: "SELECT 1",
    });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toBeDefined();
    }
  });

  it("schema action → success envelope with data.tables/table_count", async () => {
    const dbPath = makeFixtureDb();
    const env = await connector.fetch("schema", { sqlite_path: dbPath });
    expect(env.status).toBe("success");
    if (env.status === "success") {
      const data = env.data as {
        tables: Array<{ name: string }>;
        table_count: number;
      };
      expect(data.table_count).toBeGreaterThanOrEqual(1);
      expect(data.tables.map((t) => t.name)).toContain("users");
    }
  });
});

describe("hardship logging integration", () => {
  // Construct a fresh connector per test AFTER HOME/cwd have been redirected,
  // because the hardship recorder resolves its target path at construction
  // time.
  // Toolkit 3.0 tiered storage: null-scope hardships are written under
  // `<cwd|home>/.claude/connectors/<name>/global/hardships.jsonl`. Without
  // a cwd/.claude, writes fall through to the user-global tier.
  it("validation error produces hardship entry", async () => {
    const c = buildDbConnector();
    await c.fetch("query", { sql: "SELECT 1" }); // missing env/sqlite_path
    const logPath = path.join(
      tmpHome, ".claude", "connectors", "db", "global", "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
    expect(entry.connector).toBe("db");
    expect(entry.action).toBe("query");
  });

  it("routes to project-local when cwd/.claude exists", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const c = buildDbConnector();
    await c.fetch("query", { sql: "SELECT 1" });
    const projectLog = path.join(
      tmpCwd, ".claude", "connectors", "db", "global", "hardships.jsonl",
    );
    expect(fs.existsSync(projectLog)).toBe(true);
  });

  it("denied decisions do NOT produce hardship entries", async () => {
    // V2.0: PRIVILEGE remains the canonical hard-deny class.
    const dbPath = makeFixtureDb();
    const c = buildDbConnector();
    await c.fetch("query", {
      sqlite_path: dbPath,
      sql: "GRANT SELECT ON users TO u",
    });
    const logPath = path.join(
      tmpHome, ".claude", "connectors", "db", "global", "hardships.jsonl",
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe("server param (replaces env)", () => {
  it("accepts `server` in place of `env` for query", async () => {
    // Schema-level acceptance of `server`. Uses a mocked dispatch so no
    // real server config is required.
    const c = buildDbConnector({
      dispatch: async () => ({
        status: "ok" as const,
        rows: [{ x: 1 }],
        column_names: ["x"],
        row_count: 1,
      }),
    });
    const result = await c.fetch("query", { server: "dev", sql: "SELECT 1 AS x" });
    expect(result.status).toBe("success");
  });

  it("accepts `server` for schema", async () => {
    const c = buildDbConnector({
      dispatch: async () => ({
        status: "ok" as const,
        tables: [],
        table_count: 0,
      }),
    });
    const result = await c.fetch("schema", { server: "dev" });
    expect(result.status).toBe("success");
  });

  it("rejects when both `server` and `env` are set with different values", async () => {
    // The real dispatcher's requireConnTarget catches the conflict BEFORE
    // any config lookup, so this test needs no real server config.
    const result = await connector.fetch("query", {
      server: "dev",
      env: "prod",
      sql: "SELECT 1",
    });
    expect(result.status).toBe("error");
    expect(String((result as Record<string, unknown>)["error_code"])).toBe("VALIDATION_ERROR");
  });

  it("normalizes `env` alias before mutual-exclusion check (proves env→server runs)", async () => {
    // If `env` is correctly normalized to `server`, this hits the
    // mutual-exclusion guard against `sqlite_path`. If normalization
    // didn't run, it would fail with a different error (or, worse,
    // silently succeed). Routing through the real dispatcher — no mock.
    const result = await connector.fetch("query", {
      sqlite_path: "/tmp/whatever.db",
      env: "dev",
      sql: "SELECT 1",
    });
    expect(result.status).toBe("error");
    const r = result as Record<string, unknown>;
    expect(String(r["error_code"])).toBe("VALIDATION_ERROR");
    expect(String(r["message"])).toMatch(/mutually exclusive/i);
  });

  it("warns but does not error when `server` and `env` are set to the same value", async () => {
    // Same value is still a deprecated usage of `env` — warn but accept.
    const writes: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      await connector.fetch("query", {
        server: "dev",
        env: "dev",
        sql: "SELECT 1",
      });
      // Don't assert on result here — there's no plugin config, so it will
      // be a CONFIG_ERROR. The point is the deprecation warning fired.
    } finally {
      process.stderr.write = origWrite;
    }
    expect(writes.some((s) => s.includes("env` is deprecated"))).toBe(true);
  });

  it("treats `env` as an alias when only `env` is set", async () => {
    // Confirms the schema still accepts `env` (backward compat).
    // Uses a mocked dispatch so no real server config is required.
    const c = buildDbConnector({
      dispatch: async () => ({
        status: "ok" as const,
        rows: [{ x: 1 }],
        column_names: ["x"],
        row_count: 1,
      }),
    });
    const result = await c.fetch("query", { env: "dev", sql: "SELECT 1 AS x" });
    expect(result.status).toBe("success");
  });
});

describe("--curate flag", () => {
  it("prints a JSON snapshot and exits 0", async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await connector.main(["--curate"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.connector).toBe("db");
      expect(parsed).toHaveProperty("clusters");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--help lists both actions", async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await connector.main(["--help"]);
      expect(code).toBe(0);
      const out = writes.join("");
      expect(out).toContain("query");
      expect(out).toContain("schema");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
