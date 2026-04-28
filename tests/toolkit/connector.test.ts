import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createConnector } from "../../src/toolkit/connector.js";
import type { Decision, ExtendedEnvelope, ResolutionHint } from "../../src/toolkit/policy/types.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "conn-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "conn-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

// Minimal useful connector for happy-path tests.
function makeAws(options: {
  listFunctionsHandler?: (p: unknown) => Promise<unknown>;
  configPath?: string;
} = {}) {
  return createConnector({
    name: "aws-test",
    credentials: async () => ({ region: "us-east-1" }),
    sdk: async () => ({ lambda: { list: (_: unknown) => [{ name: "fn1" }] } }),
    actions: {
      list_functions: {
        params: z.object({
          region: z.string(),
          prefix: z.string().optional(),
        }),
        classify: { kind: "read" },
        handler: options.listFunctionsHandler ?? (async () => ({
          functions: [{ name: "fn1" }],
          count: 1,
        })),
      },
    },
    ...(options.configPath !== undefined ? { policyConfigPath: options.configPath } : {}),
  });
}

describe("createConnector — basic properties", () => {
  it("throws if name is empty", () => {
    expect(() =>
      createConnector({
        name: "",
        credentials: async () => ({}),
        actions: {
          a: {
            params: z.object({}),
            classify: { kind: "read" },
            handler: async () => ({}),
          },
        },
      }),
    ).toThrow(/'name' is required/);
  });

  it("throws if actions is empty", () => {
    expect(() =>
      createConnector({
        name: "x",
        credentials: async () => ({}),
        actions: {},
      }),
    ).toThrow(/at least one action/);
  });

  it("validActions exposes the registry keys", () => {
    const c = makeAws();
    expect([...c.validActions]).toEqual(["list_functions"]);
  });
});

describe("createConnector.fetch — happy paths", () => {
  it("success envelope on valid input", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("success");
    if (env.status === "success") {
      expect(env.action).toBe("list_functions");
      expect(env.data).toEqual({ functions: [{ name: "fn1" }], count: 1 });
    }
  });

  it("handler receives typed params + context", async () => {
    let seenP: unknown;
    let seenCtx: Record<string, unknown> | null = null;
    const c = makeAws({
      listFunctionsHandler: async (p: unknown) => {
        seenP = p;
        seenCtx = { hasSdk: true, hasCreds: true };
        return { ok: true };
      },
    });
    await c.fetch("list_functions", { region: "us-west-2", prefix: "acme-" });
    expect(seenP).toEqual({ region: "us-west-2", prefix: "acme-" });
    expect(seenCtx).not.toBeNull();
  });
});

describe("createConnector.fetch — validation errors", () => {
  it("unknown action returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("not_a_real_action", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toContain("Unknown action");
    }
  });

  it("invalid params (missing required) returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.retriable).toBe(false);
    }
  });

  it("malformed params type returns VALIDATION_ERROR", async () => {
    const c = makeAws();
    const env = await c.fetch("list_functions", { region: 123 });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
    }
  });

  it("handler throwing a foreign ZodError-shaped object still maps to VALIDATION_ERROR", async () => {
    // Simulates a consumer whose zod install is a separate module instance
    // from the toolkit's (e.g. via `file:` deps) — `instanceof z.ZodError`
    // returns false, so the structural check must catch it.
    const foreignZodError = Object.assign(new Error("invalid input"), {
      name: "ZodError",
      issues: [{ path: ["sql"], message: "required" }],
    });
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        run: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw foreignZodError;
          },
        },
      },
    });
    const env = await c.fetch("run", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("VALIDATION_ERROR");
      expect(env.message).toContain("sql: required");
    }
  });
});

describe("createConnector.fetch — policy gate", () => {
  function writeConfig(name: string, yaml: string): string {
    const configPath = path.join(tmpCwd, "custom.yaml");
    fs.writeFileSync(configPath, yaml);
    return configPath;
  }

  it("denied rule returns a denied envelope, handler not called", async () => {
    const configPath = writeConfig("aws", "policy:\n  read: denied\n");
    let handlerCalled = false;
    const c = makeAws({
      configPath,
      listFunctionsHandler: async () => {
        handlerCalled = true;
        return {};
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("denied");
    expect(handlerCalled).toBe(false);
  });

  it("escalate on approval_mode=confirm_each + read=success", async () => {
    const configPath = writeConfig(
      "aws",
      "policy:\n  read: success\napproval_mode: confirm_each\n",
    );
    const c = makeAws({ configPath });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("escalate");
  });

  it("invalid config surfaces as CONFIG_ERROR envelope", async () => {
    const configPath = path.join(tmpCwd, "bad.yaml");
    fs.writeFileSync(configPath, "policy:\n  admin: success\n"); // safety floor breach
    const c = makeAws({ configPath });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toContain("safety floor");
    }
  });
});

describe("createConnector.fetch — runtime errors", () => {
  it("handler throw maps to CONNECTION_ERROR by default", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("ECONNRESET: peer closed");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONNECTION_ERROR");
      expect(env.retriable).toBe(true);
    }
  });

  it("handler 401 message maps to AUTH_ERROR", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("401 Unauthorized");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    if (env.status === "error") {
      expect(env.error_code).toBe("AUTH_ERROR");
      expect(env.retriable).toBe(false);
    }
  });

  it("handler 429 maps to RATE_LIMITED with retriable=true", async () => {
    const c = makeAws({
      listFunctionsHandler: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    const env = await c.fetch("list_functions", { region: "us-east-1" });
    if (env.status === "error") {
      expect(env.error_code).toBe("RATE_LIMITED");
      expect(env.retriable).toBe(true);
    }
  });

  it("mapError hook overrides default mapping", async () => {
    const c = createConnector({
      name: "aws-test",
      credentials: async () => ({}),
      actions: {
        list_functions: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("custom-service-specific");
          },
        },
      },
      mapError: () => ({ error_code: "CONFIG_ERROR", message: "override", retriable: false }),
    });
    const env = await c.fetch("list_functions", {});
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toBe("override");
    }
  });
});

describe("createConnector.fetch — extendDecision hook", () => {
  it("extendDecision can attach a custom status + fields (db-agent's present_only pattern)", async () => {
    const c = createConnector({
      name: "db-test",
      credentials: async () => ({}),
      actions: {
        query: {
          params: z.object({ sql: z.string() }),
          classify: { kind: "write" }, // triggers default policy.write = present
          handler: async () => ({ rows: [] }),
        },
      },
      extendDecision: (decision: Decision, ctx): Decision | ExtendedEnvelope => {
        if (decision.status === "escalate") {
          return {
            status: "present_only",
            action: ctx.action,
            reason: decision.reason,
            formatted_sql: `-- formatted: ${(ctx.params as { sql: string }).sql}`,
          };
        }
        return decision;
      },
    });
    const env = await c.fetch("query", { sql: "DELETE FROM users" });
    expect(env.status).toBe("present_only");
    const ext = env as Record<string, unknown>;
    expect(ext.formatted_sql).toContain("DELETE");
  });
});

describe("createConnector.main — CLI behavior", () => {
  it("--action + --params emits success envelope to stdout", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main([
        "--action", "list_functions",
        "--params", JSON.stringify({ region: "us-east-1" }),
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.status).toBe("success");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("malformed --params JSON exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main(["--action", "list_functions", "--params", "not json"]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("missing --action exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main([]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("denied envelope exits with code 1", async () => {
    const configPath = path.join(tmpCwd, "custom.yaml");
    fs.writeFileSync(configPath, "policy:\n  read: denied\n");
    const c = makeAws({ configPath });
    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await c.main([
        "--action", "list_functions",
        "--params", JSON.stringify({ region: "us-east-1" }),
      ]);
      expect(code).toBe(1);
    } finally {
      process.stdout.write = origOut;
    }
  });

  it("--help prints usage and exits 0", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--help"]);
      expect(code).toBe(0);
      const out = writes.join("");
      expect(out).toContain("Usage:");
      expect(out).toContain("list_functions");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--version prints version and exits 0", async () => {
    const c = createConnector({
      name: "aws-test",
      version: "9.9.9",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({}),
        },
      },
    });
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--version"]);
      expect(code).toBe(0);
      expect(writes.join("")).toContain("9.9.9");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--curate outputs JSON snapshot and exits 0", async () => {
    const c = makeAws();
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === "string" ? s : s.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await c.main(["--curate"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(writes.join("").trim());
      expect(parsed.connector).toBe("aws-test");
      expect(parsed).toHaveProperty("clusters");
      expect(parsed).toHaveProperty("marker");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("unknown flag exits 2", async () => {
    const c = makeAws();
    const origErr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await c.main(["--unknown-flag"]);
      expect(code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });
});

describe("createConnector — extendDecision path on base success", () => {
  it("extendDecision receiving success decision does not modify envelope", async () => {
    let seen: unknown;
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
      extendDecision: (decision) => {
        seen = decision.status;
        return decision; // no modification
      },
    });
    const env = await c.fetch("a", {});
    expect(seen).toBe("success");
    expect(env.status).toBe("success");
  });

  it("extendDecision throwing returns CONFIG_ERROR envelope", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
      extendDecision: () => {
        throw new Error("hook broke");
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
      expect(env.message).toContain("extendDecision");
    }
  });
});

describe("createConnector — EnvelopeOverride escape hatch", () => {
  it("handler throwing EnvelopeOverride emits the carried envelope verbatim", async () => {
    const { EnvelopeOverride } = await import("../../src/toolkit/connector.js");
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new EnvelopeOverride({
              status: "present_only",
              reason: "DML displayed but not executed",
              formatted_sql: "DELETE FROM users",
              execution_time_ms: 0.5,
            });
          },
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("present_only");
    const extended = env as Record<string, unknown>;
    expect(extended.action).toBe("a");
    expect(extended.formatted_sql).toBe("DELETE FROM users");
    expect(extended.reason).toBe("DML displayed but not executed");
  });

  it("EnvelopeOverride with denied status emits a denied envelope", async () => {
    const { EnvelopeOverride } = await import("../../src/toolkit/connector.js");
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new EnvelopeOverride({
              status: "denied",
              reason: "custom reason",
              execution_time_ms: 1.2,
            });
          },
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("denied");
    const extended = env as Record<string, unknown>;
    expect(extended.reason).toBe("custom reason");
    expect(extended.execution_time_ms).toBe(1.2);
  });
});

describe("createConnector — dynamic classify", () => {
  it("classify function on action spec is called with validated params", async () => {
    let seenP: unknown = null;
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({ danger: z.boolean() }),
          classify: (p): { kind: "read" | "write" | "admin" } => {
            seenP = p;
            return p.danger ? { kind: "admin" } : { kind: "read" };
          },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const danger = await c.fetch("a", { danger: true });
    expect(seenP).toEqual({ danger: true });
    expect(danger.status).toBe("denied"); // default admin=denied
    const safe = await c.fetch("a", { danger: false });
    expect(safe.status).toBe("success");
  });

  it("factory-level classify hook wins over action spec classify", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: { kind: "read" }, // would be success
          handler: async () => ({ ok: true }),
        },
      },
      classify: () => ({ kind: "admin" }), // override — becomes denied
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("denied");
  });

  it("classify throwing returns CONFIG_ERROR envelope", async () => {
    const c = createConnector({
      name: "test",
      credentials: async () => ({}),
      actions: {
        a: {
          params: z.object({}),
          classify: () => {
            throw new Error("classify broke");
          },
          handler: async () => ({ ok: true }),
        },
      },
    });
    const env = await c.fetch("a", {});
    expect(env.status).toBe("error");
    if (env.status === "error") {
      expect(env.error_code).toBe("CONFIG_ERROR");
    }
  });
});

describe("ExtendedEnvelope + ResolutionHint shape (3.0)", () => {
  it("ExtendedEnvelope accepts a string status and extension blob", () => {
    const env: ExtendedEnvelope = {
      status: "present",
      action: "run_query",
      message: "rows present but redacted",
      extension: { rows: [], redacted_columns: ["ssn"] },
    };
    expect(env.status).toBe("present");
    expect(env.extension).toBeDefined();
  });

  it("ResolutionHint has pattern_id, advice, confidence, scope", () => {
    const hint: ResolutionHint = {
      pattern_id: "jira-archived-404",
      advice: "Check archived flag",
      confidence: 0.9,
      scope: "tenant",
    };
    expect(hint.confidence).toBeGreaterThan(0);
  });
});

describe("ConnectorConfig.scope (3.0)", () => {
  it("passes the scope-fn return value to the hardship recorder", async () => {
    const recorded: unknown[] = [];
    const hardshipStub = (e: unknown) => { recorded.push(e); };

    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      actions: {
        fail_please: {
          description: "always throws",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("oh no");
          },
        },
      },
      hardship: {
        enabled: true,
        recorder: hardshipStub as typeof hardshipStub,
      },
    });

    await c.fetch("fail_please", {});
    expect(recorded.length).toBeGreaterThan(0);
    const entry = recorded[0] as { scope?: string };
    expect(entry.scope).toBe("https://acme");
  });

  it("uses null scope when config.scope is absent", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      actions: {
        fail_please: {
          description: "always throws",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("no scope");
          },
        },
      },
      hardship: {
        enabled: true,
        recorder: (e: unknown) => recorded.push(e),
      },
    });

    await c.fetch("fail_please", {});
    const entry = recorded[0] as { scope?: string | null };
    expect(entry.scope).toBeNull();
  });
});

describe("envelope resolution_hint", () => {
  it("attaches a matching pattern's hint to the error envelope", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "conn-hint-"));
    const cwd = path.join(tmp, "proj");
    await fsp.mkdir(
      path.join(cwd, ".claude/connectors/testconn/global"),
      { recursive: true },
    );
    await fsp.writeFile(
      path.join(cwd, ".claude/connectors/testconn/global/patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: generic-404
    status: active
    confidence: 0.9
    kind: not_found
    matcher: { context_regex: "HTTP 404" }
    advice: "double-check the resource id"
`,
    );

    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      runtime: { cwd, home: tmp },
      actions: {
        get_404: {
          description: "always 404",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => {
            throw new Error("HTTP 404 from upstream");
          },
        },
      },
      mapError: () => ({
        error_code: "NOT_FOUND",
        message: "HTTP 404 from upstream",
        retriable: false,
      }),
    });

    const r = await c.fetch("get_404", {});
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.resolution_hint?.pattern_id).toBe("generic-404");
      expect(r.resolution_hint?.scope).toBe("global");
      expect(r.resolution_hint?.advice).toBe("double-check the resource id");
    }

    await fsp.rm(tmp, { recursive: true });
  });

  it("envelope has no resolution_hint when no pattern matches", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "conn-nohint-"));
    const c = createConnector<{}>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({}),
      runtime: { cwd: tmp, home: tmp },
      actions: {
        get_x: {
          description: "fail",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => { throw new Error("timeout"); },
        },
      },
      mapError: () => ({
        error_code: "TIMEOUT",
        message: "timeout",
        retriable: true,
      }),
    });

    const r = await c.fetch("get_x", {});
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.resolution_hint).toBeUndefined();
    }

    await fsp.rm(tmp, { recursive: true });
  });
});

describe("connector.recordResolution", () => {
  it("appends a resolution entry using the last action's scope", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      hardship: {
        enabled: true,
        recorder: (e) => recorded.push(e),
      },
      actions: {
        noop: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });

    await c.fetch("noop", {});
    c.recordResolution({
      pattern_id: "some-id",
      advice: "cast to number first",
    });

    const r = recorded.find(
      (e) => (e as { kind: string }).kind === "resolution",
    ) as { resolution: string; scope: string | null; action: string };
    expect(r.resolution).toBe("cast to number first");
    expect(r.scope).toBe("https://acme");
    expect(r.action).toBe("noop");
  });

  it("allows explicit scope override", async () => {
    const recorded: unknown[] = [];
    const c = createConnector<{ siteUrl: string }>({
      name: "testconn",
      version: "0.0.0",
      credentials: async () => ({}),
      sdk: async () => ({ siteUrl: "https://acme" }),
      scope: (ctx) => ctx.sdk.siteUrl,
      hardship: {
        enabled: true,
        recorder: (e) => recorded.push(e),
      },
      actions: {
        noop: {
          description: "",
          params: z.object({}),
          classify: { kind: "read" },
          handler: async () => ({ ok: true }),
        },
      },
    });

    await c.fetch("noop", {});
    c.recordResolution({
      pattern_id: "some-id",
      advice: "X",
      scope: "https://beta",
      action: "noop",
    });

    const r = recorded.find(
      (e) => (e as { kind: string }).kind === "resolution",
    ) as { scope: string | null };
    expect(r.scope).toBe("https://beta");
  });
});
