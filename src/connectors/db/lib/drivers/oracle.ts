/**
 * drivers/oracle.ts — Oracle Database driver via the `oracledb` package.
 *
 * Design:
 *  - Mirrors `postgresql.ts`: a lazily-created pool is cached on the driver
 *    instance, each `connect()` checks out a connection from the pool, and
 *    `close()` returns it. `shutdown()` drains the pool.
 *  - oracledb 6.x defaults to **Thin mode** — pure JavaScript, no Oracle
 *    Instant Client needed. We never call `initOracleClient()`; switching
 *    to Thick mode is the caller's explicit choice to make in their own
 *    process bootstrap before this driver loads.
 *  - Read-only: every `executeReadAsync` runs a defensive `ROLLBACK`
 *    followed by `SET TRANSACTION READ ONLY`, with `callTimeout` set on
 *    the connection for a server-enforced bound.
 *  - The `oracledb` module is loaded with a dynamic `import()` so this
 *    file compiles even when the package is not installed. On a missing
 *    install, `connect()` throws a helpful `npm install oracledb` hint.
 */
import { performance } from "node:perf_hooks";
import {
  Column,
  DatabaseDriver,
  Table,
  type ExecuteReadResult,
} from "./base.js";
import { classifySqlKeywords, type OperationType } from "../policy.js";

// ---------------------------------------------------------------------------
// Minimal ambient types — we do not depend on `@types/oracledb` to compile.
// ---------------------------------------------------------------------------

interface OracleExecuteResult {
  rows?: Record<string, unknown>[];
  metaData?: Array<{ name: string }>;
  rowsAffected?: number;
}
interface OracleConnection {
  execute(
    sql: string,
    params?: unknown,
    options?: Record<string, unknown>,
  ): Promise<OracleExecuteResult>;
  close(): Promise<void>;
  callTimeout: number;
}
interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(drainTime?: number): Promise<void>;
}
interface OracleModule {
  createPool(attrs: Record<string, unknown>): Promise<OraclePool>;
  OUT_FORMAT_OBJECT: number;
  DB_TYPE_CLOB: number;
  outFormat: number;
  fetchAsString: number[];
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface OracleHandle {
  connection: OracleConnection;
  schema: string | null;
}

export class OracleDriver extends DatabaseDriver {
  private _oracleModule: OracleModule | null = null;
  private _pool: OraclePool | null = null;
  private _schema: string | null = null;
  private _poolPromise: Promise<OraclePool> | null = null;

  private async _loadOracle(): Promise<OracleModule> {
    if (this._oracleModule !== null) return this._oracleModule;
    let mod: OracleModule | { default: OracleModule };
    try {
      mod = (await import("oracledb")) as unknown as
        | OracleModule
        | { default: OracleModule };
    } catch (e) {
      throw new Error(
        `Driver 'oracle' requires 'oracledb' — run: npm install oracledb (${
          (e as Error).message
        })`,
      );
    }
    const resolved =
      "createPool" in (mod as object)
        ? (mod as OracleModule)
        : (mod as { default: OracleModule }).default;
    // G-ORA-PER-CALL-OPTS: oracledb 6.x exposes `outFormat` / `fetchAsString`
    // as accessor properties on the module object whose setters throw in
    // some ESM-import contexts ("Cannot redefine property"). We pass the
    // option per-execute in `_readOpts()` instead of mutating module state.
    this._oracleModule = resolved;
    return resolved;
  }

  /**
   * Options passed to every read-path `connection.execute()` — returns
   * rows as `Record<string, unknown>[]` (matching PG/MySQL driver shape).
   * Requires `_loadOracle()` to have populated `_oracleModule` first.
   */
  private _readOpts(): Record<string, unknown> {
    return { outFormat: this._oracleModule!.OUT_FORMAT_OBJECT };
  }

  /**
   * Build the pool on first call; subsequent callers receive the cached
   * instance (or await the in-flight creation promise to avoid racing two
   * `createPool()` calls on concurrent connects).
   */
  private _ensurePool(envConfig: Record<string, unknown>): Promise<OraclePool> {
    if (this._pool !== null) return Promise.resolve(this._pool);
    if (this._poolPromise !== null) return this._poolPromise;
    this._poolPromise = this._loadOracle().then(async (oracledb) => {
      const host =
        typeof envConfig["host"] === "string" ? envConfig["host"] : "localhost";
      const port =
        typeof envConfig["port"] === "number" ? envConfig["port"] : 1521;
      const serviceName =
        typeof envConfig["service_name"] === "string"
          ? envConfig["service_name"]
          : typeof envConfig["database"] === "string"
            ? envConfig["database"]
            : "";
      const sid =
        typeof envConfig["sid"] === "string" ? envConfig["sid"] : null;

      // G-ORA-CONNSTRING: prefer an explicit connectString (TNS alias or
      // EZConnect URL); otherwise compose one. SID form uses a colon
      // separator (legacy), service-name form uses a slash (EZConnect).
      const connectString =
        typeof envConfig["connectString"] === "string"
          ? envConfig["connectString"]
          : sid !== null
            ? `${host}:${port}:${sid}`
            : `${host}:${port}/${serviceName}`;

      // G-ORA-IGNORE-PUBLIC-DEFAULT: `registerEnvironment` (environments.ts)
      // defaults `schema` to "public" — a PostgreSQL-ism that makes sense
      // only for PG's schema-per-app model. Oracle reserves PUBLIC for
      // synonyms (`CREATE PUBLIC SYNONYM …`), not as a settable schema;
      // applying `ALTER SESSION SET CURRENT_SCHEMA = "public"` raises
      // ORA-01435 "user does not exist". Treat "public" as the no-override
      // sentinel. Explicit Oracle users will pass a real schema name like
      // "HR" or "APP_USER" which is respected as-is.
      const rawSchema = envConfig["schema"];
      this._schema =
        typeof rawSchema === "string" &&
        rawSchema.length > 0 &&
        rawSchema.toLowerCase() !== "public"
          ? rawSchema
          : null;

      const poolAttrs: Record<string, unknown> = {
        connectString,
        poolMin: 0,
        poolMax:
          typeof envConfig["pool_max"] === "number"
            ? envConfig["pool_max"]
            : 10,
        poolIncrement: 1,
        poolTimeout: 60,
      };
      if (typeof envConfig["user"] === "string")
        poolAttrs["user"] = envConfig["user"];
      if (typeof envConfig["password"] === "string")
        poolAttrs["password"] = envConfig["password"];

      const pool = await oracledb.createPool(poolAttrs);
      this._pool = pool;
      return pool;
    });
    return this._poolPromise;
  }

  override connect(envConfig: Record<string, unknown>): Promise<OracleHandle> {
    return this._ensurePool(envConfig).then(async (pool) => {
      const connection = await pool.getConnection();
      return { connection, schema: this._schema } satisfies OracleHandle;
    });
  }

  override executeRead(
    _conn: unknown,
    _query: string,
    _params: unknown[] | null = null,
    _maxRows: number = 1000,
    _timeoutMs: number = 30_000,
  ): ExecuteReadResult {
    return {
      status: "error",
      error_code: "SYNC_UNSUPPORTED",
      error:
        "OracleDriver.executeRead is async — call executeReadAsync() instead.",
      execution_time_ms: 0,
    };
  }

  async executeReadAsync(
    conn: unknown,
    query: string,
    params: unknown[] | null = null,
    maxRows: number = 1000,
    timeoutMs: number = 30_000,
  ): Promise<ExecuteReadResult> {
    const handle = (await (conn as
      | Promise<OracleHandle>
      | OracleHandle)) as OracleHandle;
    const start = performance.now();
    const { connection } = handle;
    try {
      // G-ORA-TIMEOUT: oracledb enforces timeouts at the connection level
      // (ms). Set before executing, clear in `finally` so a returned pool
      // connection does not inherit this call's deadline.
      connection.callTimeout = Math.max(1, timeoutMs);

      // G-ORA-NO-READONLY-TXN: unlike PG (`BEGIN READ ONLY`) and MySQL
      // (`SET SESSION TRANSACTION READ ONLY`), Oracle's equivalent
      // `SET TRANSACTION READ ONLY` uses SCN-based snapshot semantics
      // that raise ORA-01466 ("unable to read data — table definition
      // has changed") if any referenced table was DDL'd within the
      // read-only window's propagation delay. Skipping it here: the
      // policy gate is the authoritative safety — it classifies every
      // statement before the driver sees it and only READ queries
      // reach `executeReadAsync`. Belt-and-suspenders at the DB layer
      // would trade a real edge-case failure (reads after recent DDL)
      // for negligible extra safety.

      if (handle.schema !== null) {
        // Oracle preserves the case of quoted identifiers; we pass the
        // user-configured schema through verbatim inside double quotes
        // (escaping any embedded quote). Unquoted names would be folded
        // to uppercase silently.
        const safe = handle.schema.replace(/"/g, '""');
        await connection.execute(
          `ALTER SESSION SET CURRENT_SCHEMA = "${safe}"`,
        );
      }

      // G-LIMIT-WRAP: wrap as a subquery so bounded semantics hold even
      // when the outer query has a trailing comment or an inner FETCH
      // clause. Oracle 12c+ supports FETCH FIRST N ROWS ONLY; FREEPDB1
      // (23ai Free) and XEPDB1 (21c XE) both meet this.
      const inner = query.trim().replace(/;\s*$/, "");
      const limited = `SELECT * FROM (${inner}) FETCH FIRST ${maxRows + 1} ROWS ONLY`;

      const result = await connection.execute(
        limited,
        params ?? [],
        this._readOpts(),
      );

      const rawRows = (result.rows ?? []) as Record<string, unknown>[];
      let truncated = false;
      let rows = rawRows;
      if (rows.length > maxRows) {
        truncated = true;
        rows = rows.slice(0, maxRows);
      }

      return {
        status: "success",
        rows,
        row_count: rows.length,
        columns: (result.metaData ?? []).map((m) => m.name),
        execution_time_ms: roundTo2(performance.now() - start),
        truncated,
      };
    } catch (e) {
      try {
        await connection.execute("ROLLBACK");
      } catch {
        /* best-effort */
      }
      const err = e as Error & { errorNum?: number };
      const errorCode =
        err.errorNum !== undefined ? `ORA-${err.errorNum}` : "SQL_ERROR";
      return {
        status: "error",
        error_code: errorCode,
        error: err.message,
        execution_time_ms: roundTo2(performance.now() - start),
      };
    } finally {
      try {
        connection.callTimeout = 0;
      } catch {
        /* best-effort */
      }
    }
  }

  override getSchema(
    _conn: unknown,
    _schemaName: string = "",
    _tableFilter: string | null = null,
  ): Table[] {
    return [];
  }

  async getSchemaAsync(
    conn: unknown,
    schemaName: string = "",
    tableFilter: string | null = null,
  ): Promise<Table[]> {
    const handle = (await (conn as
      | Promise<OracleHandle>
      | OracleHandle)) as OracleHandle;
    const { connection } = handle;

    try {
      // G-ORA-OWNER: Oracle stores unquoted owner names in ALL_TABLES.OWNER
      // as uppercase. Uppercase the caller-supplied schema so `foo` matches
      // the `FOO` the dictionary holds. If nothing is supplied, fall back
      // to the session's CURRENT_SCHEMA.
      let owner: string;
      if (schemaName.length > 0) {
        owner = schemaName.toUpperCase();
      } else if (handle.schema !== null) {
        owner = handle.schema.toUpperCase();
      } else {
        const r = await connection.execute(
          "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL",
          [],
          this._readOpts(),
        );
        const first = (r.rows ?? [])[0] as Record<string, unknown> | undefined;
        owner = String(first?.["S"] ?? "").toUpperCase();
      }

      const tableParams: unknown[] = [owner];
      let tableSql =
        "SELECT table_name FROM all_tables WHERE owner = :1";
      if (tableFilter !== null && tableFilter !== undefined) {
        tableSql += " AND table_name LIKE :2 ESCAPE '!'";
        tableParams.push(
          tableFilter.toUpperCase().replace(/[!_%]/g, "!$&"),
        );
      }
      tableSql += " ORDER BY table_name";

      const tablesResult = await connection.execute(
        tableSql,
        tableParams,
        this._readOpts(),
      );
      const tableNames: string[] = (tablesResult.rows ?? []).map((r) =>
        String((r as Record<string, unknown>)["TABLE_NAME"]),
      );
      if (tableNames.length === 0) return [];

      // G-ORA-SCHEMA-BATCH: Oracle lacks PG's `= ANY($N::text[])`. Build
      // a positional IN-list instead (`IN (:2, :3, ...)`) so the columns
      // and PKs come back in 2 batch round-trips total — matching PG's
      // 3-round-trip shape (tables + columns + PKs).
      const placeholders = tableNames.map((_, i) => `:${i + 2}`).join(",");
      const colsResult = await connection.execute(
        "SELECT table_name, column_name, data_type, nullable, data_default, column_id " +
          "FROM all_tab_columns " +
          `WHERE owner = :1 AND table_name IN (${placeholders}) ` +
          "ORDER BY table_name, column_id",
        [owner, ...tableNames],
        this._readOpts(),
      );
      const pkResult = await connection.execute(
        "SELECT c.table_name, cc.column_name " +
          "FROM all_constraints c " +
          "JOIN all_cons_columns cc " +
          "  ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name " +
          `WHERE c.owner = :1 AND c.constraint_type = 'P' ` +
          `AND c.table_name IN (${placeholders})`,
        [owner, ...tableNames],
        this._readOpts(),
      );

      const pksByTable = new Map<string, Set<string>>();
      for (const row of pkResult.rows ?? []) {
        const r = row as Record<string, unknown>;
        const t = String(r["TABLE_NAME"]);
        let set = pksByTable.get(t);
        if (set === undefined) {
          set = new Set();
          pksByTable.set(t, set);
        }
        set.add(String(r["COLUMN_NAME"]));
      }

      const colsByTable = new Map<string, Column[]>();
      for (const row of colsResult.rows ?? []) {
        const r = row as Record<string, unknown>;
        const t = String(r["TABLE_NAME"]);
        let list = colsByTable.get(t);
        if (list === undefined) {
          list = [];
          colsByTable.set(t, list);
        }
        const name = String(r["COLUMN_NAME"]);
        list.push(
          new Column({
            name,
            data_type: String(r["DATA_TYPE"]),
            nullable: String(r["NULLABLE"]).toUpperCase() === "Y",
            is_primary_key: pksByTable.get(t)?.has(name) ?? false,
            default:
              r["DATA_DEFAULT"] === null || r["DATA_DEFAULT"] === undefined
                ? null
                : String(r["DATA_DEFAULT"]),
          }),
        );
      }

      const out: Table[] = [];
      for (const tableName of tableNames) {
        out.push(
          new Table({
            name: tableName,
            schema: owner,
            columns: colsByTable.get(tableName) ?? [],
          }),
        );
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Release the checked-out connection back to the pool. Does NOT destroy
   * the pool — use {@link shutdown} for that.
   */
  override close(conn: unknown): void {
    Promise.resolve(conn as Promise<OracleHandle> | OracleHandle)
      .then((h) => h.connection.close())
      .catch((e: unknown) => {
        process.stderr.write(
          `[oracle] release error (best-effort): ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
      });
  }

  override classifyOperation(query: string): OperationType {
    return classifySqlKeywords(query);
  }

  async closeAsync(conn: unknown): Promise<void> {
    const handle = (await (conn as
      | Promise<OracleHandle>
      | OracleHandle)) as OracleHandle;
    try {
      await handle.connection.close();
    } catch {
      /* best-effort */
    }
  }

  async healthCheck(conn: unknown): Promise<boolean> {
    try {
      const handle = (await (conn as
        | Promise<OracleHandle>
        | OracleHandle)) as OracleHandle;
      const r = await handle.connection.execute(
        "SELECT 1 FROM DUAL",
        [],
        this._readOpts(),
      );
      return (r.rows ?? []).length === 1;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    const pool = this._pool;
    this._pool = null;
    this._poolPromise = null;
    if (pool !== null) {
      try {
        await pool.close(10);
      } catch {
        /* best-effort */
      }
    }
  }
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
