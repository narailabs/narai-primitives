/**
 * Default-server resolution at dispatch time. Covers all four rules from
 * the spec (sections 2.1–2.4) plus the env-overlay override case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import { fetch as dispatcherFetch } from "../../../src/connectors/db/dispatcher.js";
import { clearEnvironments } from "../../../src/connectors/db/lib/environments.js";

describe("default-server resolution", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origCwd: string;
  let origNaraiEnv: string | undefined;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-default-server-"));
    origHome = process.env["HOME"];
    origCwd = process.cwd();
    origNaraiEnv = process.env["NARAI_ENV"];
    delete process.env["NARAI_CONFIG_BLOB"];
    delete process.env["NARAI_ENV"];
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".connectors"), { recursive: true });
    process.env["HOME"] = home;
    process.chdir(tmp);
    dbPath = path.join(tmp, "test.db");
    fs.writeFileSync(dbPath, ""); // sqlite happily opens an empty file
    clearEnvironments();
  });

  afterEach(async () => {
    const { shutdownAll } = await import("../../../src/connectors/db/lib/connection.js");
    await shutdownAll();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
    delete process.env["NARAI_CONFIG_BLOB"];
    if (origNaraiEnv === undefined) delete process.env["NARAI_ENV"];
    else process.env["NARAI_ENV"] = origNaraiEnv;
    clearEnvironments();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(body: string): void {
    fs.writeFileSync(
      path.join(process.env["HOME"]!, ".connectors", "config.yaml"),
      body,
    );
  }

  it("rule 2: uses `default:` when caller omits `server`", async () => {
    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    default: orders",
      "    servers:",
      `      orders: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      `      billing: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"));
    const result = await dispatcherFetch("query", { sql: "SELECT 1 AS x" });
    expect(result["status"]).toBe("ok");
  });

  it("rule 3: implicit single-server default when `servers:` has one entry", async () => {
    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    servers:",
      `      onlyone: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"));
    const result = await dispatcherFetch("query", { sql: "SELECT 1 AS x" });
    expect(result["status"]).toBe("ok");
  });

  it("rule 4: errors when multiple servers, no default, and no `server` param", async () => {
    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    servers:",
      `      orders:  { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      `      billing: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"));
    const result = await dispatcherFetch("query", { sql: "SELECT 1" });
    expect(result["status"]).toBe("error");
    expect(String(result["error_code"])).toBe("VALIDATION_ERROR");
    expect(String(result["error"])).toMatch(/server.*available.*orders.*billing/i);
  });

  it("rule 1: explicit `server` wins over `default:`", async () => {
    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    default: orders",
      "    servers:",
      `      orders:  { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      `      billing: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"));
    const result = await dispatcherFetch("query", { server: "billing", sql: "SELECT 1" });
    expect(result["status"]).toBe("ok");
  });

  it("env overlay overrides `default:`", async () => {
    // Use distinct sqlite files and seed a table only in billing.db so the
    // query succeeds iff the env-overlay actually swapped the default from
    // orders → billing. With both servers pointing at the same file, a
    // silent overlay failure would still hit `orders` and pass.
    const ordersPath = path.join(tmp, "orders.db");
    const billingPath = path.join(tmp, "billing.db");
    fs.writeFileSync(ordersPath, "");
    fs.writeFileSync(billingPath, "");
    const seed = new Database(billingPath);
    seed.exec(
      "CREATE TABLE billing_only (id INTEGER PRIMARY KEY); " +
        "INSERT INTO billing_only VALUES (1);",
    );
    seed.close();

    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    default: orders",
      "    servers:",
      `      orders:  { driver: sqlite, database: ${JSON.stringify(ordersPath)} }`,
      `      billing: { driver: sqlite, database: ${JSON.stringify(billingPath)} }`,
      "environments:",
      "  staging:",
      "    db:",
      "      default: billing",
      "",
    ].join("\n"));
    process.env["NARAI_ENV"] = "staging";
    const result = await dispatcherFetch("query", {
      sql: "SELECT id FROM billing_only LIMIT 10",
    });
    expect(result["status"]).toBe("ok");
    expect(result["rows"]).toEqual([{ id: 1 }]);
  });

  it("config-load: rejects `default:` pointing at unknown server (CONFIG_ERROR at first call)", async () => {
    writeConfig([
      "connectors:",
      "  db:",
      "    skill: db-agent-connector",
      "    default: ghost",
      "    servers:",
      `      orders: { driver: sqlite, database: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"));
    const result = await dispatcherFetch("query", { server: "orders", sql: "SELECT 1" });
    expect(result["status"]).toBe("error");
    expect(String(result["error_code"])).toBe("CONFIG_ERROR");
    expect(String(result["error"])).toMatch(/default.*'ghost'.*not found/i);
  });
});
