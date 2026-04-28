/**
 * drivers/register.ts — Lazy driver loader.
 *
 * Replaces the v1 eager `registerAll()` (which pulled every optional Phase E
 * dep into memory on `import "./lib"`) with an alias-aware `ensureDriver(name)`
 * that dynamic-imports the requested driver module on demand. Idempotent —
 * a second call for the same driver is a no-op.
 *
 * Call sites:
 *  - `connection.getConnection(envName)` awaits `ensureDriver(driverName)`
 *    before the factory lookup.
 *  - Tests that want every driver wired up can `await registerAll()`, which
 *    resolves all of them in parallel.
 *
 * Heavy optional deps (`pg`, `mysql2`, `mssql`, `mongodb`,
 * `@aws-sdk/client-dynamodb`) therefore only load when a config references
 * the corresponding driver name.
 */
import { listDriverFactories, registerDriverFactory } from "../connection.js";

type DriverKey =
  | "sqlite"
  | "postgresql"
  | "mysql"
  | "sqlserver"
  | "mongodb"
  | "dynamodb"
  | "oracle";

const ALIASES: Record<string, DriverKey> = {
  sqlite: "sqlite",
  postgresql: "postgresql",
  postgres: "postgresql",
  mysql: "mysql",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  mongodb: "mongodb",
  mongo: "mongodb",
  dynamodb: "dynamodb",
  dynamo: "dynamodb",
  oracle: "oracle",
  oracledb: "oracle",
  oci: "oracle",
};

const _loaded: Set<DriverKey> = new Set();

/**
 * Dynamic-import and register the driver backing a given name (or alias).
 * Throws if `name` is not a recognized driver key; callers should propagate
 * this through to the CLI where it surfaces as a validation error.
 */
export async function ensureDriver(name: string): Promise<void> {
  // If a factory is already registered (including test-only mock drivers),
  // leave it alone — the caller's factory wins.
  if (listDriverFactories().includes(name)) return;
  const key = ALIASES[name];
  if (key === undefined) {
    throw new Error(
      `unknown driver: '${name}' (valid: ${Object.keys(ALIASES).sort().join(", ")})`,
    );
  }
  if (_loaded.has(key)) return;
  switch (key) {
    case "sqlite": {
      const m = await import("./sqlite.js");
      registerDriverFactory("sqlite", () => new m.SQLiteDriver());
      break;
    }
    case "postgresql": {
      const m = await import("./postgresql.js");
      registerDriverFactory("postgresql", () => new m.PostgresDriver());
      registerDriverFactory("postgres", () => new m.PostgresDriver());
      break;
    }
    case "mysql": {
      const m = await import("./mysql.js");
      registerDriverFactory("mysql", () => new m.MysqlDriver());
      break;
    }
    case "sqlserver": {
      const m = await import("./sqlserver.js");
      registerDriverFactory("sqlserver", () => new m.SqlServerDriver());
      registerDriverFactory("mssql", () => new m.SqlServerDriver());
      break;
    }
    case "mongodb": {
      const m = await import("./mongodb.js");
      registerDriverFactory("mongodb", () => new m.MongoDriver());
      registerDriverFactory("mongo", () => new m.MongoDriver());
      break;
    }
    case "dynamodb": {
      const m = await import("./dynamodb.js");
      registerDriverFactory("dynamodb", () => new m.DynamoDriver());
      registerDriverFactory("dynamo", () => new m.DynamoDriver());
      break;
    }
    case "oracle": {
      const m = await import("./oracle.js");
      registerDriverFactory("oracle", () => new m.OracleDriver());
      registerDriverFactory("oracledb", () => new m.OracleDriver());
      registerDriverFactory("oci", () => new m.OracleDriver());
      break;
    }
  }
  _loaded.add(key);
}

/**
 * Load and register every shipped driver. Used by tests that want the
 * full registry available and by explicit library consumers. Prefer
 * `ensureDriver(name)` in production code paths so only the drivers
 * actually in use get pulled into memory.
 */
export async function registerAll(): Promise<void> {
  const unique = [...new Set(Object.values(ALIASES))];
  await Promise.all(unique.map((k) => ensureDriver(k)));
}

/** Test helper — drop the loaded-driver memo so dynamic imports re-run. */
export function _resetLoadedDrivers(): void {
  _loaded.clear();
}
