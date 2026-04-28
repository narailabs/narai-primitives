/**
 * Tests for src/lib/plugin_config.ts — V2.0 vocab + connector-config slice.
 *
 * Reference-string grammar lives in `@narai/credential-providers`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_POLICY,
  loadPluginConfig,
  mergePolicy,
  pluginConfigFromSlice,
  validatePluginConfig,
} from "../../../src/connectors/db/lib/plugin_config.js";

function writeYaml(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf-8");
}

describe("mergePolicy", () => {
  it("returns a clone of base when override is undefined", () => {
    const result = mergePolicy(DEFAULT_POLICY);
    expect(result).toEqual(DEFAULT_POLICY);
    expect(result).not.toBe(DEFAULT_POLICY);
  });

  it("overlays only the keys present on override", () => {
    const result = mergePolicy(DEFAULT_POLICY, { write: "allow" });
    expect(result).toEqual({
      read: "allow",
      write: "allow",
      delete: "present",
      admin: "present",
      privilege: "deny",
      unbounded_select: "escalate",
    });
  });

  it("supports tightening read to deny", () => {
    const result = mergePolicy(DEFAULT_POLICY, { read: "deny" });
    expect(result.read).toBe("deny");
    expect(result.write).toBe("escalate");
  });
});

describe("validatePluginConfig", () => {
  it("accepts a minimal well-formed config", () => {
    const cfg = validatePluginConfig({
      servers: { dev: { driver: "sqlite", database: ":memory:" } },
    });
    expect(cfg.policy).toEqual(DEFAULT_POLICY);
    expect(cfg.servers["dev"]?.driver).toBe("sqlite");
    expect(cfg.servers["dev"]?.["database"]).toBe(":memory:");
  });

  it("rejects admin: allow at the global level", () => {
    expect(() =>
      validatePluginConfig({
        policy: { admin: "allow" },
        servers: { dev: { driver: "sqlite" } },
      }),
    ).toThrow(/policy.admin: 'allow' is not permitted/);
  });

  it("rejects privilege: allow at the global level", () => {
    expect(() =>
      validatePluginConfig({
        policy: { privilege: "allow" },
        servers: { dev: { driver: "sqlite" } },
      }),
    ).toThrow(/policy.privilege: 'allow' is not permitted/);
  });

  it("rejects admin: allow in a per-server override", () => {
    expect(() =>
      validatePluginConfig({
        policy: DEFAULT_POLICY,
        servers: {
          dev: { driver: "sqlite", policy: { admin: "allow" } },
        },
      }),
    ).toThrow(/servers.dev.policy.admin: 'allow' is not permitted/);
  });

  it("requires the servers map", () => {
    expect(() =>
      validatePluginConfig({ policy: DEFAULT_POLICY }),
    ).toThrow(/servers: required/);
  });

  it("requires at least one named server", () => {
    expect(() =>
      validatePluginConfig({ policy: DEFAULT_POLICY, servers: {} }),
    ).toThrow(/must contain at least one named server/);
  });

  it("requires a driver on each server", () => {
    expect(() =>
      validatePluginConfig({
        servers: { dev: { host: "x" } },
      }),
    ).toThrow(/servers.dev.driver: required/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      validatePluginConfig({
        policy: DEFAULT_POLICY,
        servers: { dev: { driver: "sqlite" } },
        bogus: true,
      }),
    ).toThrow(/unknown top-level key 'bogus'/);
  });

  it("rejects unknown policy keys (catches typos)", () => {
    expect(() =>
      validatePluginConfig({
        policy: { read: "allow", writes: "allow" },
        servers: { dev: { driver: "sqlite" } },
      }),
    ).toThrow(/policy: unknown key 'writes'/);
  });

  it("allows admin: escalate (safety floor permits escalate)", () => {
    const cfg = validatePluginConfig({
      policy: { admin: "escalate" },
      servers: { dev: { driver: "sqlite" } },
    });
    expect(cfg.policy.admin).toBe("escalate");
  });

  it("write: allow is permitted (write/delete are not safety-floor restricted)", () => {
    const cfg = validatePluginConfig({
      policy: { write: "allow" },
      servers: { dev: { driver: "sqlite" } },
    });
    expect(cfg.policy.write).toBe("allow");
  });

  it("delete: allow is permitted (write/delete are not safety-floor restricted)", () => {
    const cfg = validatePluginConfig({
      policy: { delete: "allow" },
      servers: { dev: { driver: "sqlite" } },
    });
    expect(cfg.policy.delete).toBe("allow");
  });

  it("accepts policy.unbounded_select: 'allow' (operator opt-out)", () => {
    const cfg = validatePluginConfig({
      policy: { unbounded_select: "allow" },
      servers: { dev: { driver: "sqlite" } },
    });
    expect(cfg.policy.unbounded_select).toBe("allow");
  });

  it("rejects unknown policy.unbounded_select values", () => {
    expect(() =>
      validatePluginConfig({
        policy: { unbounded_select: "ignore" },
        servers: { dev: { driver: "sqlite" } },
      }),
    ).toThrow(/policy.unbounded_select: expected one of/);
  });

  it("accepts audit.enabled: false without an audit.path", () => {
    const cfg = validatePluginConfig({
      servers: { dev: { driver: "sqlite" } },
      audit: { enabled: false },
    });
    expect(cfg.audit?.enabled).toBe(false);
    expect(cfg.audit?.path).toBeUndefined();
  });

  it("still requires audit.path when audit.enabled is true", () => {
    expect(() =>
      validatePluginConfig({
        servers: { dev: { driver: "sqlite" } },
        audit: { enabled: true },
      }),
    ).toThrow(/audit.path: expected non-empty string when audit.enabled is true/);
  });

  it("carries driver-specific pass-through fields onto the server", () => {
    const cfg = validatePluginConfig({
      servers: {
        staging: {
          driver: "postgresql",
          host: "db.staging",
          port: 5432,
          database: "app",
          user: "ro",
          password: "env:DB_PW",
          ssl: "require",
          pool: { ttl_seconds: 300 },
        },
      },
    });
    const srv = cfg.servers["staging"];
    expect(srv?.["host"]).toBe("db.staging");
    expect(srv?.["port"]).toBe(5432);
    expect(srv?.["password"]).toBe("env:DB_PW");
    expect(srv?.["pool"]).toEqual({ ttl_seconds: 300 });
  });

  it("captures and validates an audit block", () => {
    const cfg = validatePluginConfig({
      servers: { dev: { driver: "sqlite" } },
      audit: { enabled: true, path: "/tmp/a.jsonl" },
    });
    expect(cfg.audit).toEqual({ enabled: true, path: "/tmp/a.jsonl" });
  });
});

describe("pluginConfigFromSlice — V2.0 connector-config integration", () => {
  it("builds a PluginConfig from a resolved slice", () => {
    const cfg = pluginConfigFromSlice({
      policy: { read: "allow", write: "escalate" },
      options: {
        servers: {
          dev: { driver: "sqlite", database: ":memory:" },
        },
      },
    });
    expect(cfg.policy.read).toBe("allow");
    expect(cfg.policy.write).toBe("escalate");
    expect(cfg.policy.admin).toBe(DEFAULT_POLICY.admin);
    expect(cfg.servers["dev"]?.driver).toBe("sqlite");
  });

  it("rejects admin: allow even when sourced from a slice", () => {
    expect(() =>
      pluginConfigFromSlice({
        policy: { admin: "allow" },
        options: {
          servers: { dev: { driver: "sqlite" } },
        },
      }),
    ).toThrow(/policy.admin: 'allow' is not permitted/);
  });

  it("requires options.servers", () => {
    expect(() =>
      pluginConfigFromSlice({
        policy: {},
        options: {},
      }),
    ).toThrow(/servers: required/);
  });

  it("propagates audit settings from options.audit", () => {
    const cfg = pluginConfigFromSlice({
      policy: {},
      options: {
        servers: { dev: { driver: "sqlite" } },
        audit: { enabled: true, path: "/tmp/audit.jsonl" },
      },
    });
    expect(cfg.audit).toEqual({ enabled: true, path: "/tmp/audit.jsonl" });
  });
});

describe("loadPluginConfig — explicit path only (V2.0 removed legacy discovery)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-agent-plugin-cfg-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns null when no explicit path is provided (no implicit discovery)", () => {
    const cfg = loadPluginConfig({});
    expect(cfg).toBeNull();
  });

  it("loads the explicit path when it is plugin-shaped", () => {
    const explicit = path.join(tmp, "my.yaml");
    writeYaml(
      explicit,
      `servers:\n  dev: { driver: sqlite, database: ":memory:" }\n`,
    );
    const cfg = loadPluginConfig({ explicitPath: explicit });
    expect(cfg).not.toBeNull();
    expect(cfg?.servers["dev"]?.driver).toBe("sqlite");
  });

  it("returns null when --config points to a legacy-shaped file", () => {
    const legacy = path.join(tmp, "wiki.config.yaml");
    writeYaml(
      legacy,
      `ecosystem:\n  database:\n    environments:\n      dev: { driver: sqlite, database: ":memory:" }\n`,
    );
    const cfg = loadPluginConfig({ explicitPath: legacy });
    expect(cfg).toBeNull();
  });

  it("throws when the explicit path does not exist", () => {
    expect(() =>
      loadPluginConfig({ explicitPath: "/does/not/exist.yaml" }),
    ).toThrow(/Config file not found/);
  });

  it("expects new vocab in explicit-path config", () => {
    const explicit = path.join(tmp, "my.yaml");
    writeYaml(
      explicit,
      `policy:\n  write: escalate\nservers:\n  dev: { driver: sqlite, database: ":memory:" }\n`,
    );
    const cfg = loadPluginConfig({ explicitPath: explicit });
    expect(cfg?.policy.write).toBe("escalate");
  });
});
