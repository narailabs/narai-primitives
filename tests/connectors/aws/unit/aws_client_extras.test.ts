/**
 * Coverage extras for aws_client.ts — targets:
 *  - loadAwsCredentialsOverride() (whole fn) via mocked resolveSecret
 *  - _throttle() rate-limit branch
 *  - describeTable() (entire method)
 *  - getMetricStatistics() (entire method)
 *  - classifyAwsError() error-name branches (NotFound, Unauthorized, Throttl,
 *    default, and the non-object guard)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwsClient,
  type AwsClientOptions,
  type AwsSdkFactories,
  loadAwsCredentialsOverride,
} from "../../../../src/connectors/aws/lib/aws_client.js";

vi.mock("@narai/credential-providers", () => ({
  resolveSecret: vi.fn(async () => null),
}));
import { resolveSecret } from "@narai/credential-providers";

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

describe("AwsClient — describeTable", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards the table name as TableName and returns the response", async () => {
    let sent: Record<string, unknown> | null = null;
    const client = makeClient(
      makeFactories({
        dynamodb: async (cmd) => {
          sent = cmd;
          return {
            Table: {
              TableName: "Users",
              TableStatus: "ACTIVE",
              KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
              ItemCount: 7,
              TableSizeBytes: 1024,
            },
          };
        },
      }),
    );
    const r = await client.describeTable("Users");
    expect(sent?.["__name__"]).toBe("DescribeTableCommand");
    expect(sent?.["TableName"]).toBe("Users");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.Table?.TableName).toBe("Users");
  });

  it("returns SDK_UNAVAILABLE when no dynamodb factory is registered", async () => {
    const client = makeClient({});
    const r = await client.describeTable("X");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SDK_UNAVAILABLE");
  });
});

describe("AwsClient — getMetricStatistics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards namespace + metric + period and returns datapoints", async () => {
    let sent: Record<string, unknown> | null = null;
    const client = makeClient(
      makeFactories({
        cloudwatch: async (cmd) => {
          sent = cmd;
          return {
            Datapoints: [
              { Timestamp: new Date("2026-04-01"), Average: 0.5, Maximum: 1 },
            ],
          };
        },
      }),
    );
    const r = await client.getMetricStatistics({
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: "i-1" }],
      StartTime: new Date("2026-04-01T00:00:00Z"),
      EndTime: new Date("2026-04-02T00:00:00Z"),
      Period: 300,
      Statistics: ["Average", "Maximum"],
    });
    expect(sent?.["__name__"]).toBe("GetMetricStatisticsCommand");
    expect(sent?.["Namespace"]).toBe("AWS/EC2");
    expect(sent?.["MetricName"]).toBe("CPUUtilization");
    expect(sent?.["Period"]).toBe(300);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.Datapoints?.length).toBe(1);
  });

  it("returns SDK_UNAVAILABLE when no cloudwatch factory is registered", async () => {
    const client = makeClient({});
    const r = await client.getMetricStatistics({
      Namespace: "AWS/EC2",
      MetricName: "x",
      StartTime: new Date(),
      EndTime: new Date(),
      Period: 60,
      Statistics: ["Sum"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SDK_UNAVAILABLE");
  });
});

describe("AwsClient.send — classifyAwsError branches", () => {
  afterEach(() => vi.restoreAllMocks());

  it("classifies an error whose name matches /NotFound/ as NOT_FOUND", async () => {
    const err = new Error("missing");
    err.name = "ResourceNotFoundException";
    const client = makeClient(
      makeFactories({
        dynamodb: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listTables();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NOT_FOUND");
      expect(r.retriable).toBe(false);
    }
  });

  it("classifies an error whose name matches /NoSuch/ as NOT_FOUND", async () => {
    const err = new Error("missing");
    err.name = "NoSuchBucket";
    const client = makeClient(
      makeFactories({
        s3: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listBuckets();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });

  it("classifies /Unauthorized/ name as AUTH_ERROR", async () => {
    const err = new Error("nope");
    err.name = "UnauthorizedOperation";
    const client = makeClient(
      makeFactories({
        rds: async () => {
          throw err;
        },
      }),
    );
    const r = await client.describeDBInstances();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_ERROR");
  });

  it("classifies /InvalidSignature/ name as AUTH_ERROR", async () => {
    const err = new Error("bad sig");
    err.name = "InvalidSignatureException";
    const client = makeClient(
      makeFactories({
        s3: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listBuckets();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_ERROR");
  });

  it("classifies /Credentials/ name as AUTH_ERROR", async () => {
    const err = new Error("missing");
    err.name = "CredentialsProviderError";
    const client = makeClient(
      makeFactories({
        lambda: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listLambdaFunctions();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_ERROR");
  });

  it("classifies /Throttl/ name as RATE_LIMITED + retriable=true when message matches /Throttl/", async () => {
    const err = new Error("ThrottlingException: slow down");
    err.name = "ThrottlingException";
    const client = makeClient(
      makeFactories({
        dynamodb: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listTables();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("RATE_LIMITED");
      // retriable is keyed off message text "Throttl|timeout|ECONNRESET"
      expect(r.retriable).toBe(true);
    }
  });

  it("classifies /Rate/ name as RATE_LIMITED", async () => {
    const err = new Error("slow");
    err.name = "RateExceeded";
    const client = makeClient(
      makeFactories({
        dynamodb: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listTables();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RATE_LIMITED");
  });

  it("falls back to SDK_ERROR for unknown error names", async () => {
    const err = new Error("weird");
    err.name = "CompletelyUnknownError";
    const client = makeClient(
      makeFactories({
        rds: async () => {
          throw err;
        },
      }),
    );
    const r = await client.describeDBInstances();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SDK_ERROR");
      expect(r.retriable).toBe(false);
    }
  });

  it("falls back to SDK_ERROR when the thrown value is not an object (string)", async () => {
    const client = makeClient(
      makeFactories({
        rds: async () => {
          // Throw a non-Error / non-object value to exercise the
          // `err && typeof err === 'object'` guard in classifyAwsError.
          throw "plain string error";
        },
      }),
    );
    const r = await client.describeDBInstances();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SDK_ERROR");
      expect(r.message).toBe("plain string error");
    }
  });

  it("marks errors whose message contains ECONNRESET as retriable", async () => {
    const err = new Error("socket ECONNRESET while reading");
    err.name = "NetworkingError";
    const client = makeClient(
      makeFactories({
        dynamodb: async () => {
          throw err;
        },
      }),
    );
    const r = await client.listTables();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SDK_ERROR");
      expect(r.retriable).toBe(true);
    }
  });
});

describe("AwsClient — _throttle() rate-limit branch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sleeps when in-window request count reaches the limit", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const client = makeClient(
        makeFactories({
          dynamodb: async () => ({ TableNames: [] }),
        }),
        {
          rateLimitPerMin: 2,
          sleepImpl: async (ms) => {
            sleeps.push(ms);
            now += ms; // advance the mocked clock
          },
        },
      );
      await client.listTables();
      await client.listTables();
      await client.listTables();
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
      // First sleep must be the throttle wait (>0), not a retry sleep.
      expect(sleeps[0]).toBeGreaterThan(0);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("loadAwsCredentialsOverride()", () => {
  beforeEach(() => {
    vi.mocked(resolveSecret).mockReset();
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns null when neither env nor secret is present", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    const r = await loadAwsCredentialsOverride();
    expect(r).toBeNull();
  });

  it("returns null when only access key is present (secret missing)", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA-test";
    const r = await loadAwsCredentialsOverride();
    expect(r).toBeNull();
  });

  it("returns null when only secret key is present (access missing)", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["AWS_SECRET_ACCESS_KEY"] = "shh";
    const r = await loadAwsCredentialsOverride();
    expect(r).toBeNull();
  });

  it("returns both creds from env vars when secrets are absent", async () => {
    vi.mocked(resolveSecret).mockResolvedValue(null);
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA-env";
    process.env["AWS_SECRET_ACCESS_KEY"] = "env-secret";
    const r = await loadAwsCredentialsOverride();
    expect(r).toEqual({
      accessKeyId: "AKIA-env",
      secretAccessKey: "env-secret",
    });
  });

  it("prefers resolveSecret values when both env + secret are present", async () => {
    vi.mocked(resolveSecret).mockImplementation(async (key: string) => {
      if (key === "AWS_ACCESS_KEY_ID") return "AKIA-secret";
      if (key === "AWS_SECRET_ACCESS_KEY") return "secret-shh";
      return null;
    });
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA-env";
    process.env["AWS_SECRET_ACCESS_KEY"] = "env-secret";
    const r = await loadAwsCredentialsOverride();
    expect(r).toEqual({
      accessKeyId: "AKIA-secret",
      secretAccessKey: "secret-shh",
    });
  });
});

describe("AwsClient.init — STS uses real GetCallerIdentityCommand when present", () => {
  afterEach(() => vi.restoreAllMocks());

  it("init returns null Account when STS responds without an Account field", async () => {
    const client = makeClient(
      makeFactories({
        // Return an object that has no `Account` field — should leave
        // accountId null without throwing.
        sts: async () => ({}),
      }),
    );
    await client.init();
    expect(client.accountId).toBeNull();
  });
});
