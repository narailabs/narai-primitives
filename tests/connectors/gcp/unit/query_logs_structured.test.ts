/**
 * query_logs expressiveness fixes — structured filter input, scoped
 * metachar blocklist for the logging-read filter positional, and the
 * richer backward-compatible entry projection.
 */
import { describe, expect, it } from "vitest";
import { buildGcpConnector } from "../../../../src/connectors/gcp/index.js";
import {
  GcpClient,
  type GcpClientOptions,
} from "../../../../src/connectors/gcp/lib/gcp_client.js";

type RunnerCall = { file: string; args: string[] };

function makeClient(
  stdout: string,
): { client: GcpClient; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner = ((file: string, args: string[]) => {
    calls.push({ file, args });
    return stdout;
  }) as GcpClientOptions["runner"];
  const client = new GcpClient({
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    runner,
    sleepImpl: async () => {},
  });
  return { client, calls };
}

function makeConnector(client: GcpClient) {
  return buildGcpConnector({
    sdk: async () => client,
    credentials: async () => ({}),
  });
}

describe("GcpClient.queryLogs — scoped blocklist on the filter positional", () => {
  it("passes a severity floor (>=) through as the filter positional", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      "resource.type=k8s_container AND severity>=ERROR",
      1,
      10,
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.file).toBe("gcloud");
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      "logging",
      "read",
      "resource.type=k8s_container AND severity>=ERROR",
    ]);
  });

  it("still rejects raw filters containing quotes (raw path unchanged)", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      'resource.type="k8s_container"',
      1,
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
    expect(calls.length).toBe(0);
  });

  it("still rejects raw filters containing semicolons", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      "severity=ERROR; rm -rf /",
      1,
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
    expect(calls.length).toBe(0);
  });

  it("accepts a precompiled filter containing double quotes", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogs(
      "acme-prod-123",
      'resource.type="k8s_container" AND severity>="ERROR"',
      1,
      10,
      { compiled: true },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.args[2]).toBe(
      'resource.type="k8s_container" AND severity>="ERROR"',
    );
  });

  it("still blocks metachars in flag positions of logging read", () => {
    const { client } = makeClient("[]");
    const result = (
      client as unknown as {
        _run: (b: string, s: string, a: string[]) => unknown;
      }
    )._run("gcloud", "logging read", [
      "severity>=ERROR",
      "--project",
      "acme;rm -rf /",
    ]);
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "UNSAFE_ARG" }),
    );
  });
});

describe("query_logs — structured filter input", () => {
  it("compiles structured_filter and returns the compiled filter string", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        and: [
          { field: "resource.type", op: "=", value: "k8s_container" },
          {
            field: "resource.labels.namespace_name",
            op: "=",
            value: "orders-dev-app",
          },
          { field: "severity", op: ">=", value: "ERROR" },
        ],
      },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["filter"]).toBe(
        'resource.type="k8s_container" AND ' +
          'resource.labels.namespace_name="orders-dev-app" AND ' +
          'severity>="ERROR"',
      );
    }
    expect(calls[0]?.args[2]).toBe(
      'resource.type="k8s_container" AND ' +
        'resource.labels.namespace_name="orders-dev-app" AND ' +
        'severity>="ERROR"',
    );
  });

  it("supports multi-word text search via structured_filter", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        field: "textPayload",
        op: "contains",
        value: "connection refused",
      },
    });
    expect(r.status).toBe("success");
    expect(calls[0]?.args[2]).toBe('textPayload:"connection refused"');
  });

  it("keeps injection values as quoted data end-to-end", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        field: "textPayload",
        op: ":",
        value: '" OR severity>="DEBUG',
      },
    });
    expect(r.status).toBe("success");
    expect(calls[0]?.args[2]).toBe('textPayload:"\\" OR severity>=\\"DEBUG"');
  });

  it("rejects a structured_filter with a disallowed op", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: { field: "severity", op: "=~", value: "ERROR" },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
    expect(calls.length).toBe(0);
  });

  it("rejects a structured_filter with an unsafe field name", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        field: 'severity="ERROR" OR x',
        op: "=",
        value: "y",
      },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
    expect(calls.length).toBe(0);
  });

  it("requires exactly one of filter / structured_filter — neither", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", { project_id: "acme-prod-123" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("requires exactly one of filter / structured_filter — both", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: "severity=ERROR",
      structured_filter: { field: "severity", op: "=", value: "ERROR" },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("raw string filter keeps its strict sanitization", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: 'resource.type="k8s_container"',
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });
});

describe("query_logs — entry projection", () => {
  const fullEntry = {
    timestamp: "2026-07-01T12:00:00Z",
    severity: "ERROR",
    jsonPayload: { message: "boom from json", level: "ERROR" },
    resource: {
      type: "k8s_container",
      labels: {
        container_name: "data-entry",
        namespace_name: "orders-dev-app",
        pod_name: "data-entry-7f9c",
      },
    },
    trace: "projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef",
    logName: "projects/acme-prod-123/logs/stdout",
    insertId: "abc123",
  };

  async function fetchEntries(entries: unknown[]) {
    const { client } = makeClient(JSON.stringify(entries));
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: "severity=ERROR",
    });
    expect(r.status).toBe("success");
    if (r.status !== "success") throw new Error("unreachable");
    return r.data["entries"] as Array<Record<string, unknown>>;
  }

  it("falls back to jsonPayload.message when textPayload is absent", async () => {
    const [e] = await fetchEntries([fullEntry]);
    expect(e?.["message"]).toBe("boom from json");
  });

  it("round-trips labels, trace, logName, insertId", async () => {
    const [e] = await fetchEntries([fullEntry]);
    expect(e?.["container"]).toBe("data-entry");
    expect(e?.["namespace"]).toBe("orders-dev-app");
    expect(e?.["pod"]).toBe("data-entry-7f9c");
    expect(e?.["trace_id"]).toBe(
      "projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef",
    );
    expect(e?.["log_name"]).toBe("projects/acme-prod-123/logs/stdout");
    expect(e?.["insert_id"]).toBe("abc123");
  });

  it("prefers textPayload over jsonPayload.message", async () => {
    const [e] = await fetchEntries([
      { ...fullEntry, textPayload: "boom from text" },
    ]);
    expect(e?.["message"]).toBe("boom from text");
  });

  it("stringifies jsonPayload without a message field, truncated to ~2KB", async () => {
    const big = { data: "x".repeat(4000) };
    const [e] = await fetchEntries([
      { timestamp: "2026-07-01T12:00:00Z", severity: "INFO", jsonPayload: big },
    ]);
    const msg = e?.["message"] as string;
    expect(msg.startsWith('{"data":"xxx')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual(2048);
  });

  it("yields nulls (never omitted keys) for an entry missing everything", async () => {
    const [e] = await fetchEntries([{}]);
    expect(e).toEqual({
      timestamp: null,
      severity: "",
      message: null,
      container: null,
      namespace: null,
      pod: null,
      trace_id: null,
      log_name: null,
      insert_id: null,
    });
  });
});
