/**
 * drivers/sqlite.ts — SQLite driver, used for fast unit tests and
 * local/embedded databases.
 *
 * Mirrors `drivers/sqlite.py`. The Python implementation uses stdlib
 * `sqlite3`; here we use `better-sqlite3` because it provides a synchronous
 * API that matches Python's ergonomics (no Promise wrapping needed for
 * single-shot queries inside the policy/query pipeline).
 *
 * Behaviour parity:
 *  - `connect({database})` opens the path; `:memory:` is an in-memory DB.
 *  - `executeRead` fetches `max_rows + 1` rows so we can detect truncation
 *    without reading the whole result set.
 *  - On error: returns `{status: "error", error_code: "SQL_ERROR", error,
 *    execution_time_ms}` — never raises.
 *  - `getSchema(conn, schema?, tableFilter?)` reads `sqlite_master` and
 *    `PRAGMA table_info(<name>)`, mirroring Python's queries verbatim.
 */
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {
  Column,
  DatabaseDriver,
  Table,
  type ExecuteReadResult,
} from "./base.js";
import { classifySqlKeywords, type OperationType } from "../policy.js";

export class SQLiteDriver extends DatabaseDriver {
  override connect(envConfig: Record<string, unknown>): Database.Database {
    const dbPath =
      typeof envConfig["database"] === "string"
        ? (envConfig["database"] as string)
        : ":memory:";
    return new Database(dbPath);
  }

  override executeRead(
    conn: unknown,
    query: string,
    params: unknown[] | null = null,
    maxRows: number = 1000,
    _timeoutMs: number = 30000,
  ): ExecuteReadResult {
    const db = conn as Database.Database;
    const start = performance.now();
    try {
      const stmt = db.prepare(query);
      // better-sqlite3 exposes `stmt.reader` as `true` for row-returning
      // statements (SELECT / PRAGMA / EXPLAIN) and `false` for writes
      // (INSERT/UPDATE/DELETE). `.iterate()` only works for readers; writes
      // must go through `.run()`. When the plugin config opts into
      // `write: allow` or `delete: allow`, the policy gate routes the
      // statement through this method — so dispatch on `stmt.reader`.
      if (stmt.reader === false) {
        stmt.run(...((params ?? []) as unknown[]));
        const elapsed = performance.now() - start;
        return {
          status: "success",
          rows: [],
          row_count: 0,
          columns: [],
          execution_time_ms: roundTo2(elapsed),
          truncated: false,
        };
      }
      const iter = stmt.iterate(
        ...((params ?? []) as unknown[]),
      ) as IterableIterator<Record<string, unknown>>;
      const rowsRaw: Record<string, unknown>[] = [];
      // Fetch one extra row to detect truncation.
      let truncated = false;
      for (const row of iter) {
        if (rowsRaw.length >= maxRows) {
          truncated = true;
          // We need to break the iterator cleanly so SQLite can release
          // its statement state. better-sqlite3's iterate() honours
          // `return()` to close the underlying stmt.
          if (typeof iter.return === "function") iter.return();
          break;
        }
        rowsRaw.push(row);
      }
      // Columns: `stmt.columns()` returns ColumnDefinition[] with `name`.
      let columns: string[] = [];
      try {
        columns = stmt.columns().map((c) => c.name);
      } catch {
        // Non-SELECT statements have no columns; mirror Python's
        // `cursor.description` being None.
        columns = [];
      }
      const elapsed = performance.now() - start;
      return {
        status: "success",
        rows: rowsRaw,
        row_count: rowsRaw.length,
        columns,
        execution_time_ms: roundTo2(elapsed),
        truncated,
      };
    } catch (e) {
      const elapsed = performance.now() - start;
      return {
        status: "error",
        error_code: "SQL_ERROR",
        error: (e as Error).message,
        execution_time_ms: roundTo2(elapsed),
      };
    }
  }

  override getSchema(
    conn: unknown,
    schemaName: string = "",
    tableFilter: string | null = null,
  ): Table[] {
    const db = conn as Database.Database;
    try {
      let cursor;
      let baseQuery =
        "SELECT m.name AS table_name, p.name AS col_name, p.type, p.[notnull], p.dflt_value, p.pk " +
        "FROM sqlite_master m " +
        "JOIN pragma_table_info(m.name) p " +
        "WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'";

      if (tableFilter !== null && tableFilter !== undefined) {
        baseQuery += " AND m.name LIKE ?";
        cursor = db.prepare(baseQuery).all(tableFilter) as Array<{
          table_name: string;
          col_name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
      } else {
        cursor = db.prepare(baseQuery).all() as Array<{
          table_name: string;
          col_name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
      }

      // G-SCHEMA-BATCH: Avoid N+1 query problem by using the pragma_table_info
      // table-valued function to fetch column metadata for all tables in a single query.
      const colsByTable = new Map<string, Column[]>();
      const tableNames = new Set<string>();

      for (const row of cursor) {
        const tableName = row.table_name;
        tableNames.add(tableName);

        let list = colsByTable.get(tableName);
        if (list === undefined) {
          list = [];
          colsByTable.set(tableName, list);
        }

        list.push(
          new Column({
            name: row.col_name,
            data_type: row.type,
            nullable: !row.notnull,
            is_primary_key: Boolean(row.pk),
            default: row.dflt_value,
          }),
        );
      }

      const tables: Table[] = [];
      for (const tableName of tableNames) {
        tables.push(
          new Table({
            name: tableName,
            schema: schemaName,
            columns: colsByTable.get(tableName) ?? [],
          }),
        );
      }
      return tables;
    } catch {
      return [];
    }
  }

  override close(conn: unknown): void {
    (conn as Database.Database).close();
  }

  override classifyOperation(query: string): OperationType {
    return classifySqlKeywords(query);
  }
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
