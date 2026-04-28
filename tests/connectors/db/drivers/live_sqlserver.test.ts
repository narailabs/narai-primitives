/**
 * Live-integration tests for SqlServerDriver and the CLI policy gate.
 *
 * Skipped unless `TEST_LIVE_MSSQL` is set. Expects an mssql container from
 * `fixtures/docker-compose.yml`:
 *   docker compose -f tests/drivers/fixtures/docker-compose.yml up -d --wait sqlserver
 *   TEST_LIVE_MSSQL=1 npx vitest run tests/drivers/live_sqlserver.test.ts
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import mssql from "mssql";

import { SqlServerDriver } from "../../../../src/connectors/db/lib/drivers/sqlserver.js";
import { argsFor, cleanupTmpPath, runCli, writeTempConfig } from "../fixtures.js";

const CONNECT = {
  host: process.env["TEST_MSSQL_HOST"] ?? "localhost",
  port: Number(process.env["TEST_MSSQL_PORT"] ?? 1433),
  database: process.env["TEST_MSSQL_DB"] ?? "master",
  user: process.env["TEST_MSSQL_USER"] ?? "sa",
  password: process.env["TEST_MSSQL_PASSWORD"] ?? "YourStrong@Pass1",
};
const ENV_NAME = "live_mssql";

const RAW_POOL_CONFIG = {
  server: CONNECT.host,
  port: CONNECT.port,
  database: CONNECT.database,
  user: CONNECT.user,
  password: CONNECT.password,
  options: { encrypt: false, trustServerCertificate: true },
};

describe.runIf(process.env["TEST_LIVE_MSSQL"] !== undefined)(
  "wiki_db.drivers.sqlserver (live)",
  () => {
    const drv = new SqlServerDriver();
    let handle: unknown;
    let cfgPath: string;

    beforeAll(async () => {
      // SQL Server can accept TCP before it accepts logins, so retry the
      // initial connect with a few seconds of backoff. 20 attempts × 3s ≈ 1 min.
      let pool: mssql.ConnectionPool | null = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 20; i++) {
        try {
          pool = new mssql.ConnectionPool(RAW_POOL_CONFIG);
          await pool.connect();
          break;
        } catch (e) {
          lastErr = e;
          try { await pool?.close(); } catch { /* ignore */ }
          pool = null;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (pool === null) throw lastErr;
      try {
        await pool
          .request()
          .query("IF OBJECT_ID('users', 'U') IS NOT NULL DROP TABLE users");
        await pool
          .request()
          .query(
            "CREATE TABLE users (id INT PRIMARY KEY, name NVARCHAR(255) NOT NULL, email NVARCHAR(255))",
          );
        await pool
          .request()
          .query(
            "INSERT INTO users (id, name, email) VALUES (1,'Alice','a@x.com'),(2,'Bob','b@x.com'),(3,'Carol','c@x.com')",
          );
      } finally {
        await pool.close();
      }
      handle = await drv.connect(CONNECT);
      cfgPath = writeTempConfig({
        [ENV_NAME]: { driver: "sqlserver", ...CONNECT },
      });
    }, 120_000);

    afterAll(async () => {
      try {
        const pool = new mssql.ConnectionPool(RAW_POOL_CONFIG);
        await pool.connect();
        await pool
          .request()
          .query("IF OBJECT_ID('users', 'U') IS NOT NULL DROP TABLE users");
        await pool.close();
      } catch {
        // best-effort
      }
      if (handle !== undefined) await drv.shutdown();
      if (cfgPath !== undefined) cleanupTmpPath(path.dirname(cfgPath));
    });

    it("executeReadAsync returns 3 seeded rows", async () => {
      const res = await drv.executeReadAsync(
        handle,
        "SELECT id, name, email FROM users WHERE id > 0 ORDER BY id",
      );
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(3);
      expect(res.columns).toEqual(["id", "name", "email"]);
      expect(res.rows![0]!["name"]).toBe("Alice");
    });

    it("getSchemaAsync reports the users table with expected columns", async () => {
      const tables = await drv.getSchemaAsync(handle);
      const users = tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      const colNames = users!.columns.map((c) => c.name).sort();
      expect(colNames).toEqual(["email", "id", "name"]);
    });

    it("CLI: bounded SELECT returns status=success with 3 rows", () => {
      const res = runCli(
        argsFor("query", {
          env: ENV_NAME,
          config_path: cfgPath,
          sql: "SELECT id, name FROM users WHERE id > 0 ORDER BY id",
        }),
      );
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe("success");
      expect(out.data.row_count).toBe(3);
    });

    it("CLI: DDL (DROP=admin) returns present_only by default and the table is untouched", async () => {
      const res = runCli(
        argsFor("query", {
          env: ENV_NAME,
          config_path: cfgPath,
          sql: "DROP TABLE users",
        }),
      );
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe("present_only");

      const check = await drv.executeReadAsync(
        handle,
        "SELECT COUNT(*) AS c FROM users WHERE id > 0",
      );
      expect(check.status).toBe("success");
      expect(Number(check.rows![0]!["c"])).toBe(3);
    });

    it("CLI: WRITE (INSERT) escalates by default and does not mutate data", async () => {
      const res = runCli(
        argsFor("query", {
          env: ENV_NAME,
          config_path: cfgPath,
          sql: "INSERT INTO users (id, name, email) VALUES (99, 'Dan', 'd@x.com')",
        }),
      );
      expect(res.status).toBe(1);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe("escalate");

      const check = await drv.executeReadAsync(
        handle,
        "SELECT COUNT(*) AS c FROM users WHERE id > 0",
      );
      expect(Number(check.rows![0]!["c"])).toBe(3);
    });
  },
);
