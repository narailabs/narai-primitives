/**
 * wiki_db — shared library for safe database access.
 *
 * Public API mirrors `.claude/agents/lib/wiki_db/__init__.py`:
 *   import { executeQuery, enableAudit, disableAudit } from "wiki_db";
 *   import { Policy, Decision, checkQuery } from "wiki_db/policy";
 *   import { getEnvironment, listEnvironments } from "wiki_db/environments";
 *
 * v2: drivers load on demand via `ensureDriver(name)` (invoked internally
 * by `connection.getConnection(envName)`). Importing this barrel no longer
 * pulls the optional Phase E deps (`pg`, `mysql2`, `mssql`, `mongodb`,
 * `@aws-sdk/client-dynamodb`) into memory. Consumers that need a driver
 * class directly should import from its path (e.g.
 * `"./drivers/postgresql.js"`) — this barrel only re-exports the
 * mandatory SQLite driver.
 */

// Core
export * from "./policy.js";
export * from "./query.js";
export * from "./environments.js";
export * from "./audit.js";
export * from "./credentials.js";
export * from "./schema.js";
export * from "./connection.js";
export * from "./plugin_config.js";

// Drivers
export * from "./drivers/base.js";
export { SQLiteDriver } from "./drivers/sqlite.js";
export { ensureDriver, registerAll as registerAllDrivers } from "./drivers/register.js";
