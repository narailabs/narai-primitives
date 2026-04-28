import { describe, it, expect } from "vitest";
import { resolveConfig, resolveConnector } from "../../src/config/resolve.js";
import type { RawConfigInput } from "../../src/config/types.js";

const BASE: RawConfigInput = {
  model: "claude-opus-4-7",
  enforce_hooks: true,
  policy: { read: "allow", write: "escalate", delete: "escalate", admin: "escalate", privilege: "escalate" },
  connectors: {
    jira: { skill: "jira-agent-connector", "atlassian-api-key": "env:ATLASSIAN_KEY" },
    db: {
      skill: "db-agent-connector",
      policy: { unbounded_select: "escalate", admin: "deny", privilege: "deny" },
      audit: { enabled: true, path: "~/.db-agent/audit.jsonl" },
    },
  },
};

describe("resolveConfig (no overrides)", () => {
  it("materializes the base into ResolvedConfig", () => {
    const r = resolveConfig(BASE);
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.enforce_hooks).toBe(true);
    expect(r.environment).toBeNull();
    expect(r.consumer).toBeNull();
    expect(Object.keys(r.connectors)).toEqual(["jira", "db"]);
  });

  it("every connector defaults to enabled when no consumer is set", () => {
    const r = resolveConfig(BASE);
    expect(r.connectors["jira"]?.enabled).toBe(true);
    expect(r.connectors["db"]?.enabled).toBe(true);
  });

  it("connector policy is the merge of top-level and connector-level", () => {
    const r = resolveConfig(BASE);
    expect(r.connectors["jira"]?.policy).toEqual({
      read: "allow",
      write: "escalate",
      delete: "escalate",
      admin: "escalate",
      privilege: "escalate",
    });
    expect(r.connectors["db"]?.policy).toEqual({
      read: "allow",
      write: "escalate",
      delete: "escalate",
      admin: "deny",
      privilege: "deny",
      unbounded_select: "escalate",
    });
  });

  it("non-reserved connector keys flow into options", () => {
    const r = resolveConfig(BASE);
    expect(r.connectors["jira"]?.options["atlassian-api-key"]).toBe("env:ATLASSIAN_KEY");
    expect(r.connectors["db"]?.options["audit"]).toEqual({
      enabled: true,
      path: "~/.db-agent/audit.jsonl",
    });
  });

  it("throws if an enabled connector has no skill", () => {
    expect(() => resolveConfig({ connectors: { foo: {} } })).toThrow(/no 'skill'/);
  });
});

describe("environment overrides", () => {
  it("applies environments.default when no environment is given", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      environments: {
        default: "dev",
        dev: {
          db: {
            servers: { "app1-db": { host: "dev.example.com", port: 5432 } },
          },
        },
      },
    };
    const r = resolveConfig(cfg);
    expect(r.environment).toBe("dev");
    expect(r.connectors["db"]?.options["servers"]).toEqual({
      "app1-db": { host: "dev.example.com", port: 5432 },
    });
  });

  it("explicit environment overrides default", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      environments: {
        default: "dev",
        dev: { db: { servers: { "app1-db": { port: 5432 } } } },
        prod: { db: { servers: { "app1-db": { port: 6432 } } } },
      },
    };
    const r = resolveConfig(cfg, { environment: "prod" });
    expect(r.environment).toBe("prod");
    expect(r.connectors["db"]?.options["servers"]).toEqual({
      "app1-db": { port: 6432 },
    });
  });

  it("environment block can override top-level fields", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      environments: {
        default: "dev",
        dev: { model: "claude-haiku-4-5" },
      },
    };
    const r = resolveConfig(cfg);
    expect(r.model).toBe("claude-haiku-4-5");
  });

  it("throws on missing environment", () => {
    expect(() => resolveConfig(BASE, { environment: "qa" })).toThrow(/Environment 'qa' not found/);
  });
});

describe("consumer overrides", () => {
  it("applies consumer-level top-level fields", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      consumers: {
        "doc-wiki": {
          policy: { read: "allow", write: "deny", delete: "deny", admin: "deny", privilege: "deny" },
        },
      },
    };
    const r = resolveConfig(cfg, { consumer: "doc-wiki" });
    expect(r.consumer).toBe("doc-wiki");
    expect(r.policy["write"]).toBe("deny");
    expect(r.connectors["jira"]?.policy["write"]).toBe("deny");
  });

  it("applies consumer-level per-connector overrides", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      consumers: {
        "doc-wiki": {
          db: { policy: { write: "deny" } },
        },
      },
    };
    const r = resolveConfig(cfg, { consumer: "doc-wiki" });
    expect(r.connectors["db"]?.policy["write"]).toBe("deny");
    expect(r.connectors["jira"]?.policy["write"]).toBe("escalate");
  });

  it("consumer enabled list filters connectors", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      consumers: {
        "other-app": { enabled: ["jira"] },
      },
    };
    const r = resolveConfig(cfg, { consumer: "other-app" });
    expect(r.connectors["jira"]?.enabled).toBe(true);
    expect(r.connectors["db"]?.enabled).toBe(false);
  });

  it("consumer can disable a single connector", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      consumers: {
        "other-app": { jira: { disable: true } },
      },
    };
    const r = resolveConfig(cfg, { consumer: "other-app" });
    expect(r.connectors["jira"]?.enabled).toBe(false);
    expect(r.connectors["db"]?.enabled).toBe(true);
  });

  it("consumer can drill into db.servers.<name>", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      environments: {
        default: "dev",
        dev: {
          db: {
            servers: {
              "app1-db": { driver: "postgres", port: 5432 },
              "app2-db": { driver: "mssql", port: 1433 },
            },
          },
        },
      },
      consumers: {
        "doc-wiki": {
          db: {
            servers: {
              "app1-db": { port: 5433 },
              "app2-db": { disable: true },
            },
          },
        },
      },
    };
    const r = resolveConfig(cfg, { consumer: "doc-wiki" });
    const servers = r.connectors["db"]?.options["servers"] as Record<string, Record<string, unknown>>;
    expect(servers["app1-db"]?.["port"]).toBe(5433);
    expect(servers["app1-db"]?.["driver"]).toBe("postgres");
    expect(servers["app2-db"]?.["disable"]).toBe(true);
  });

  it("treats a missing consumer as no overlay (base config used as-is)", () => {
    // Calling with a consumer name that has no entry in `consumers.<name>`
    // is intentionally a no-op — the consumer block is optional. This lets
    // every consumer (e.g. doc-wiki) share the default connector setup and
    // only opt in to overrides when they actually need them.
    const r = resolveConfig(BASE, { consumer: "ghost" });
    // Resolves without throwing; the base config is used as-is.
    expect(Object.keys(r.connectors).length).toBeGreaterThan(0);
  });

  it("still throws when a declared consumer block isn't a mapping (likely YAML typo)", () => {
    const cfg: RawConfigInput = {
      ...BASE,
      consumers: { "broken": "this is a string, not a map" as unknown as Record<string, unknown> },
    };
    expect(() => resolveConfig(cfg, { consumer: "broken" })).toThrow(/must be a mapping/);
  });
});

describe("merge order: base → environment → consumer", () => {
  it("consumer wins over environment which wins over base", () => {
    const cfg: RawConfigInput = {
      model: "base-model",
      enforce_hooks: true,
      connectors: { jira: { skill: "jira-agent-connector", model: "base-jira-model" } },
      environments: {
        default: "dev",
        dev: { jira: { model: "dev-jira-model" } },
      },
      consumers: {
        "doc-wiki": { jira: { model: "wiki-jira-model" } },
      },
    };
    const r = resolveConfig(cfg, { consumer: "doc-wiki" });
    expect(r.connectors["jira"]?.model).toBe("wiki-jira-model");
  });

  it("connector inherits from base when env+consumer don't touch it", () => {
    const cfg: RawConfigInput = {
      connectors: { jira: { skill: "jira-agent-connector", model: "base-jira-model" } },
      environments: { default: "dev", dev: {} },
      consumers: { "doc-wiki": {} },
    };
    const r = resolveConfig(cfg, { consumer: "doc-wiki" });
    expect(r.connectors["jira"]?.model).toBe("base-jira-model");
  });
});

describe("resolveConnector helper", () => {
  it("returns the slice for a known name", () => {
    const r = resolveConfig(BASE);
    const slice = resolveConnector("jira", r);
    expect(slice.name).toBe("jira");
    expect(slice.skill).toBe("jira-agent-connector");
  });

  it("throws on unknown name", () => {
    const r = resolveConfig(BASE);
    expect(() => resolveConnector("ghost", r)).toThrow(/'ghost' not found/);
  });
});
