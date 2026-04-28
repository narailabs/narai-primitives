/**
 * Unit tests for OracleDriver — pure mocks, no container required.
 *
 * Live integration tests live in `live_oracle.test.ts` and are skipped
 * unless `TEST_LIVE_ORACLE` is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — accessible from the vi.mock factory.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  type MockConn = {
    execute: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    callTimeout: number;
  };
  class MockPool {
    public readonly attrs: Record<string, unknown>;
    public readonly conns: MockConn[];
    public readonly closeSpy: ReturnType<typeof vi.fn>;
    constructor(attrs: Record<string, unknown>) {
      this.attrs = attrs;
      this.conns = [];
      this.closeSpy = vi.fn(() => Promise.resolve());
    }
    async getConnection(): Promise<MockConn> {
      const c: MockConn = {
        execute: vi.fn(async () => ({ rows: [], metaData: [] })),
        close: vi.fn(async () => undefined),
        callTimeout: 0,
      };
      this.conns.push(c);
      return c;
    }
    close(_drainTime?: number): Promise<void> {
      return this.closeSpy();
    }
  }
  const instances: MockPool[] = [];
  return { MockPool, instances };
});

vi.mock("oracledb", () => ({
  default: {
    createPool: async (attrs: Record<string, unknown>) => {
      const p = new mocks.MockPool(attrs);
      mocks.instances.push(p);
      return p;
    },
    OUT_FORMAT_OBJECT: 4001,
    DB_TYPE_CLOB: 2017,
    outFormat: 4002,
    fetchAsString: [] as number[],
  },
}));

import { OracleDriver } from "../../../../src/connectors/db/lib/drivers/oracle.js";

function latestPool(): InstanceType<typeof mocks.MockPool> {
  const p = mocks.instances[mocks.instances.length - 1];
  if (!p) throw new Error("no pool instantiated yet");
  return p;
}

function lastConn(): InstanceType<typeof mocks.MockPool>["conns"][number] {
  const pool = latestPool();
  const c = pool.conns[pool.conns.length - 1];
  if (!c) throw new Error("no connection checked out");
  return c;
}

describe("wiki_db.drivers.oracle (unit)", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("connect — connectString assembly (G-ORA-CONNSTRING)", () => {
    it("composes EZConnect 'host:port/service' from service_name", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "ora.example.com",
        port: 1522,
        service_name: "FREEPDB1",
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toBe(
        "ora.example.com:1522/FREEPDB1",
      );
      expect(latestPool().attrs["user"]).toBe("u");
      expect(latestPool().attrs["password"]).toBe("p");
    });

    it("falls back to the `database` field when service_name is absent", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h",
        port: 1521,
        database: "ORCL",
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toBe("h:1521/ORCL");
    });

    it("composes legacy SID form 'host:port:sid' when sid is provided", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "ora",
        port: 1521,
        sid: "XEPDB1",
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toBe("ora:1521:XEPDB1");
    });

    it("uses an explicit connectString verbatim if provided", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=S)))",
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toMatch(/^\(DESCRIPTION=/);
    });

    it("defaults host=localhost and port=1521 when missing or wrong type", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: 99,           // non-string → localhost
        port: "1521",       // non-number → 1521
        service_name: "S",
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toBe("localhost:1521/S");
    });

    it("falls back to empty service_name when neither service_name nor database is a string", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h",
        port: 1521,
        user: "u",
        password: "p",
      });
      expect(latestPool().attrs["connectString"]).toBe("h:1521/");
    });

    it("omits user/password from poolAttrs when missing or wrong type", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h",
        port: 1521,
        service_name: "S",
        user: 99,
        password: { secret: true },
      });
      expect(latestPool().attrs).not.toHaveProperty("user");
      expect(latestPool().attrs).not.toHaveProperty("password");
    });

    it("pool_max=25 wins over default 10", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        pool_max: 25,
      });
      expect(latestPool().attrs["poolMax"]).toBe(25);
    });

    it("pool_max non-number falls back to 10", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        pool_max: "ten",
      });
      expect(latestPool().attrs["poolMax"]).toBe(10);
    });
  });

  describe("connect — schema handling (G-ORA-IGNORE-PUBLIC-DEFAULT)", () => {
    it("treats schema='public' as no override (handle.schema is null)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "public",
      });
      expect(handle.schema).toBeNull();
    });

    it("treats schema='PUBLIC' (case variant) as no override too", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "Public",
      });
      expect(handle.schema).toBeNull();
    });

    it("respects an explicit non-public schema verbatim", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "HR",
      });
      expect(handle.schema).toBe("HR");
    });

    it("treats empty-string schema as no override", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "",
      });
      expect(handle.schema).toBeNull();
    });

    it("treats non-string schema (e.g. number) as no override", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: 42,
      });
      expect(handle.schema).toBeNull();
    });
  });

  describe("connect — pool reuse", () => {
    it("reuses the pool across calls — one Pool, many connections", async () => {
      const drv = new OracleDriver();
      await drv.connect({ host: "h", port: 1521, service_name: "S", user: "u", password: "p" });
      await drv.connect({ host: "h", port: 1521, service_name: "S", user: "u", password: "p" });
      await drv.connect({ host: "h", port: 1521, service_name: "S", user: "u", password: "p" });
      expect(mocks.instances).toHaveLength(1);
      expect(latestPool().conns).toHaveLength(3);
    });
  });

  describe("executeRead — sync stub returns SYNC_UNSUPPORTED", () => {
    it("returns the sync-unsupported sentinel", () => {
      const drv = new OracleDriver();
      const r = drv.executeRead(null as unknown, "SELECT 1 FROM DUAL");
      expect(r.status).toBe("error");
      expect(r.error_code).toBe("SYNC_UNSUPPORTED");
    });
  });

  describe("executeReadAsync — happy path + G-LIMIT-WRAP + G-ORA-TIMEOUT", () => {
    it("wraps rows/cols, reports row_count + truncation", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({
        rows: [
          { ID: 1, NAME: "Alice" },
          { ID: 2, NAME: "Bob" },
          { ID: 3, NAME: "Carol" },
        ],
        metaData: [{ name: "ID" }, { name: "NAME" }],
      }));
      const res = await drv.executeReadAsync(
        handle,
        "SELECT id, name FROM users",
        null,
        2,
      );
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(2);
      expect(res.truncated).toBe(true);
      expect(res.columns).toEqual(["ID", "NAME"]);
    });

    it("does not truncate when row count <= maxRows", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({
        rows: [{ X: 1 }],
        metaData: [{ name: "X" }],
      }));
      const res = await drv.executeReadAsync(handle, "SELECT 1 X FROM DUAL", null, 5);
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(1);
      expect(res.truncated).toBe(false);
    });

    it("treats undefined rows/metaData as empty without crashing", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({}));
      const res = await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(0);
      expect(res.columns).toEqual([]);
    });

    it("sets connection.callTimeout from timeoutMs and clears it in finally (G-ORA-TIMEOUT)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      let timeoutAtExecute = -1;
      conn.execute.mockImplementation(async function (this: unknown) {
        timeoutAtExecute = conn.callTimeout;
        return { rows: [], metaData: [] };
      });
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL", null, 5, 7000);
      expect(timeoutAtExecute).toBe(7000);
      expect(conn.callTimeout).toBe(0);
    });

    it("clamps a non-positive timeoutMs to 1 (Math.max(1, _) guard)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      let timeoutAtExecute = -1;
      conn.execute.mockImplementation(async () => {
        timeoutAtExecute = conn.callTimeout;
        return { rows: [], metaData: [] };
      });
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL", null, 5, 0);
      expect(timeoutAtExecute).toBe(1);
    });

    it("issues an ALTER SESSION SET CURRENT_SCHEMA when handle.schema is set", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "HR",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      const sqls = conn.execute.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => /ALTER SESSION SET CURRENT_SCHEMA = "HR"/.test(s))).toBe(
        true,
      );
    });

    it("escapes embedded double-quotes in schema name", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: 'WEIRD"NAME',
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      const sqls = conn.execute.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => /WEIRD""NAME/.test(s))).toBe(true);
    });

    it("does NOT issue ALTER SESSION when handle.schema is null", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      const sqls = conn.execute.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => /ALTER SESSION/.test(s))).toBe(false);
    });
  });

  // G-LIMIT-WRAP: wrap as a subquery with FETCH FIRST N ROWS ONLY.
  describe("executeReadAsync — G-LIMIT-WRAP", () => {
    function userSqlOf(conn: { execute: ReturnType<typeof vi.fn> }): string {
      const calls = conn.execute.mock.calls.map((c) => String(c[0]));
      const user = calls.find(
        (s) => !/^ALTER SESSION/.test(s) && s !== "ROLLBACK",
      );
      if (user === undefined)
        throw new Error(`no user query in: ${calls.join(" | ")}`);
      return user;
    }

    async function runWith(query: string, maxRows = 5): Promise<string> {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      await drv.executeReadAsync(handle, query, null, maxRows);
      return userSqlOf(conn);
    }

    it("wraps a simple SELECT with FETCH FIRST N+1 ROWS ONLY", async () => {
      const sql = await runWith("SELECT id FROM t");
      expect(sql).toBe("SELECT * FROM (SELECT id FROM t) FETCH FIRST 6 ROWS ONLY");
    });

    it("strips a trailing semicolon before wrapping", async () => {
      const sql = await runWith("SELECT id FROM t;");
      expect(sql).toBe("SELECT * FROM (SELECT id FROM t) FETCH FIRST 6 ROWS ONLY");
    });

    it("trims surrounding whitespace and strips trailing semicolon", async () => {
      const sql = await runWith("  SELECT id FROM t;   \n");
      // .trim() then .replace(/;\s*$/, "") — internal whitespace preserved.
      expect(sql).toBe("SELECT * FROM (SELECT id FROM t) FETCH FIRST 6 ROWS ONLY");
    });

    it("wraps a query that already has FETCH FIRST — outer still bounds", async () => {
      const sql = await runWith("SELECT id FROM t FETCH FIRST 100 ROWS ONLY");
      expect(sql).toBe(
        "SELECT * FROM (SELECT id FROM t FETCH FIRST 100 ROWS ONLY) FETCH FIRST 6 ROWS ONLY",
      );
    });
  });

  describe("executeReadAsync — error paths", () => {
    it("surfaces ORA-XXXXX from errorNum when present", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      const err = new Error("ORA-00942: table or view does not exist") as Error & {
        errorNum?: number;
      };
      err.errorNum = 942;
      let firstCall = true;
      conn.execute.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw err;
        }
        // Subsequent ROLLBACK call succeeds
        return { rows: [], metaData: [] };
      });
      const res = await drv.executeReadAsync(handle, "SELECT * FROM nope");
      expect(res.status).toBe("error");
      expect(res.error_code).toBe("ORA-942");
      expect(res.error).toMatch(/ORA-00942/);
    });

    it("falls back to 'SQL_ERROR' when errorNum is absent", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      let firstCall = true;
      conn.execute.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("kaboom");
        }
        return { rows: [], metaData: [] };
      });
      const res = await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      expect(res.status).toBe("error");
      expect(res.error_code).toBe("SQL_ERROR");
      expect(res.error).toBe("kaboom");
    });

    it("issues a best-effort ROLLBACK after a failure", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      let firstCall = true;
      conn.execute.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("boom");
        }
        return { rows: [], metaData: [] };
      });
      await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      const sqls = conn.execute.mock.calls.map((c) => String(c[0]));
      expect(sqls).toContain("ROLLBACK");
    });

    it("swallows a ROLLBACK failure (best-effort) without re-throwing", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => {
        throw new Error("everything broken");
      });
      const res = await drv.executeReadAsync(handle, "SELECT 1 FROM DUAL");
      // Both the user query AND the ROLLBACK throw — but executeReadAsync
      // must still return an error envelope.
      expect(res.status).toBe("error");
      expect(res.error_code).toBe("SQL_ERROR");
    });
  });

  describe("getSchemaAsync", () => {
    it("returns Table[] with columns + PK info; uppercases the supplied schema (G-ORA-OWNER)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM all_tables")) {
          return {
            rows: [{ TABLE_NAME: "USERS" }, { TABLE_NAME: "POSTS" }],
            metaData: [],
          };
        }
        if (sql.includes("FROM all_tab_columns")) {
          return {
            rows: [
              { TABLE_NAME: "USERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", DATA_DEFAULT: null, COLUMN_ID: 1 },
              { TABLE_NAME: "USERS", COLUMN_NAME: "EMAIL", DATA_TYPE: "VARCHAR2", NULLABLE: "Y", DATA_DEFAULT: "''", COLUMN_ID: 2 },
              { TABLE_NAME: "POSTS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", DATA_DEFAULT: null, COLUMN_ID: 1 },
            ],
            metaData: [],
          };
        }
        if (sql.includes("FROM all_constraints")) {
          return {
            rows: [
              { TABLE_NAME: "USERS", COLUMN_NAME: "ID" },
              { TABLE_NAME: "POSTS", COLUMN_NAME: "ID" },
            ],
            metaData: [],
          };
        }
        return { rows: [], metaData: [] };
      });
      const tables = await drv.getSchemaAsync(handle, "hr");
      expect(tables).toHaveLength(2);
      const users = tables.find((t) => t.name === "USERS")!;
      expect(users.schema).toBe("HR"); // uppercased
      expect(users.columns.map((c) => c.name)).toEqual(["ID", "EMAIL"]);
      expect(users.columns[0]!.is_primary_key).toBe(true);
      expect(users.columns[1]!.is_primary_key).toBe(false);
      expect(users.columns[0]!.nullable).toBe(false);
      expect(users.columns[1]!.nullable).toBe(true);
      expect(users.columns[1]!.default).toBe("''");
    });

    it("falls back to handle.schema (uppercased) when no schemaName argument is given", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S",
        user: "u", password: "p",
        schema: "App_User",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM all_tables"))
          return { rows: [], metaData: [] };
        return { rows: [], metaData: [] };
      });
      await drv.getSchemaAsync(handle);
      const tablesCall = conn.execute.mock.calls.find((c) =>
        String(c[0]).includes("FROM all_tables"),
      );
      // The owner parameter is bound positionally; second array element of execute() is the params.
      expect(tablesCall![1]).toEqual(["APP_USER"]);
    });

    it("queries SYS_CONTEXT CURRENT_SCHEMA when no schema is configured at all", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async (sql: string) => {
        if (sql.includes("SYS_CONTEXT")) {
          return { rows: [{ S: "session_owner" }], metaData: [{ name: "S" }] };
        }
        if (sql.includes("FROM all_tables")) return { rows: [], metaData: [] };
        return { rows: [], metaData: [] };
      });
      await drv.getSchemaAsync(handle);
      const tablesCall = conn.execute.mock.calls.find((c) =>
        String(c[0]).includes("FROM all_tables"),
      );
      expect(tablesCall![1]).toEqual(["SESSION_OWNER"]);
    });

    it("returns [] when SYS_CONTEXT response is empty (defensive coalesce path)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async (sql: string) => {
        if (sql.includes("SYS_CONTEXT")) return { rows: [], metaData: [] };
        if (sql.includes("FROM all_tables")) return { rows: [], metaData: [] };
        return { rows: [], metaData: [] };
      });
      const tables = await drv.getSchemaAsync(handle);
      expect(tables).toEqual([]);
    });

    it("escapes _ and % wildcards in tableFilter using ESCAPE '!'", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
        schema: "HR",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      await drv.getSchemaAsync(handle, "HR", "user_data%");
      const tablesCall = conn.execute.mock.calls.find((c) =>
        String(c[0]).includes("FROM all_tables"),
      );
      expect(String(tablesCall![0])).toContain("LIKE :2 ESCAPE '!'");
      expect(tablesCall![1]).toEqual(["HR", "USER!_DATA!%"]);
    });

    it("returns [] when no tables match", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
        schema: "HR",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      const tables = await drv.getSchemaAsync(handle, "HR");
      expect(tables).toEqual([]);
    });

    it("returns [] on any execution failure (catch swallows)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
        schema: "HR",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => {
        throw new Error("boom");
      });
      const tables = await drv.getSchemaAsync(handle, "HR");
      expect(tables).toEqual([]);
    });

    it("treats undefined DATA_DEFAULT as null on the Column", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
        schema: "HR",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM all_tables"))
          return { rows: [{ TABLE_NAME: "T" }], metaData: [] };
        if (sql.includes("FROM all_tab_columns"))
          return {
            rows: [
              { TABLE_NAME: "T", COLUMN_NAME: "X", DATA_TYPE: "NUMBER", NULLABLE: "Y" },
            ],
            metaData: [],
          };
        return { rows: [], metaData: [] };
      });
      const tables = await drv.getSchemaAsync(handle, "HR");
      expect(tables[0]!.columns[0]!.default).toBeNull();
    });

    it("getSchema (sync stub) returns []", () => {
      const drv = new OracleDriver();
      expect(drv.getSchema(null as unknown)).toEqual([]);
    });
  });

  describe("close / closeAsync / shutdown / healthCheck", () => {
    it("closeAsync releases the checked-out connection", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      await drv.closeAsync(handle);
      expect(conn.close).toHaveBeenCalled();
    });

    it("closeAsync swallows errors (best-effort)", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.close.mockImplementation(async () => {
        throw new Error("nope");
      });
      await expect(drv.closeAsync(handle)).resolves.toBeUndefined();
    });

    it("close (sync, fire-and-forget) eventually releases the connection", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      drv.close(handle);
      // Drain microtask queue so the .then() on the unwrapped promise fires.
      await new Promise((r) => setImmediate(r));
      expect(conn.close).toHaveBeenCalled();
    });

    it("close (sync) logs to stderr if release rejects", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.close.mockImplementation(async () => {
        throw new Error("release-err");
      });
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        drv.close(handle);
        await new Promise((r) => setImmediate(r));
        // Two microtask drains since the .then().catch() chain has two awaits.
        await new Promise((r) => setImmediate(r));
        expect(errSpy).toHaveBeenCalled();
        const msg = String(errSpy.mock.calls[0]?.[0]);
        expect(msg).toMatch(/release error.*release-err/);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("healthCheck returns true on a 1-row response", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({
        rows: [{ A: 1 }],
        metaData: [{ name: "A" }],
      }));
      expect(await drv.healthCheck(handle)).toBe(true);
    });

    it("healthCheck returns false when the query throws", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => {
        throw new Error("no");
      });
      expect(await drv.healthCheck(handle)).toBe(false);
    });

    it("healthCheck returns false when the row count is not 1", async () => {
      const drv = new OracleDriver();
      const handle = await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const conn = lastConn();
      conn.execute.mockImplementation(async () => ({ rows: [], metaData: [] }));
      expect(await drv.healthCheck(handle)).toBe(false);
    });

    it("shutdown() drains the pool exactly once and is idempotent", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      const pool = latestPool();
      await drv.shutdown();
      expect(pool.closeSpy).toHaveBeenCalledTimes(1);
      // Calling again after shutdown is a no-op (the pool ref is cleared).
      await drv.shutdown();
      expect(pool.closeSpy).toHaveBeenCalledTimes(1);
    });

    it("shutdown swallows pool.close() errors", async () => {
      const drv = new OracleDriver();
      await drv.connect({
        host: "h", port: 1521, service_name: "S", user: "u", password: "p",
      });
      latestPool().closeSpy.mockImplementation(() => Promise.reject(new Error("drain-err")));
      await expect(drv.shutdown()).resolves.toBeUndefined();
    });

    it("shutdown is a no-op when no pool was created", async () => {
      const drv = new OracleDriver();
      await expect(drv.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("classifyOperation", () => {
    it("delegates to the SQL keyword classifier (read for SELECT)", () => {
      const drv = new OracleDriver();
      expect(drv.classifyOperation("SELECT 1 FROM DUAL")).toBe("read");
    });

    it("classifies INSERT as write", () => {
      const drv = new OracleDriver();
      expect(drv.classifyOperation("INSERT INTO t VALUES (1)")).toBe("write");
    });

    it("classifies DROP TABLE as admin", () => {
      const drv = new OracleDriver();
      expect(drv.classifyOperation("DROP TABLE users")).toBe("admin");
    });
  });
});

// ---------------------------------------------------------------------------
// _loadOracle dynamic-import branches (cover the if/else module-shape unwrap
// and the install-failure helpful-error path).
// ---------------------------------------------------------------------------
describe("OracleDriver._loadOracle module-shape branches", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("oracledb");
  });

  it("accepts a namespace-shaped module (createPool on the module itself)", async () => {
    vi.resetModules();
    const localCreatePool = vi.fn(async () => ({
      getConnection: async () => ({
        execute: async () => ({ rows: [], metaData: [] }),
        close: async () => undefined,
        callTimeout: 0,
      }),
      close: async () => undefined,
    }));
    vi.doMock("oracledb", () => ({
      createPool: localCreatePool,
      OUT_FORMAT_OBJECT: 4001,
      DB_TYPE_CLOB: 2017,
      outFormat: 4002,
      fetchAsString: [],
    }));
    const { OracleDriver: Fresh } = await import("../../../../src/connectors/db/lib/drivers/oracle.js");
    const drv = new Fresh();
    await drv.connect({
      host: "h", port: 1521, service_name: "S", user: "u", password: "p",
    });
    expect(localCreatePool).toHaveBeenCalledTimes(1);
  });

  it("raises a helpful error when 'oracledb' cannot be loaded at all", async () => {
    vi.resetModules();
    vi.doMock("oracledb", () => {
      throw new Error("Cannot find module 'oracledb'");
    });
    const { OracleDriver: Fresh } = await import("../../../../src/connectors/db/lib/drivers/oracle.js");
    const drv = new Fresh();
    await expect(
      drv.connect({ host: "h", port: 1521, service_name: "S", user: "u", password: "p" }),
    ).rejects.toThrow(/requires 'oracledb'/);
  });
});
