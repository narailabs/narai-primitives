/**
 * Coverage extras for src/connector.ts — drives the mapDbErrorCode and
 * translateOrThrow branches via the buildDbConnector dispatch override.
 */
import { describe, expect, it } from "vitest";
import type { FetchResult } from "../../../src/connectors/db/dispatcher.js";
import { buildDbConnector } from "../../../src/connectors/db/connector.js";

function makeConnector(result: FetchResult) {
  return buildDbConnector({
    dispatch: async () => result,
  });
}

describe("buildDbConnector — mapDbErrorCode (every internal code)", () => {
  const cases: Array<[string, string]> = [
    ["VALIDATION_ERROR", "VALIDATION_ERROR"],
    ["CONFIG_ERROR", "CONFIG_ERROR"],
    ["CONNECTION_ERROR", "CONNECTION_ERROR"],
    ["AUTH_ERROR", "AUTH_ERROR"],
    ["UNAUTHORIZED", "AUTH_ERROR"],
    ["NOT_FOUND", "NOT_FOUND"],
    ["TIMEOUT", "TIMEOUT"],
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["SCHEMA_ERROR", "CONNECTION_ERROR"],
    ["FOO_ERROR", "CONNECTION_ERROR"], // endsWith _ERROR → CONNECTION_ERROR
    ["WHATEVER", "CONNECTION_ERROR"], // unmatched → default
  ];

  it.each(cases)(
    "internal %s → external %s",
    async (internal, external) => {
      const c = makeConnector({
        status: "error",
        error_code: internal,
        error: `synthetic ${internal}`,
      });
      const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
      expect(r.status).toBe("error");
      if (r.status === "error") {
        expect(r.error_code).toBe(external);
        expect(r.message).toContain(`synthetic ${internal}`);
      }
    },
  );

  it("lowercase internal code is upper-cased before matching", async () => {
    const c = makeConnector({
      status: "error",
      error_code: "auth_error",
      error: "x",
    });
    const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("AUTH_ERROR");
  });

  it("missing error_code in dispatcher result falls back to CONNECTION_ERROR", async () => {
    const c = makeConnector({
      status: "error",
      error: "no code attached",
    } as FetchResult);
    const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONNECTION_ERROR");
      expect(r.message).toContain("no code attached");
    }
  });

  it("missing error message gets a generic per-action default", async () => {
    const c = makeConnector({
      status: "error",
      error_code: "TIMEOUT",
    } as FetchResult);
    const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.message).toMatch(/db-agent query failed/);
    }
  });
});

describe("buildDbConnector — translateOrThrow status branches", () => {
  it("ok status returns the data envelope (status stripped)", async () => {
    const c = makeConnector({
      status: "ok",
      rows: [{ id: 1 }],
      column_names: ["id"],
      row_count: 1,
    } as FetchResult);
    const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["rows"]).toEqual([{ id: 1 }]);
      expect(r.data["status"]).toBeUndefined();
    }
  });

  it("denied status surfaces as the denied envelope with reason", async () => {
    const c = makeConnector({
      status: "denied",
      reason: "DDL forbidden by policy",
    } as FetchResult);
    const r = await c.fetch("query", { sql: "DROP TABLE x", env: "dev" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.message).toBe("DDL forbidden by policy");
  });

  it("escalate status surfaces as the escalate envelope with reason", async () => {
    const c = makeConnector({
      status: "escalate",
      reason: "WRITE requires approval",
    } as FetchResult);
    const r = await c.fetch("query", { sql: "INSERT INTO x VALUES (1)", env: "dev" });
    expect(r.status).toBe("escalate");
    if (r.status === "escalate") expect(r.message).toBe("WRITE requires approval");
  });

  it("present_only status carries formatted_sql + execution_time_ms in extension", async () => {
    const c = makeConnector({
      status: "present_only",
      reason: "ADMIN: present only",
      formatted_sql: "GRANT SELECT ON T TO U;",
      execution_time_ms: 7,
    } as FetchResult);
    const r = await c.fetch("query", { sql: "GRANT SELECT", env: "dev" });
    expect(r.status).toBe("present_only");
    if (r.status === "present_only") {
      expect(r.message).toBe("ADMIN: present only");
      expect(r.extension?.["formatted_sql"]).toBe("GRANT SELECT ON T TO U;");
      expect(r.extension?.["execution_time_ms"]).toBe(7);
    }
  });

  it("present_only with non-string formatted_sql / non-number execution_time omits them", async () => {
    const c = makeConnector({
      status: "present_only",
      reason: "x",
      formatted_sql: 42,
      execution_time_ms: "fast",
    } as FetchResult);
    const r = await c.fetch("query", { sql: "GRANT SELECT", env: "dev" });
    expect(r.status).toBe("present_only");
    if (r.status === "present_only") {
      expect(r.extension?.["formatted_sql"]).toBeUndefined();
      expect(r.extension?.["execution_time_ms"]).toBeUndefined();
    }
  });

  it("denied with non-string reason omits message field", async () => {
    const c = makeConnector({
      status: "denied",
      reason: 12345,
    } as FetchResult);
    const r = await c.fetch("query", { sql: "DROP", env: "dev" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.message).toBeUndefined();
  });
});

describe("buildDbConnector — non-DbError pass-through", () => {
  it("unrecognized non-DbError throws bubble through with default mapping", async () => {
    const c = buildDbConnector({
      dispatch: async () => {
        throw new Error("plain runtime error");
      },
    });
    const r = await c.fetch("query", { sql: "SELECT 1", env: "dev" });
    // The toolkit's default error path applies — error_code is set; the exact
    // value depends on toolkit defaults, so just assert error envelope shape.
    expect(r.status).toBe("error");
  });
});
