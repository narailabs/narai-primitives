/**
 * Tests for --env dispatch (G-DB-AGENT-ENV) under the action/params CLI.
 *
 * Exercises the path where the CLI loads a config, resolves the named
 * environment, and dispatches through the policy gate and connection pool.
 * Uses sqlite-backed envs (driver: sqlite, database: <path>) so tests are
 * self-contained — no Docker, no network, no credentials required.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

import { main } from "../../../src/connectors/db/cli.js";
import { clearEnvironments } from "../../../src/connectors/db/lib/environments.js";
import { argsFor, parseResult } from "./fixtures.js";

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeFixtureDb(tmp: string): string {
  const dbPath = path.join(tmp, "test.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
  db.prepare("INSERT INTO users (name) VALUES (?)").run("Alice");
  db.prepare("INSERT INTO users (name) VALUES (?)").run("Bob");
  db.close();
  return dbPath;
}

function makeConfig(
  tmp: string,
  envs: Record<string, Record<string, unknown>>,
): string {
  const configPath = path.join(tmp, "wiki.config.yaml");
  const envsYaml = Object.entries(envs)
    .map(([name, cfg]) => {
      const lines = [`      ${name}:`];
      for (const [k, v] of Object.entries(cfg)) {
        const val = typeof v === "string" ? `"${v}"` : String(v);
        lines.push(`        ${k}: ${val}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  const body = `wiki:
  name: Test Wiki
  domain: test

ecosystem:
  database:
    enabled: true
    environments:
${envsYaml}
`;
  fs.writeFileSync(configPath, body, "utf-8");
  return configPath;
}

describe("cli env dispatch (G-DB-AGENT-ENV) — legacy wiki.config.yaml", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-query-env-"));
    clearEnvironments();
  });
  afterEach(() => {
    clearEnvironments();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("resolves sqlite driver and runs SELECT", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          config_path: configPath,
          sql: "SELECT name FROM users WHERE id >= 1 ORDER BY id",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      rows: Array<{ name: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
  });

  // V2.0: DROP classifies as ADMIN. Default policy is admin: present, so
  // a legacy-config DROP path now returns present_only (not denied).
  it("ADMIN returns present_only by default", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          config_path: configPath,
          sql: "DROP TABLE users",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as { status: string };
    expect(result.status).toBe("present_only");
  });

  // V2.0: WRITE defaults to escalate. Was DML present.
  it("WRITE escalates by default", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          config_path: configPath,
          sql: "INSERT INTO users (name) VALUES ('Eve')",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as { status: string };
    expect(result.status).toBe("escalate");
  });

  // V2.0: DELETE defaults to present.
  it("DELETE returns present_only by default", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          config_path: configPath,
          sql: "DELETE FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      extension?: Record<string, unknown>;
    };
    expect(result.status).toBe("present_only");
    expect((result.extension?.["formatted_sql"] as string | undefined)).toMatch(/^DELETE /);
  });

  it("uses approval_mode from config when params.approval_mode is unset", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      staging: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "confirm_each",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "staging",
          config_path: configPath,
          sql: "SELECT name FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as { status: string };
    expect(result.status).toBe("escalate");
  });

  it("normalises kebab-case approval_mode to snake_case", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      prod: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "grant-required",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "prod",
          config_path: configPath,
          sql: "SELECT name FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as { status: string };
    // No active grant → READ is denied under grant_required
    expect(result.status).toBe("denied");
  });

  it("env and sqlite_path are mutually exclusive", async () => {
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sqlite_path: ":memory:",
          sql: "SELECT 1",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("VALIDATION_ERROR");
    expect(result.error).toMatch(/mutually exclusive/);
  });

  it("unknown environment produces a clear CONFIG_ERROR envelope", async () => {
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: ":memory:",
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "ghost",
          config_path: configPath,
          sql: "SELECT 1",
        }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("CONFIG_ERROR");
    expect(result.error).toMatch(/environment 'ghost' not found/);
  });

  it("schema action via env returns tables", async () => {
    const dbPath = makeFixtureDb(tmp);
    const configPath = makeConfig(tmp, {
      dev: {
        driver: "sqlite",
        database: dbPath,
        schema: "",
        approval_mode: "auto",
      },
    });
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("schema", { env: "dev", config_path: configPath }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      table_count: number;
    };
    expect(result.status).toBe("ok");
    expect(result.table_count).toBe(1);
  });

  // A5: schema action with audit enabled should write the expected
  // [pool_created, schema_inspect, connection_released] event sequence.
  it("schema audit log contains [pool_created, schema_inspect, connection_released]", async () => {
    const { shutdownAll } = await import("../../../src/connectors/db/lib/connection.js");
    await shutdownAll();

    const dbPath = makeFixtureDb(tmp);
    const auditPath = path.join(tmp, "audit.jsonl");
    const envName = `a5_audit_${Math.random().toString(36).slice(2, 8)}`;
    const configPath = path.join(tmp, "wiki.config.yaml");
    fs.writeFileSync(
      configPath,
      `wiki:
  name: A5 Test
  domain: test

ecosystem:
  database:
    enabled: true
    audit:
      enabled: true
      path: "${auditPath}"
    environments:
      ${envName}:
        driver: "sqlite"
        database: "${dbPath}"
        schema: ""
        approval_mode: "auto"
`,
      "utf-8",
    );

    await captureStdout(async () => {
      const code = await main(
        argsFor("schema", { env: envName, config_path: configPath }),
      );
      expect(code).toBe(0);
    });

    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs
      .readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            event_type: string;
            details?: {
              env?: string;
              table_filter?: string | null;
              column_count?: number;
            };
          },
      );
    const events = lines.map((r) => r.event_type);
    expect(events).toContain("pool_created");
    expect(events).toContain("schema_inspect");
    expect(events).toContain("connection_released");
    const poolIdx = events.indexOf("pool_created");
    const inspectIdx = events.indexOf("schema_inspect");
    const releaseIdx = events.indexOf("connection_released");
    expect(poolIdx).toBeLessThan(inspectIdx);
    expect(inspectIdx).toBeLessThan(releaseIdx);

    const inspect = lines.find((r) => r.event_type === "schema_inspect");
    expect(inspect?.details?.env).toBe(envName);
    expect(inspect?.details?.column_count).toBe(2);
  });
});

describe("cli env plugin config (V2.0 ~/.connectors/config.yaml)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-agent-plugin-cli-"));
    origHome = process.env["HOME"];
    origCwd = process.cwd();
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    process.env["HOME"] = home;
    delete process.env["NARAI_CONFIG_BLOB"];
    clearEnvironments();
  });

  afterEach(async () => {
    const { shutdownAll } = await import("../../../src/connectors/db/lib/connection.js");
    await shutdownAll();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    delete process.env["NARAI_CONFIG_BLOB"];
    clearEnvironments();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Write a `./.connectors/config.yaml` under the given directory. */
  function writeRepoConnectorsConfig(dir: string, body: string): string {
    const configDir = path.join(dir, ".connectors");
    fs.mkdirSync(configDir, { recursive: true });
    const p = path.join(configDir, "config.yaml");
    fs.writeFileSync(p, body, "utf-8");
    return p;
  }

  it("discovers ./.connectors/config.yaml via cwd and runs a SELECT", async () => {
    const dbPath = makeFixtureDb(tmp);
    writeRepoConnectorsConfig(
      tmp,
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(dbPath)}`,
        "",
      ].join("\n"),
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sql: "SELECT name FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      rows: Array<{ name: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.rows[0]?.name).toBe("Alice");
  });

  it("per-server write: allow actually executes an INSERT", async () => {
    const dbPath = makeFixtureDb(tmp);
    writeRepoConnectorsConfig(
      tmp,
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    policy:",
        "      read: allow",
        "      write: present",
        "      delete: present",
        "      admin: present",
        "      privilege: deny",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(dbPath)}`,
        "        policy:",
        "          write: allow",
        "",
      ].join("\n"),
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sql: "INSERT INTO users (name) VALUES ('Eve')",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as { status: string };
    expect(result.status).toBe("ok");

    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT name FROM users WHERE name = 'Eve'")
      .all() as Array<{ name: string }>;
    db.close();
    expect(rows).toHaveLength(1);
  });

  it("rejects admin: allow in config at load time", async () => {
    const dbPath = makeFixtureDb(tmp);
    writeRepoConnectorsConfig(
      tmp,
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    policy:",
        "      admin: allow",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(dbPath)}`,
        "",
      ].join("\n"),
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", { env: "dev", sql: "SELECT 1" }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("CONFIG_ERROR");
    expect(result.error).toMatch(/policy.admin: 'allow' is not permitted/);
  });

  it("repo-level config overrides user-level on conflicting keys", async () => {
    const userDbPath = makeFixtureDb(tmp);
    const repoDbPath = path.join(tmp, "repo.db");
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(repoDbPath);
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db.prepare("INSERT INTO users (name) VALUES (?)").run("RepoWinner");
    db.close();

    const home = process.env["HOME"]!;
    fs.mkdirSync(path.join(home, ".connectors"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".connectors", "config.yaml"),
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(userDbPath)}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    writeRepoConnectorsConfig(
      tmp,
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(repoDbPath)}`,
        "",
      ].join("\n"),
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sql: "SELECT name FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      rows: Array<{ name: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.rows[0]?.name).toBe("RepoWinner");
  });

  it("unknown server name reports available aliases in envelope", async () => {
    const dbPath = makeFixtureDb(tmp);
    writeRepoConnectorsConfig(
      tmp,
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      dev:",
        "        driver: sqlite",
        `        database: ${JSON.stringify(dbPath)}`,
        "",
      ].join("\n"),
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", { env: "ghost", sql: "SELECT 1" }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("CONFIG_ERROR");
    expect(result.error).toMatch(/not found in plugin config/);
    expect(result.error).toMatch(/dev/);
  });

  it("NARAI_CONFIG_BLOB env var injects the slice (hub-injected mode)", async () => {
    const dbPath = makeFixtureDb(tmp);
    const slice = {
      name: "db",
      enabled: true,
      skill: "db-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: {
        servers: {
          dev: { driver: "sqlite", database: dbPath },
        },
      },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", {
          env: "dev",
          sql: "SELECT name FROM users WHERE id = 1",
        }),
      );
      expect(code).toBe(0);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      rows: Array<{ name: string }>;
    };
    expect(result.status).toBe("ok");
    expect(result.rows[0]?.name).toBe("Alice");
  });

  // V2.0: a buggy hub injecting a slice with admin: allow must surface as
  // CONFIG_ERROR (the safety floor), not be silently ignored.
  it("NARAI_CONFIG_BLOB with admin: allow surfaces CONFIG_ERROR (safety floor)", async () => {
    const dbPath = makeFixtureDb(tmp);
    const slice = {
      name: "db",
      enabled: true,
      skill: "db-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: { admin: "allow" },
      options: {
        servers: {
          dev: { driver: "sqlite", database: dbPath },
        },
      },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", { env: "dev", sql: "SELECT 1" }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("CONFIG_ERROR");
    expect(result.error).toMatch(/policy.admin: 'allow' is not permitted/);
  });

  // V2.0: malformed YAML in ~/.connectors/config.yaml must surface as a
  // CONFIG_ERROR, not silently fall through to the legacy wiki.config.yaml.
  it("malformed ~/.connectors/config.yaml surfaces CONFIG_ERROR", async () => {
    const home = process.env["HOME"]!;
    fs.mkdirSync(path.join(home, ".connectors"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".connectors", "config.yaml"),
      "connectors:\n  db:\n    skill: db-agent-connector\n    servers:\n      dev: [this is not a mapping\n",
      "utf-8",
    );
    process.chdir(tmp);
    const stdout = await captureStdout(async () => {
      const code = await main(
        argsFor("query", { env: "dev", sql: "SELECT 1" }),
      );
      expect(code).toBe(1);
    });
    const result = parseResult(stdout) as unknown as {
      status: string;
      error_code: string;
      error: string;
    };
    expect(result.status).toBe("error");
    expect(result.error_code).toBe("CONFIG_ERROR");
  });
});
