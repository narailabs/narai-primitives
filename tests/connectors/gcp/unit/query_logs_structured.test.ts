/**
 * query_logs — structured filter path and entry projection.
 *
 * Covers: structured filters reaching gcloud as a single compiled argv
 * element (quotes and `>=` intact, no shell involved), the raw `filter`
 * string keeping its original strict sanitization, exactly-one-of
 * validation, and the projected entry shape (message fallback chain,
 * k8s labels, trace/logName/insertId, nulls for missing data).
 */
import { describe, expect, it } from "vitest";
import { buildGcpConnector } from "../../../../src/connectors/gcp/index.js";
import {
  GcpClient,
  type GcpClientOptions,
} from "../../../../src/connectors/gcp/lib/gcp_client.js";

type RunnerCall = { file: string; args: string[] };

function makeClient(stdout: string): { client: GcpClient; calls: RunnerCall[] } {
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

const K8S_ERROR_FILTER = {
  and: [
    { field: "resource.type", op: "=", value: "k8s_container" },
    { field: "resource.labels.namespace_name", op: "=", value: "orders-dev-app" },
    { field: "resource.labels.container_name", op: "=", value: "data-entry" },
    { field: "severity", op: ">=", value: "ERROR" },
  ],
};

describe("GcpClient.queryLogsStructured", () => {
  it("passes the compiled filter to gcloud as a single argv element", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogsStructured(
      "acme-prod-123",
      K8S_ERROR_FILTER,
      24,
      100,
    );
    expect(r.ok).toBe(true);
    const expected =
      'resource.type="k8s_container" AND ' +
      'resource.labels.namespace_name="orders-dev-app" AND ' +
      'resource.labels.container_name="data-entry" AND ' +
      'severity>="ERROR"';
    if (r.ok) expect(r.data.compiledFilter).toBe(expected);
    expect(calls[0]?.file).toBe("gcloud");
    expect(calls[0]?.args).toEqual([
      "logging",
      "read",
      expected,
      "--project",
      "acme-prod-123",
      "--limit",
      "100",
      "--freshness",
      "24h",
      "--format=json",
    ]);
  });

  it("does not trip UNSAFE_ARG on quotes and >= in the compiled filter", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogsStructured(
      "acme-prod-123",
      { field: "severity", op: ">=", value: "ERROR" },
      1,
      1,
    );
    expect(r.ok).toBe(true);
  });

  it("still validates flag positions — project id is checked first", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogsStructured(
      "BAD PROJECT",
      { field: "severity", op: ">=", value: "ERROR" },
      1,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PROJECT");
    expect(calls.length).toBe(0);
  });

  it("returns INVALID_FILTER for structurally invalid filters", async () => {
    const { client, calls } = makeClient("[]");
    const r = await client.queryLogsStructured(
      "acme-prod-123",
      { field: "severity OR x", op: "=", value: "ERROR" },
      1,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
    expect(calls.length).toBe(0);
  });

  it("rejects hours outside (0, 168] like the raw path", async () => {
    const { client } = makeClient("[]");
    const r = await client.queryLogsStructured(
      "acme-prod-123",
      { field: "severity", op: ">=", value: "ERROR" },
      0,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILTER");
  });
});

describe("query_logs action — structured filter", () => {
  it("accepts a structured_filter and echoes the compiled string", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        and: [
          { field: "resource.type", op: "=", value: "k8s_container" },
          { field: "textPayload", op: "contains", value: "connection refused" },
        ],
      },
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["filter"]).toBe(
        'resource.type="k8s_container" AND textPayload:"connection refused"',
      );
    }
    expect(calls[0]?.args[2]).toBe(
      'resource.type="k8s_container" AND textPayload:"connection refused"',
    );
  });

  it("compiles injection attempts in values to inert quoted data", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: {
        field: "textPayload",
        op: "=",
        value: '" OR severity>="DEBUG',
      },
    });
    expect(r.status).toBe("success");
    expect(calls[0]?.args[2]).toBe(
      'textPayload="\\" OR severity>=\\"DEBUG"',
    );
  });

  it("rejects params with both filter and structured_filter", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: "severity=ERROR",
      structured_filter: { field: "severity", op: ">=", value: "ERROR" },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("rejects params with neither filter nor structured_filter", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", { project_id: "acme-prod-123" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed structured_filter at the schema layer", async () => {
    const { client, calls } = makeClient("[]");
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: { field: "severity", op: ">", value: "ERROR" },
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
    expect(calls.length).toBe(0);
  });

  it("raw filter path keeps its original strict sanitization", async () => {
    const { client } = makeClient("[]");
    const c = makeConnector(client);
    const quoted = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: 'resource.type="k8s_container"',
    });
    expect(quoted.status).toBe("error");
    if (quoted.status === "error") {
      expect(quoted.error_code).toBe("VALIDATION_ERROR");
    }
    const plain = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      filter: "severity=ERROR",
    });
    expect(plain.status).toBe("success");
  });
});

describe("query_logs action — entry projection", () => {
  const K8S_ENTRY = {
    timestamp: "2026-07-01T12:00:00Z",
    severity: "ERROR",
    jsonPayload: { message: "NullPointerException at FreightAuditService" },
    resource: {
      type: "k8s_container",
      labels: {
        container_name: "data-entry",
        namespace_name: "orders-dev-app",
        pod_name: "data-entry-7d9f",
      },
    },
    trace: "projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef",
    logName: "projects/acme-prod-123/logs/stdout",
    insertId: "abc-123",
  };

  async function fetchEntries(stdout: string) {
    const { client } = makeClient(stdout);
    const c = makeConnector(client);
    const r = await c.fetch("query_logs", {
      project_id: "acme-prod-123",
      structured_filter: { field: "severity", op: ">=", value: "ERROR" },
    });
    expect(r.status).toBe("success");
    if (r.status !== "success") throw new Error("unreachable");
    return r.data["entries"] as Array<Record<string, unknown>>;
  }

  it("uses jsonPayload.message when textPayload is absent, and round-trips metadata", async () => {
    const [entry] = await fetchEntries(JSON.stringify([K8S_ENTRY]));
    expect(entry).toEqual({
      timestamp: "2026-07-01T12:00:00Z",
      severity: "ERROR",
      message: "NullPointerException at FreightAuditService",
      container: "data-entry",
      namespace: "orders-dev-app",
      pod: "data-entry-7d9f",
      trace_id: K8S_ENTRY.trace,
      log_name: K8S_ENTRY.logName,
      insert_id: "abc-123",
    });
  });

  it("prefers textPayload over jsonPayload.message", async () => {
    const [entry] = await fetchEntries(
      JSON.stringify([
        { timestamp: "t", textPayload: "text wins", jsonPayload: { message: "no" } },
      ]),
    );
    expect(entry?.["message"]).toBe("text wins");
  });

  it("falls back to stringified jsonPayload when it has no message field", async () => {
    const [entry] = await fetchEntries(
      JSON.stringify([{ jsonPayload: { level: "ERROR", code: 42 } }]),
    );
    expect(entry?.["message"]).toBe('{"level":"ERROR","code":42}');
  });

  it("truncates a huge stringified jsonPayload to ~2KB", async () => {
    const [entry] = await fetchEntries(
      JSON.stringify([{ jsonPayload: { blob: "x".repeat(5000) } }]),
    );
    const message = entry?.["message"] as string;
    expect(message.length).toBe(2049); // 2048 chars + ellipsis
    expect(message.endsWith("…")).toBe(true);
  });

  it("yields nulls (never omitted keys) for an entry missing everything", async () => {
    const [entry] = await fetchEntries("[{}]");
    expect(entry).toEqual({
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
