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
