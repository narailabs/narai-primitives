#!/usr/bin/env node
/**
 * db-agent-connector CLI dispatcher.
 *
 * Safe, read-only database query connector. Every statement is classified
 * through the policy gate BEFORE any driver is loaded or any connection
 * is opened — a `DROP TABLE` against an unreachable production host
 * returns denied in ~1ms without any network traffic.
 *
 * Accepts `--action <name> --params '<json>'`. Actions:
 *
 *   query  — execute SQL against a backend (or return formatted SQL for
 *            WRITE/DELETE via status=present_only). Params:
 *            `{env|sqlite_path, sql, max_rows?, timeout_ms?,
 *            approval_mode?, config_path?}`.
 *   schema — introspect table/column schema. Params: `{env|sqlite_path,
 *            filter?, config_path?}`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgentArgs, type ParsedAgentArgs } from "narai-primitives/toolkit";
import { loadResolvedConfig } from "narai-primitives/config";

import {
  Policy,
  classifyStatements,
  type OperationType,
} from "./lib/policy.js";
import { executeQuery, type QueryableDriver } from "./lib/query.js";
import { SQLiteDriver } from "./lib/drivers/sqlite.js";
import type {
  DatabaseDriver,
  ExecuteReadResult,
} from "./lib/drivers/base.js";
import { parseConfig } from "./config.js";
import {
  getEnvironment,
  registerEnvironment,
  clearEnvironments,
} from "./lib/environments.js";
import { getConnection, releaseConnection } from "./lib/connection.js";
import { enableAudit, logEvent } from "./lib/audit.js";
import {
  DEFAULT_POLICY,
  loadPluginConfig,
  mergePolicy,
  pluginConfigFromSlice,
  type PluginConfig,
  type PolicyRules,
} from "./lib/plugin_config.js";

export const VALID_ACTIONS: ReadonlySet<string> = new Set(["query", "schema"]);

export type FetchResult = Record<string, unknown>;
type Params = Record<string, unknown>;

// --- Param validators -------------------------------------------------------

interface QueryParamsValidated {
  sqlite_path?: string;
  env?: string;
  config_path?: string;
  sql: string;
  approval_mode?: string;
  max_rows: number;
  timeout_ms: number;
}

interface SchemaParamsValidated {
  sqlite_path?: string;
  env?: string;
  config_path?: string;
  filter?: string;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function requireConnTarget(p: Params): {
  sqlite_path?: string;
  env?: string;
  config_path?: string;
} {
  const sqlite =
    typeof p["sqlite_path"] === "string" ? (p["sqlite_path"] as string) : undefined;
  const env = typeof p["env"] === "string" ? (p["env"] as string) : undefined;
  if (!sqlite && !env) {
    throw new Error("params must include one of 'sqlite_path' or 'env'");
  }
  if (sqlite && env) {
    throw new Error("params 'sqlite_path' and 'env' are mutually exclusive");
  }
  const config_path =
    typeof p["config_path"] === "string" ? (p["config_path"] as string) : undefined;
  const out: { sqlite_path?: string; env?: string; config_path?: string } = {};
  if (sqlite) out.sqlite_path = sqlite;
  if (env) out.env = env;
  if (config_path) out.config_path = config_path;
  return out;
}

function validateQueryParams(p: Params): QueryParamsValidated {
  const conn = requireConnTarget(p);
  const sqlRaw = p["sql"];
  if (typeof sqlRaw !== "string" || sqlRaw.length === 0) {
    throw new Error("action 'query' requires a non-empty 'sql' string");
  }
  const v: QueryParamsValidated = {
    sql: sqlRaw,
    max_rows: toInt(p["max_rows"], 1000),
    timeout_ms: toInt(p["timeout_ms"], 30000),
  };
  if (conn.sqlite_path) v.sqlite_path = conn.sqlite_path;
  if (conn.env) v.env = conn.env;
  if (conn.config_path) v.config_path = conn.config_path;
  const approval = p["approval_mode"];
  if (typeof approval === "string" && approval.length > 0) {
    v.approval_mode = approval;
  }
  return v;
}

function validateSchemaParams(p: Params): SchemaParamsValidated {
  const conn = requireConnTarget(p);
  const v: SchemaParamsValidated = {};
  if (conn.sqlite_path) v.sqlite_path = conn.sqlite_path;
  if (conn.env) v.env = conn.env;
  if (conn.config_path) v.config_path = conn.config_path;
  const filter = p["filter"];
  if (typeof filter === "string" && filter.length > 0) v.filter = filter;
  return v;
}

// --- Shared helpers lifted from the original CLI ---------------------------

function _expandUser(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

/**
 * Classify `sql` and short-circuit if the strictest rule for any op in the
 * statement is not `allow`. Returns `null` on allow; returns a ready-to-emit
 * envelope otherwise. The strength of this check: it runs BEFORE
 * `getConnection()`, so a DROP TABLE against an unreachable production host
 * returns denied in ~1ms without any network traffic.
 */
export function _preCheckPolicy(
  sql: string,
  approvalMode: string,
  rules: PolicyRules,
): { response: FetchResult; exitCode: number } | null {
  let ops: OperationType[];
  try {
    ops = classifyStatements(sql);
  } catch {
    ops = ["admin"];
  }
  const strictness: Record<string, number> = {
    allow: 0,
    present: 1,
    escalate: 2,
    deny: 3,
  };
  let strictestRule: PolicyRules[OperationType] = "allow";
  for (const op of ops) {
    const r = rules[op];
    if (strictness[r]! > strictness[strictestRule]!) strictestRule = r;
  }
  if (strictestRule === "allow") return null;

  let policy: Policy;
  try {
    policy = new Policy(approvalMode, rules);
  } catch (e) {
    return {
      response: {
        status: "error",
        error: (e as Error).message,
        execution_time_ms: 0,
      },
      exitCode: 2,
    };
  }

  const result = policy.checkQuery(sql);
  const status = result.decision === "deny" ? "denied" : result.decision;
  const response: FetchResult = {
    status,
    reason: result.reason,
    execution_time_ms: 0,
  };
  if (result.decision === "present_only") {
    response["formatted_sql"] = result.formatted_sql;
  }
  const exitCode = result.decision === "present_only" ? 0 : 1;
  return { response, exitCode };
}

export function adaptDriver(
  driver: DatabaseDriver,
  conn: unknown,
): QueryableDriver {
  const asyncDriver = driver as DatabaseDriver & {
    executeReadAsync?: (
      conn: unknown,
      sql: string,
      params?: unknown[] | null,
      maxRows?: number,
      timeoutMs?: number,
    ) => Promise<ExecuteReadResult>;
  };
  if (typeof asyncDriver.executeReadAsync === "function") {
    const nativeAsync = asyncDriver.executeReadAsync.bind(asyncDriver);
    return {
      executeReadAsync(
        _conn: unknown,
        sql: string,
        params?: unknown[] | null,
        maxRows?: number,
        timeoutMs?: number,
      ) {
        return nativeAsync(
          conn,
          sql,
          params ?? null,
          maxRows ?? 1000,
          timeoutMs ?? 30000,
        );
      },
    };
  }
  return {
    executeReadAsync(
      _conn: unknown,
      sql: string,
      params?: unknown[] | null,
      maxRows?: number,
      timeoutMs?: number,
    ) {
      return Promise.resolve(
        driver.executeRead(
          conn,
          sql,
          params ?? null,
          maxRows ?? 1000,
          timeoutMs ?? 30000,
        ),
      );
    },
  };
}

export function runSchema(
  driver: DatabaseDriver,
  conn: unknown,
  filter: string | null,
  envName: string = "",
): FetchResult {
  try {
    const tables = driver.getSchema(conn, undefined, filter);
    let columnCount = 0;
    for (const t of tables) columnCount += t.columns.length;
    logEvent({
      event_type: "schema_inspect",
      details: {
        env: envName,
        table_filter: filter,
        column_count: columnCount,
      },
    });
    return {
      status: "ok",
      tables: tables.map((t) => t.toDict()),
      table_count: tables.length,
    };
  } catch (exc) {
    return {
      status: "error",
      error_code: "SCHEMA_ERROR",
      error: (exc as Error).message,
    };
  }
}

export interface ResolvedEnv {
  name: string;
  driver: string;
  approval_mode: string;
  grant_duration_hours: number | undefined;
}

export function resolveEnv(envName: string, configPath: string): ResolvedEnv {
  const cfg = parseConfig(configPath) as Record<string, unknown>;
  const ecosystem = cfg["ecosystem"] as Record<string, unknown> | undefined;
  const database = ecosystem?.["database"] as Record<string, unknown> | undefined;

  const auditCfg = database?.["audit"] as Record<string, unknown> | undefined;
  if (
    auditCfg !== undefined &&
    auditCfg["enabled"] === true &&
    typeof auditCfg["path"] === "string" &&
    (auditCfg["path"] as string).length > 0
  ) {
    const rawPath = _expandUser(auditCfg["path"] as string);
    const auditPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(path.dirname(configPath), rawPath);
    enableAudit(auditPath);
  }

  const rawEnvs = database?.["environments"];
  const envs =
    rawEnvs !== null && rawEnvs !== undefined && typeof rawEnvs === "object"
      ? (rawEnvs as Record<string, Record<string, unknown>>)
      : undefined;
  if (
    envs === undefined ||
    !Object.prototype.hasOwnProperty.call(envs, envName)
  ) {
    throw new Error(
      `environment '${envName}' not found in ${configPath} ` +
        "(ecosystem.database.environments)",
    );
  }
  const e = envs[envName] as Record<string, unknown>;
  const driverFromEnv =
    typeof e["driver"] === "string" ? (e["driver"] as string) : undefined;
  const driverFromDb =
    typeof database?.["driver"] === "string"
      ? (database["driver"] as string)
      : undefined;
  const driver = driverFromEnv ?? driverFromDb;
  if (driver === undefined) {
    throw new Error(
      `environment '${envName}' has no 'driver' field, and ecosystem.database.driver is unset`,
    );
  }
  const rawMode =
    typeof e["approval_mode"] === "string"
      ? (e["approval_mode"] as string)
      : "auto";
  const kebabMode = rawMode.replace(/_/g, "-");
  const snakeMode = rawMode.replace(/-/g, "_");
  const grant_duration_hours =
    typeof e["grant_duration_hours"] === "number"
      ? (e["grant_duration_hours"] as number)
      : undefined;

  registerEnvironment(envName, {
    host: typeof e["host"] === "string" ? (e["host"] as string) : "",
    port: typeof e["port"] === "number" ? (e["port"] as number) : 0,
    database:
      typeof e["database"] === "string" ? (e["database"] as string) : "",
    schema: typeof e["schema"] === "string" ? (e["schema"] as string) : "public",
    approval_mode: kebabMode,
    driver,
    ...(grant_duration_hours !== undefined ? { grant_duration_hours } : {}),
  });

  return {
    name: envName,
    driver,
    approval_mode: snakeMode,
    grant_duration_hours,
  };
}

/**
 * Try loading a plugin config from the new shared lib:
 *  1. `NARAI_CONFIG_BLOB` env var (hub-injected ResolvedConnector slice).
 *  2. `~/.connectors/config.yaml` + `./.connectors/config.yaml` via
 *     `loadResolvedConfig`.
 *
 * Returns null when no `db` connector slice is available — the caller
 * may still fall back to the legacy `wiki.config.yaml` parser.
 */
async function _loadFromConnectorConfig(): Promise<PluginConfig | null> {
  const blob = process.env["NARAI_CONFIG_BLOB"];
  if (typeof blob === "string" && blob.length > 0) {
    // Narrow catch: only swallow JSON.parse failures (truly malformed
    // input). Validation errors from `pluginConfigFromSlice` (including
    // safety-floor `'allow' is not permitted` throws) propagate to
    // `runOnEnv`'s outer handler so a buggy blob surfaces as CONFIG_ERROR
    // instead of being silently ignored.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(blob);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return pluginConfigFromSlice(parsed as { policy?: Record<string, unknown>; options?: Record<string, unknown> });
    }
  }
  // `loadResolvedConfig` returns an empty resolved config when neither
  // file exists, so we don't need to swallow ENOENT-style errors. Real
  // parse / secret-syntax errors propagate to the outer handler.
  const resolved = await loadResolvedConfig();
  const slice = resolved.connectors["db"];
  if (slice === undefined) return null;
  return pluginConfigFromSlice(slice);
}

function _extractServerExtras(
  srv: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(srv)) {
    if (
      k === "driver" ||
      k === "policy" ||
      k === "approval_mode" ||
      k === "grant_duration_hours"
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

// --- Action runners --------------------------------------------------------

async function runQueryOnSqlite(v: QueryParamsValidated): Promise<FetchResult> {
  const driver = new SQLiteDriver();
  const conn = driver.connect({ database: v.sqlite_path! });
  try {
    const policy = new Policy(v.approval_mode ?? "auto", DEFAULT_POLICY);
    const queryable = adaptDriver(driver, conn);
    return await executeQuery(queryable, v.sql, policy, {
      max_rows: v.max_rows,
      timeout_ms: v.timeout_ms,
    });
  } finally {
    driver.close(conn);
  }
}

function runSchemaOnSqlite(v: SchemaParamsValidated): FetchResult {
  const driver = new SQLiteDriver();
  const conn = driver.connect({ database: v.sqlite_path! });
  try {
    return runSchema(driver, conn, v.filter ?? null, "");
  } finally {
    driver.close(conn);
  }
}

async function runOnEnv(
  action: "query" | "schema",
  v: QueryParamsValidated | SchemaParamsValidated,
): Promise<FetchResult> {
  let pluginCfg: PluginConfig | null = null;
  try {
    if (v.config_path !== undefined && v.config_path.length > 0) {
      // Explicit `--config-path`: parse the file directly. When the file
      // is not plugin-shaped, returns null and we fall through to legacy.
      pluginCfg = loadPluginConfig({ explicitPath: v.config_path });
    } else {
      pluginCfg = await _loadFromConnectorConfig();
    }
  } catch (e) {
    return {
      status: "error",
      error_code: "CONFIG_ERROR",
      error: (e as Error).message,
      execution_time_ms: 0,
    };
  }

  let envName: string;
  let approvalMode: string;
  let rules: PolicyRules;
  let grantDurationHours: number | undefined;

  try {
    if (pluginCfg !== null) {
      if (
        !Object.prototype.hasOwnProperty.call(pluginCfg.servers, v.env!)
      ) {
        const available = Object.keys(pluginCfg.servers).join(", ");
        return {
          status: "error",
          error_code: "CONFIG_ERROR",
          error:
            `environment '${v.env}' not found in plugin config ` +
            `(servers: [${available || "none"}])`,
          execution_time_ms: 0,
        };
      }
      if (pluginCfg.audit !== undefined && pluginCfg.audit.enabled) {
        enableAudit(_expandUser(pluginCfg.audit.path!));
      }
      for (const [alias, srv] of Object.entries(pluginCfg.servers)) {
        const merged = mergePolicy(pluginCfg.policy, srv.policy);
        const rawMode =
          typeof srv.approval_mode === "string" ? srv.approval_mode : "auto";
        const kebab = rawMode.replace(/_/g, "-");
        const extras = _extractServerExtras(srv);
        const gdh =
          typeof srv["grant_duration_hours"] === "number"
            ? (srv["grant_duration_hours"] as number)
            : undefined;
        registerEnvironment(alias, {
          driver: srv.driver,
          approval_mode: kebab,
          extras,
          policy: merged,
          ...(gdh !== undefined ? { grant_duration_hours: gdh } : {}),
        });
      }
      envName = v.env!;
      const env = getEnvironment(envName);
      const qv = v as QueryParamsValidated;
      approvalMode =
        qv.approval_mode ?? env.approval_mode.replace(/-/g, "_");
      rules = env.policy ?? DEFAULT_POLICY;
      grantDurationHours = env.grant_duration_hours;
    } else {
      const configPath = v.config_path ?? "./wiki.config.yaml";
      const resolved = resolveEnv(v.env!, configPath);
      envName = resolved.name;
      const qv = v as QueryParamsValidated;
      approvalMode = qv.approval_mode ?? resolved.approval_mode;
      rules = DEFAULT_POLICY;
      grantDurationHours = resolved.grant_duration_hours;
    }
  } catch (e) {
    clearEnvironments();
    return {
      status: "error",
      error_code: "CONFIG_ERROR",
      error: (e as Error).message,
      execution_time_ms: 0,
    };
  }

  // Pre-connect policy gate: short-circuit deny/escalate/present_only
  // before we load any driver or open any connection. This is the
  // load-bearing invariant documented in CLAUDE.md and the plugin spec.
  if (action === "query") {
    const q = v as QueryParamsValidated;
    const short = _preCheckPolicy(q.sql, approvalMode, rules);
    if (short !== null) {
      clearEnvironments();
      return short.response;
    }
  }

  let conn;
  try {
    conn = await getConnection(envName);
  } catch (e) {
    clearEnvironments();
    return {
      status: "error",
      error_code: "CONNECTION_ERROR",
      error: (e as Error).message,
      execution_time_ms: 0,
    };
  }

  try {
    if (action === "schema") {
      const sv = v as SchemaParamsValidated;
      return runSchema(conn.driver, conn.native, sv.filter ?? null, envName);
    }
    const qv = v as QueryParamsValidated;
    const policy = new Policy(approvalMode, rules);
    // Silence unused-var lint for metadata we carry for future audit
    // enrichment — keeping the shape so callers can add grant checks later
    // without re-plumbing.
    void grantDurationHours;
    const queryable = adaptDriver(conn.driver, conn.native);
    return await executeQuery(queryable, qv.sql, policy, {
      max_rows: qv.max_rows,
      timeout_ms: qv.timeout_ms,
    });
  } finally {
    releaseConnection(envName, conn);
    clearEnvironments();
  }
}

// --- Public fetch() --------------------------------------------------------

export interface FetchOptions {
  /** Reserved for future use (client injection for testing). */
  _reserved?: undefined;
}

export async function fetch(
  action: string,
  params: Params | null = null,
  _options: FetchOptions = {},
): Promise<FetchResult> {
  if (!VALID_ACTIONS.has(action)) {
    const sorted = [...VALID_ACTIONS].sort();
    return {
      status: "error",
      error_code: "VALIDATION_ERROR",
      error: `Unknown action '${action}' — expected one of [${sorted
        .map((s) => `'${s}'`)
        .join(", ")}]`,
      execution_time_ms: 0,
    };
  }

  const p: Params = params ?? {};
  try {
    if (action === "query") {
      const v = validateQueryParams(p);
      if (v.sqlite_path) return await runQueryOnSqlite(v);
      return await runOnEnv("query", v);
    }
    const v = validateSchemaParams(p);
    if (v.sqlite_path) return runSchemaOnSqlite(v);
    return await runOnEnv("schema", v);
  } catch (exc) {
    return {
      status: "error",
      error_code: "VALIDATION_ERROR",
      error: (exc as Error).message,
      execution_time_ms: 0,
    };
  }
}

// --- main() / CLI entry ----------------------------------------------------

type ParsedArgs = ParsedAgentArgs;
const parseArgs = (argv: readonly string[]): ParsedArgs =>
  parseAgentArgs(argv, { flags: ["action", "params"] });

export const HELP_TEXT = `usage: db-agent-connector [-h] --action {query,schema} [--params PARAMS]

Safe, read-only database query connector with guard-rail policy enforcement.

options:
  -h, --help      show this help message and exit
  --action {query,schema}
                  Action to perform
  --params PARAMS
                  JSON string of action parameters

action 'query' params:
  {"env": "dev", "sql": "SELECT 1"}  or
  {"sqlite_path": "./test.db", "sql": "SELECT 1"}
  optional: max_rows (default 1000), timeout_ms (default 30000),
           approval_mode, config_path

action 'schema' params:
  {"env": "dev"}  or  {"sqlite_path": "./test.db"}
  optional: filter, config_path

Writes/deletes (INSERT/UPDATE/DELETE/TRUNCATE/…) follow the configured
policy. By default, WRITE escalates and DELETE/ADMIN return status="present_only"
with a formatted_sql payload; PRIVILEGE statements return status="denied".
Policy classification runs BEFORE the driver loads or any connection opens.
`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!args.action) {
    process.stderr.write("the following arguments are required: --action\n");
    return 2;
  }

  if (!VALID_ACTIONS.has(args.action)) {
    const sorted = [...VALID_ACTIONS].sort();
    process.stderr.write(
      `argument --action: invalid choice: '${args.action}' (choose from ${sorted
        .map((s) => `'${s}'`)
        .join(", ")})\n`,
    );
    return 2;
  }

  const paramsRaw = args.params ?? "{}";
  let params: Params;
  try {
    const parsed: unknown = JSON.parse(paramsRaw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    params = parsed as Params;
  } catch (e) {
    const result: FetchResult = {
      status: "error",
      error_code: "VALIDATION_ERROR",
      error: `Invalid JSON in --params: ${(e as Error).message}`,
      execution_time_ms: 0,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 1;
  }

  const result = await fetch(args.action, params);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  const status = result["status"] as string | undefined;
  if (status === "ok" || status === "present_only") return 0;
  return 1;
}

function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const scriptPath = fs.realpathSync(path.resolve(argv1));
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void main().then((code) => process.exit(code));
}
