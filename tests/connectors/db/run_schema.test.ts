/**
 * Regression test: dispatcher.runSchema must call driver.getSchemaAsync
 * when present.
 *
 * Phase E drivers (pg, mysql, mssql, oracle, mongo, dynamo) intentionally
 * stub the sync `getSchema` to return `[]` and put their real
 * `information_schema` query logic in `getSchemaAsync`. The dispatcher's
 * `runSchema` originally called the sync stub directly, so a
 * `gather()` "show me the tables" against postgres always returned
 * `table_count: 0` despite a successful connection — silent failure
 * surfaced by doc-wiki's eval-20.
 *
 * This test pins the contract: when a driver exposes `getSchemaAsync`,
 * runSchema must use it; sync `getSchema` is the fallback only when no
 * async hook exists (sqlite path).
 */
import { describe, expect, it } from "vitest";
import { runSchema } from "../../../src/connectors/db/dispatcher.js";
import {
  Column,
  DatabaseDriver,
  Table,
  type ExecuteReadResult,
} from "../../../src/connectors/db/lib/drivers/base.js";
import { OperationType } from "../../../src/connectors/db/lib/policy.js";

/** Driver that exposes both the sync stub (returns []) and the async
 *  hook (returns a real table). Mirrors the Phase E driver shape. */
class StubAsyncDriver extends DatabaseDriver {
  syncCalls = 0;
  asyncCalls = 0;
  connect(): unknown {
    return {};
  }
  executeRead(): ExecuteReadResult {
    return { columns: [], rows: [], row_count: 0, execution_time_ms: 0 };
  }
  override getSchema(
    _conn: unknown,
    _schemaName?: string,
    _tableFilter?: string | null,
  ): Table[] {
    this.syncCalls += 1;
    return []; // stub — same as the real Phase E drivers
  }
  async getSchemaAsync(
    _conn: unknown,
    _schemaName?: string,
    _tableFilter?: string | null,
  ): Promise<Table[]> {
    this.asyncCalls += 1;
    return [
      new Table({
        name: "users",
        schema: "public",
        columns: [
          new Column({ name: "id", data_type: "integer", nullable: false, is_primary_key: true }),
          new Column({ name: "email", data_type: "text", nullable: false }),
        ],
      }),
    ];
  }
  close(): void {
    /* no-op */
  }
  classifyOperation(): OperationType {
    return OperationType.READ;
  }
}

/** Sync-only driver (sqlite shape) — no getSchemaAsync method. */
class StubSyncDriver extends DatabaseDriver {
  syncCalls = 0;
  connect(): unknown {
    return {};
  }
  executeRead(): ExecuteReadResult {
    return { columns: [], rows: [], row_count: 0, execution_time_ms: 0 };
  }
  override getSchema(
    _conn: unknown,
    _schemaName?: string,
    _tableFilter?: string | null,
  ): Table[] {
    this.syncCalls += 1;
    return [
      new Table({
        name: "legacy_table",
        schema: "main",
        columns: [
          new Column({ name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true }),
        ],
      }),
    ];
  }
  close(): void {
    /* no-op */
  }
  classifyOperation(): OperationType {
    return OperationType.READ;
  }
}

describe("runSchema (dispatcher)", () => {
  it("prefers getSchemaAsync when the driver exposes it", async () => {
    const driver = new StubAsyncDriver();
    const result = await runSchema(driver, {}, null, "test-env");
    expect(driver.asyncCalls).toBe(1);
    expect(driver.syncCalls).toBe(0);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.table_count).toBe(1);
      expect(result.tables[0]?.name).toBe("users");
    }
  });

  it("falls back to sync getSchema when getSchemaAsync is absent", async () => {
    const driver = new StubSyncDriver();
    const result = await runSchema(driver, {}, null, "sqlite-env");
    expect(driver.syncCalls).toBe(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.table_count).toBe(1);
      expect(result.tables[0]?.name).toBe("legacy_table");
    }
  });

  it("never calls the sync stub when async hook is present (the bug)", async () => {
    // Direct regression check: prior to the fix, runSchema would call
    // the sync stub which returns [] and emit table_count: 0 even when
    // the async path could have produced rows. If a future refactor
    // accidentally removes the async detection, this test catches it.
    const driver = new StubAsyncDriver();
    const result = await runSchema(driver, {}, null);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.table_count).toBeGreaterThan(0);
    }
  });

  it("propagates structured error envelope on async failure", async () => {
    class FailingAsync extends StubAsyncDriver {
      override async getSchemaAsync(): Promise<Table[]> {
        throw new Error("boom");
      }
    }
    const driver = new FailingAsync();
    const result = await runSchema(driver, {}, null, "fail-env");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error_code).toBe("SCHEMA_ERROR");
      expect(result.error).toContain("boom");
    }
  });
});
