/**
 * Live-integration tests for PostgresDriver and the CLI policy gate.
 *
 * Skipped unless `TEST_LIVE_PG` is set. Expects a Postgres container from
 * `fixtures/docker-compose.yml`:
 *   docker compose -f tests/drivers/fixtures/docker-compose.yml up -d --wait postgres
 *   TEST_LIVE_PG=1 npx vitest run tests/drivers/live_postgresql.test.ts
 *
 * No mocks — the real `pg` package must be installed (optionalDependencies).
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pg from "pg";

import { PostgresDriver } from "../../../../src/connectors/db/lib/drivers/postgresql.js";
import { argsFor, cleanupTmpPath, runCli, writeTempConfig } from "../fixtures.js";

const CONNECT = {
  host: process.env["TEST_PG_HOST"] ?? "localhost",
  port: Number(process.env["TEST_PG_PORT"] ?? 5433),
  database: process.env["TEST_PG_DB"] ?? "postgres",
  user: process.env["TEST_PG_USER"] ?? "postgres",
  password: process.env["TEST_PG_PASSWORD"] ?? "postgres",
};
const ENV_NAME = "live_pg";

describe.runIf(process.env["TEST_LIVE_PG"] !== undefined)(
  "wiki_db.drivers.postgresql (live)",
  () => {
    const drv = new PostgresDriver();
    let handle: unknown;
    let cfgPath: string;

    beforeAll(async () => {
      // Seed via a raw pg.Client — the driver has no public write surface.
      const client = new pg.Client(CONNECT);
      await client.connect();
      try {
        await client.query("DROP TABLE IF EXISTS users CASCADE");
        await client.query(
          "CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, email TEXT)",
        );
        await client.query(
          "INSERT INTO users (id, name, email) VALUES (1,'Alice','a@x.com'),(2,'Bob','b@x.com'),(3,'Carol','c@x.com')",
        );
      } finally {
        await client.end();
      }
      handle = await drv.connect(CONNECT);
      cfgPath = writeTempConfig({
        [ENV_NAME]: { driver: "postgresql", ...CONNECT },
      });
    }, 30_000);

    afterAll(async () => {
      try {
        const client = new pg.Client(CONNECT);
        await client.connect();
        await client.query("DROP TABLE IF EXISTS users CASCADE");
        await client.end();
      } catch {
        // best-effort
      }
      if (handle !== undefined) await drv.closeAsync(handle);
      if (cfgPath !== undefined) cleanupTmpPath(path.dirname(cfgPath));
    });

    it("executeReadAsync returns 3 seeded rows", async () => {
      const res = await drv.executeReadAsync(
        handle,
        "SELECT id, name, email FROM users WHERE id > 0 ORDER BY id LIMIT 10",
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
          sql: "SELECT id, name FROM users WHERE id > 0 ORDER BY id LIMIT 10",
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
        "SELECT COUNT(*)::int AS c FROM users WHERE id > 0",
      );
      expect(check.status).toBe("success");
      expect(check.rows![0]!["c"]).toBe(3);
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
        "SELECT COUNT(*)::int AS c FROM users WHERE id > 0",
      );
      expect(check.rows![0]!["c"]).toBe(3);
    });
  },
);
