/**
 * Live-integration tests for OracleDriver and the CLI policy gate.
 *
 * Skipped unless `TEST_LIVE_ORACLE` is set. Expects an Oracle container
 * from `fixtures/docker-compose.yml`:
 *   docker compose -f tests/drivers/fixtures/docker-compose.yml up -d --wait oracle
 *   TEST_LIVE_ORACLE=1 npx vitest run tests/drivers/live_oracle.test.ts
 *
 * No mocks — the real `oracledb` package must be installed (optionalDependencies).
 * Defaults target gvenzl/oracle-free (FREEPDB1 service, system user).
 *
 * Oracle quirk — unquoted identifiers are folded to UPPERCASE. Asserts use
 * `USERS`, `ID`, `NAME`, `EMAIL` where PG would use the lowercase names.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import oracledb from "oracledb";

import { OracleDriver } from "../../../../src/connectors/db/lib/drivers/oracle.js";
import { argsFor, cleanupTmpPath, runCli, writeTempConfig } from "../fixtures.js";

const HOST = process.env["TEST_ORA_HOST"] ?? "localhost";
const PORT = Number(process.env["TEST_ORA_PORT"] ?? 1521);
const SERVICE = process.env["TEST_ORA_SERVICE"] ?? "FREEPDB1";
const USER = process.env["TEST_ORA_USER"] ?? "system";
const PASSWORD = process.env["TEST_ORA_PASSWORD"] ?? "oracle";

const CONNECT_STRING = `${HOST}:${PORT}/${SERVICE}`;
const RAW_CONNECT = { user: USER, password: PASSWORD, connectString: CONNECT_STRING };
const ENV_CONFIG = {
  driver: "oracle",
  host: HOST,
  port: PORT,
  service_name: SERVICE,
  user: USER,
  password: PASSWORD,
};
const ENV_NAME = "live_oracle";

// ORA-00942 = "table or view does not exist"; swallow it so teardown is idempotent.
const DROP_USERS_IDEMPOTENT =
  "BEGIN EXECUTE IMMEDIATE 'DROP TABLE users CASCADE CONSTRAINTS'; " +
  "EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;";

describe.runIf(process.env["TEST_LIVE_ORACLE"] !== undefined)(
  "wiki_db.drivers.oracle (live)",
  () => {
    const drv = new OracleDriver();
    let handle: unknown;
    let cfgPath: string;

    beforeAll(async () => {
      // Seed via a raw oracledb connection — the driver has no public write
      // surface. Manual commit (oracledb default is not auto-commit).
      const conn = await oracledb.getConnection(RAW_CONNECT);
      try {
        await conn.execute(DROP_USERS_IDEMPOTENT);
        await conn.execute(
          "CREATE TABLE users (id NUMBER PRIMARY KEY, name VARCHAR2(255) NOT NULL, email VARCHAR2(255))",
        );
        await conn.execute(
          "INSERT ALL " +
            "INTO users (id, name, email) VALUES (1, 'Alice', 'a@x.com') " +
            "INTO users (id, name, email) VALUES (2, 'Bob',   'b@x.com') " +
            "INTO users (id, name, email) VALUES (3, 'Carol', 'c@x.com') " +
            "SELECT * FROM DUAL",
        );
        await conn.commit();
      } finally {
        await conn.close();
      }
      handle = await drv.connect(ENV_CONFIG);
      cfgPath = writeTempConfig({
        [ENV_NAME]: ENV_CONFIG,
      });
    }, 60_000);

    afterAll(async () => {
      try {
        const conn = await oracledb.getConnection(RAW_CONNECT);
        await conn.execute(DROP_USERS_IDEMPOTENT);
        await conn.commit();
        await conn.close();
      } catch {
        // best-effort
      }
      if (handle !== undefined) await drv.closeAsync(handle);
      if (cfgPath !== undefined) cleanupTmpPath(path.dirname(cfgPath));
      await drv.shutdown();
    });

    it("executeReadAsync returns 3 seeded rows", async () => {
      const res = await drv.executeReadAsync(
        handle,
        "SELECT id, name, email FROM users WHERE id > 0 ORDER BY id FETCH FIRST 10 ROWS ONLY",
      );
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(3);
      expect(res.columns).toEqual(["ID", "NAME", "EMAIL"]);
      expect(res.rows![0]!["NAME"]).toBe("Alice");
    });

    it("getSchemaAsync reports the USERS table with expected columns", async () => {
      const tables = await drv.getSchemaAsync(handle);
      const users = tables.find((t) => t.name === "USERS");
      expect(users).toBeDefined();
      const colNames = users!.columns.map((c) => c.name).sort();
      expect(colNames).toEqual(["EMAIL", "ID", "NAME"]);
    });

    it("CLI: bounded SELECT returns status=success with 3 rows", () => {
      const res = runCli(
        argsFor("query", {
          env: ENV_NAME,
          config_path: cfgPath,
          sql: "SELECT id, name FROM users WHERE id > 0 ORDER BY id FETCH FIRST 10 ROWS ONLY",
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
      expect(Number(check.rows![0]!["C"])).toBe(3);
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
      expect(Number(check.rows![0]!["C"])).toBe(3);
    });
  },
);
