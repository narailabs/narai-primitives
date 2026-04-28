/**
 * Unit tests for the AWS connector built on `@narai/connector-toolkit`.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { buildAwsConnector } from "../../../../src/connectors/aws/index.js";
import {
  AwsClient,
  type AwsClientOptions,
  type AwsSdkFactories,
} from "../../../../src/connectors/aws/lib/aws_client.js";

type SendHandler = (cmd: Record<string, unknown>) => Promise<unknown>;

function makeFactories(
  handlers: Partial<Record<keyof AwsSdkFactories, SendHandler>>,
): AwsSdkFactories {
  const factories: AwsSdkFactories = {};
  for (const [key, handler] of Object.entries(handlers) as Array<
    [keyof AwsSdkFactories, SendHandler]
  >) {
    factories[key] = () => ({
      send: async (cmd) => handler(cmd as Record<string, unknown>),
    });
  }
  return factories;
}

function makeClient(
  factories: AwsSdkFactories,
  overrides: Partial<AwsClientOptions> = {},
): AwsClient {
  return new AwsClient({
    region: "us-east-1",
    factories,
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    sleepImpl: async () => {},
    ...overrides,
  });
}

function makeConnector(client: AwsClient) {
  return buildAwsConnector({
    sdk: async () => client,
    credentials: async () => ({}),
  });
}

describe("AwsClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("whitelists command names and rejects others", async () => {
    const client = makeClient(
      makeFactories({ rds: async () => ({ DBInstances: [] }) }),
    );
    const r = await client.send("rds", {
      name: "DeleteDBInstanceCommand",
      input: {},
    });
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "METHOD_NOT_ALLOWED" }),
    );
  });

  it("returns SDK_UNAVAILABLE when factory missing", async () => {
    const client = makeClient({});
    const r = await client.listTables();
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "SDK_UNAVAILABLE" }),
    );
  });

  it("describes RDS instance through injected factory", async () => {
    let sent: Record<string, unknown> | null = null;
    const client = makeClient(
      makeFactories({
        rds: async (cmd) => {
          sent = cmd;
          return {
            DBInstances: [
              {
                DBInstanceIdentifier: "acme-rds",
                Engine: "postgres",
                EngineVersion: "15.3",
                DBInstanceClass: "db.t3.medium",
                DBInstanceStatus: "available",
                Endpoint: { Address: "acme-rds.us-east-1.rds" },
                AllocatedStorage: 100,
              },
            ],
          };
        },
      }),
    );
    const r = await client.describeDBInstances({
      DBInstanceIdentifier: "acme-rds",
    });
    expect(sent?.["__name__"]).toBe("DescribeDBInstancesCommand");
    expect(sent?.["DBInstanceIdentifier"]).toBe("acme-rds");
    expect(r.ok).toBe(true);
  });

  it("times out if the SDK call hangs", async () => {
    const client = makeClient(
      makeFactories({
        dynamodb: () =>
          new Promise<Record<string, unknown>>(() => {
            /* never resolves */
          }),
      }),
      { connectTimeoutMs: 5, readTimeoutMs: 5 },
    );
    const r = await client.listTables();
    expect(r).toEqual(
      expect.objectContaining({ ok: false, code: "TIMEOUT" }),
    );
  });

  it("init() caches accountId from STS GetCallerIdentity", async () => {
    const client = makeClient(
      makeFactories({
        sts: async () => ({ Account: "123456789012" }),
      }),
    );
    await client.init();
    expect(client.accountId).toBe("123456789012");
    expect(client.region).toBe("us-east-1");
  });

  it("init() leaves accountId null when no sts factory is registered", async () => {
    const client = makeClient({});
    await client.init();
    expect(client.accountId).toBeNull();
  });

  it("init() swallows STS errors and leaves accountId null", async () => {
    const client = makeClient(
      makeFactories({
        sts: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(client.init()).resolves.toBeUndefined();
    expect(client.accountId).toBeNull();
  });
});

describe("aws connector — fetch()", () => {
  it("exposes validActions", () => {
    const c = buildAwsConnector();
    expect([...c.validActions].sort()).toEqual([
      "describe_db",
      "get_metrics",
      "list_buckets",
      "list_functions",
    ]);
  });

  it("rejects invalid region", async () => {
    const c = makeConnector(makeClient({}));
    const r = await c.fetch("list_functions", { region: "Bad-Region" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("VALIDATION_ERROR");
  });

  it("describes db via injected client", async () => {
    const client = makeClient(
      makeFactories({
        rds: async () => ({
          DBInstances: [
            {
              DBInstanceIdentifier: "acme-rds",
              Engine: "mysql",
              EngineVersion: "8.0",
              DBInstanceClass: "db.t3.micro",
              DBInstanceStatus: "available",
              Endpoint: { Address: "acme.rds.local" },
              AllocatedStorage: 20,
            },
          ],
        }),
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("describe_db", {
      region: "us-east-1",
      db_identifier: "acme-rds",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["engine"]).toBe("mysql");
      expect(r.data["endpoint"]).toBe("acme.rds.local");
    }
  });

  it("list_buckets filters by prefix", async () => {
    const client = makeClient(
      makeFactories({
        s3: async () => ({
          Buckets: [
            { Name: "acme-logs", CreationDate: new Date("2026-01-01") },
            { Name: "other", CreationDate: new Date("2026-01-02") },
          ],
        }),
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_buckets", { prefix: "acme-" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["bucket_count"]).toBe(1);
    }
  });

  it("returns NOT_FOUND when DBInstances is empty", async () => {
    const client = makeClient(
      makeFactories({ rds: async () => ({ DBInstances: [] }) }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("describe_db", {
      region: "us-east-1",
      db_identifier: "missing",
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error_code).toBe("NOT_FOUND");
  });

  it("envelope is wiki-agnostic — no mermaid field", async () => {
    const client = makeClient(
      makeFactories({
        lambda: async () => ({
          Functions: [
            {
              FunctionName: "hello",
              Runtime: "nodejs20.x",
              LastModified: "2026-04-01",
            },
          ],
        }),
      }),
    );
    const c = makeConnector(client);
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.data["mermaid"]).toBeUndefined();
    }
  });

  it("returns CONFIG_ERROR when no SDK packages are installed", async () => {
    // Default production path — uses loadRealFactories(), which returns null
    // when no @aws-sdk/client-* packages are present. Since we do have one
    // installed (from devDeps of the test env), this might succeed; the
    // important check is that the error-code mapping path works when SDK is
    // missing. Build a connector with an sdk() that throws SDK_UNAVAILABLE
    // to simulate.
    const c = buildAwsConnector({
      sdk: async () => {
        const { AwsSdkError } = await import("../../../../src/connectors/aws/lib/aws_error.js");
        throw new AwsSdkError("SDK_UNAVAILABLE", "no sdk", false);
      },
      credentials: async () => ({}),
    });
    const r = await c.fetch("list_functions", { region: "us-east-1" });
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error_code).toBe("CONFIG_ERROR");
      expect(r.retriable).toBe(false);
    }
  });
});
