/**
 * Tests for the GCP connector built on `@narai/connector-toolkit`.
 *
 * Child-process execution is mocked via an injected `runner` so no real
 * gcloud/bq binary is required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGcpConnector } from "../../../../src/connectors/gcp/index.js";
import {
  GcpClient,
  type GcpClientOptions,
} from "../../../../src/connectors/gcp/lib/gcp_client.js";

type RunnerCall = { file: string; args: string[] };

function makeClient(
  stdout: string | ((call: RunnerCall) => string),
  overrides: Partial<GcpClientOptions> = {},
): GcpClient {
  const calls: RunnerCall[] = [];
  const runner = ((file: string, args: string[]) => {
    const call: RunnerCall = { file, args };
    calls.push(call);
    return typeof stdout === "function" ? stdout(call) : stdout;
  }) as GcpClientOptions["runner"];
  const client = new GcpClient({
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    runner,
    sleepImpl: async () => {},
    ...overrides,
  });
  (client as unknown as { _calls: RunnerCall[] })._calls = calls;
  return client;
}

function callsOf(client: GcpClient): RunnerCall[] {
  return (client as unknown as { _calls: RunnerCall[] })._calls;
}

function makeConnector(client: GcpClient) {
  return buildGcpConnector({
    sdk: async () => client,
    credentials: async () => ({}),
  });
}

describe("GcpClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects invalid project IDs", async () => {
    const client = makeClient("[]");
    const r = await client.listServices("Invalid-PROJECT");
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "INVALID_PROJECT" }),
    );
  });

  it("lists services with correct gcloud args", async () => {
    const client = makeClient('[{"name": "run.googleapis.com"}]');
    const r = await client.listServices("acme-prod-123");
    expect(r.ok).toBe(true);
    const call = callsOf(client)[0];
    expect(call?.file).toBe("gcloud");
    expect(call?.args).toEqual([
      "services",
      "list",
      "--project",
      "acme-prod-123",
      "--enabled",
      "--format=json",
    ]);
  });

  it("describes SQL instance", async () => {
    const client = makeClient(
      JSON.stringify({
        name: "main-pg",
        databaseVersion: "POSTGRES_15",
        settings: { tier: "db-n1-standard-1" },
        region: "us-central1",
        state: "RUNNABLE",
      }),
    );
    const r = await client.describeSqlInstance("acme-prod-123", "main-pg");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.databaseVersion).toBe("POSTGRES_15");
  });

  it("blocks semicolons in log filter", async () => {
    const client = makeClient("[]");
    const r = await client.queryLogs("acme-prod-123", "severity=ERROR;rm -rf", 1, 1);
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "INVALID_FILTER" }),
    );
  });

  it("bq query rejects non-SELECT SQL", async () => {
    const client = makeClient("[]");
    const r = await client.bqQuery("acme-prod-123", "DROP TABLE foo", 10);
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "WRITE_FORBIDDEN" }),
    );
  });

  it("bq query passes SELECT through with read-only flags", async () => {
    const client = makeClient("[]");
    await client.bqQuery("acme-prod-123", "SELECT * FROM t LIMIT 1", 10);
    const call = callsOf(client)[0];
    expect(call?.file).toBe("bq");
    expect(call?.args).toContain("--use_legacy_sql=false");
    expect(call?.args).toContain("--project_id=acme-prod-123");
  });

  it("bq query rejects multi-statement scripts that chain DROP after SELECT", async () => {
    const client = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 1; DROP TABLE x",
      10,
    );
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "WRITE_FORBIDDEN" }),
    );
    expect(callsOf(client).length).toBe(0);
  });

  it("bq query permits a single trailing semicolon", async () => {
    const client = makeClient("[]");
    const r = await client.bqQuery("acme-prod-123", "SELECT 1;", 10);
    expect(r.ok).toBe(true);
  });

  it("bq query permits semicolons inside string literals", async () => {
    const client = makeClient("[]");
    const r = await client.bqQuery(
      "acme-prod-123",
      "SELECT 'a;b' AS v",
      10,
    );
    expect(r.ok).toBe(true);
  });
});

describe("gcp connector — fetch()", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("exposes validActions", () => {
    const c = buildGcpConnector();
    expect([...c.validActions].sort()).toEqual([
      "describe_db",
      "list_services",
      "list_topics",
      "query_logs",
    ]);
  });

  it("validates project_id format", async () => {
    const c = makeConnector(makeClient("[]"));
    const r = await c.fetch("list_services", { project_id: "BAD" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("uses injected client and shapes services response", async () => {
    const client = makeClient(
      '[{"name": "run.googleapis.com", "config": {"title": "Cloud Run"}, "state": "ENABLED"}]',
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_services", { project_id: "acme-prod-123" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["service_count"]).toBe(1);
    }
  });

  it("describe_db splits engine/version from databaseVersion", async () => {
    const client = makeClient(
      JSON.stringify({
        databaseVersion: "MYSQL_8_0",
        settings: { tier: "db-n1-standard-2" },
        region: "us-central1",
        state: "RUNNABLE",
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("describe_db", {
      project_id: "acme-prod-123",
      instance_id: "main-db",
      database: "primary",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["engine"]).toBe("mysql");
      expect(r.data["version"]).toBe("8");
    }
  });

  it("returns CONFIG_ERROR when gcloud missing (simulated)", async () => {
    const c = buildGcpConnector({
      sdk: async () => {
        const { GcpCliError } = await import("../../../../src/connectors/gcp/lib/gcp_error.js");
        throw new GcpCliError("GCLOUD_MISSING", "gcloud CLI not available on PATH", false);
      },
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_services", { project_id: "acme-prod-123" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
      expect(r.message).toContain("gcloud");
    }
  });

  it("envelope is wiki-agnostic — no mermaid field", async () => {
    const client = makeClient(
      '[{"name": "run.googleapis.com", "config": {"title": "Cloud Run"}, "state": "ENABLED"}]',
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_services", { project_id: "acme-prod-123" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["mermaid"]).toBeUndefined();
    }
  });
});

describe("GcpClient — defaults", () => {
  it("exposes defaultProjectId and defaultRegion when both configured", () => {
    const client = new GcpClient({
      defaultProjectId: "my-project",
      defaultRegion: "us-central1",
    });
    expect(client.defaultProjectId).toBe("my-project");
    expect(client.defaultRegion).toBe("us-central1");
  });

  it("returns null getters when nothing configured", () => {
    const client = new GcpClient();
    expect(client.defaultProjectId).toBeNull();
    expect(client.defaultRegion).toBeNull();
  });

  it("returns null for unset half when only one default is configured", () => {
    const projectOnly = new GcpClient({ defaultProjectId: "my-project" });
    expect(projectOnly.defaultProjectId).toBe("my-project");
    expect(projectOnly.defaultRegion).toBeNull();

    const regionOnly = new GcpClient({ defaultRegion: "us-central1" });
    expect(regionOnly.defaultProjectId).toBeNull();
    expect(regionOnly.defaultRegion).toBe("us-central1");
  });
});

describe("gcp connector — scope(ctx) formula", () => {
  // The scope callback itself isn't exposed on the Connector surface, so we
  // exercise it by replicating the exact expression used in buildGcpConnector.
  // The client-level getter tests above verify the inputs; this verifies the
  // composition rule.
  const scopeOf = (sdk: GcpClient): string | null =>
    sdk.defaultProjectId && sdk.defaultRegion
      ? `${sdk.defaultProjectId}/${sdk.defaultRegion}`
      : null;

  it("returns ${defaultProjectId}/${defaultRegion} when both defaults are set", () => {
    const client = new GcpClient({
      defaultProjectId: "my-project",
      defaultRegion: "us-central1",
    });
    expect(scopeOf(client)).toBe("my-project/us-central1");
  });

  it("returns null when neither default is set", () => {
    expect(scopeOf(new GcpClient())).toBeNull();
  });

  it("returns null when only defaultProjectId is set", () => {
    expect(scopeOf(new GcpClient({ defaultProjectId: "my-project" }))).toBeNull();
  });

  it("returns null when only defaultRegion is set", () => {
    expect(scopeOf(new GcpClient({ defaultRegion: "us-central1" }))).toBeNull();
  });
});
