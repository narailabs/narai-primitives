/**
 * @narai/aws-agent-connector — read-only AWS SDK v3 connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector`; `buildAwsConnector(overrides?)` is exposed for tests that
 * want to inject fake SDK factories.
 *
 * Optional dependencies: each `@aws-sdk/client-*` is loaded lazily via
 * dynamic import when the connector's `sdk` hook runs. Missing SDK
 * packages surface as `CONFIG_ERROR` envelopes (never crashes).
 */
import { createConnector, type Connector, type ErrorCode } from "narai-primitives/toolkit";
import { z } from "zod";
import {
  AwsClient,
  type AwsResult,
  type AwsSdkFactories,
} from "./lib/aws_client.js";
import { AwsSdkError } from "./lib/aws_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_METRIC_HOURS = 168;

const regionField = z
  .string()
  .regex(/^[a-z]{2}-[a-z]+-\d+$/, "Invalid region — expected format like us-east-1");

const listFunctionsParams = z.object({
  region: regionField,
  prefix: z.string().default(""),
});

const describeDbParams = z.object({
  region: regionField,
  db_identifier: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/,
      "Invalid db_identifier — must start with letter, alphanumeric and hyphens only",
    ),
});

const listBucketsParams = z.object({
  prefix: z.string().default(""),
  region: z.string().default("us-east-1"),
});

const getMetricsParams = z.object({
  region: regionField,
  namespace: z.string().min(1, "get_metrics requires a non-empty 'namespace'"),
  metric_name: z.string().min(1, "get_metrics requires a non-empty 'metric_name'"),
  dimensions: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .transform((d) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(d)) out[k] = String(v);
      return out;
    })
    .default({}),
  hours: z.coerce.number().int().positive().max(MAX_METRIC_HOURS).default(24),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  METHOD_NOT_ALLOWED: "VALIDATION_ERROR",
  SDK_UNAVAILABLE: "CONFIG_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  SDK_ERROR: "CONNECTION_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
};

function throwIfError<T>(
  result: AwsResult<T>,
): asserts result is Extract<AwsResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new AwsSdkError(result.code, result.message, result.retriable);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SDK factory loader — dynamic imports of optional `@aws-sdk/client-*` packages.
// ───────────────────────────────────────────────────────────────────────────

async function tryImport(name: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(name as string)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function loadRealFactories(): Promise<AwsSdkFactories | null> {
  const factories: AwsSdkFactories = {};
  const register = <K extends keyof AwsSdkFactories>(
    key: K,
    mod: Record<string, unknown> | null,
    exportName: string,
  ): void => {
    const exported = mod?.[exportName];
    if (typeof exported !== "function" || !mod) return;
    const Ctor = exported as new (config: unknown) => {
      send: (cmd: unknown) => Promise<unknown>;
    };
    // The real AWS SDK v3 client.send() expects a Command instance built by
    // the SDK module (it must carry resolveMiddleware()), not a plain object.
    // Translate the internal {__name__, ...input} shape used by aws_client
    // into a real Command at the boundary so production calls dispatch.
    factories[key] = (config) => {
      const client = new Ctor(config);
      return {
        send: async (cmd: unknown) => {
          // aws_client.send() passes {__name__, ...input}; init() may pass a
          // pre-built Command instance from the SDK module. Branch on the
          // marker to decide whether to construct or pass through.
          const wrapped = cmd as { __name__?: string } & Record<string, unknown>;
          const commandName = wrapped?.__name__;
          if (typeof commandName !== "string") {
            return client.send(cmd as never);
          }
          const CommandCtor = mod[commandName];
          if (typeof CommandCtor !== "function") {
            throw new Error(
              `AWS SDK send: ${commandName} not exported by SDK module`,
            );
          }
          const { __name__, ...input } = wrapped;
          const Command = CommandCtor as new (input: unknown) => unknown;
          return client.send(new Command(input));
        },
      };
    };
  };

  register("rds", await tryImport("@aws-sdk/client-rds"), "RDSClient");
  register("dynamodb", await tryImport("@aws-sdk/client-dynamodb"), "DynamoDBClient");
  register("s3", await tryImport("@aws-sdk/client-s3"), "S3Client");
  register("cloudwatch", await tryImport("@aws-sdk/client-cloudwatch"), "CloudWatchClient");
  register("lambda", await tryImport("@aws-sdk/client-lambda"), "LambdaClient");
  register("sts", await tryImport("@aws-sdk/client-sts"), "STSClient");

  return Object.keys(factories).length > 0 ? factories : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<AwsClient>;
  credentials?: () => Promise<Record<string, unknown>>;
  /** Override the default region. Individual actions can still override per-call. */
  defaultRegion?: string;
}

export function buildAwsConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    // AWS uses the default credential chain via the SDK; no explicit secret
    // load. Return an empty object so the factory's `credentials` step is
    // satisfied.
    return {};
  };

  const defaultSdk = async (): Promise<AwsClient> => {
    const factories = await loadRealFactories();
    if (!factories) {
      throw new AwsSdkError(
        "SDK_UNAVAILABLE",
        "AWS SDK clients not available. Install @aws-sdk/client-rds, " +
          "@aws-sdk/client-dynamodb, @aws-sdk/client-s3, @aws-sdk/client-cloudwatch, " +
          "@aws-sdk/client-lambda (as needed) and configure credentials via the " +
          "default AWS credential chain.",
        false,
      );
    }
    const client = new AwsClient({
      region: overrides.defaultRegion ?? "us-east-1",
      factories,
    });
    await client.init();
    return client;
  };

  return createConnector<AwsClient>({
    name: "aws",
    version: "3.0.0",
    scope: (ctx) =>
      ctx.sdk.accountId ? `${ctx.sdk.accountId}/${ctx.sdk.region}` : null,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    actions: {
      list_functions: {
        description: "List Lambda functions in a region",
        params: listFunctionsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listFunctionsParams>, ctx) => {
          const result = await ctx.sdk.listLambdaFunctions();
          throwIfError(result);
          const fns = result.data.Functions ?? [];
          const filtered = p.prefix
            ? fns.filter((f) => (f.FunctionName ?? "").startsWith(p.prefix))
            : fns;
          return {
            region: p.region,
            functions: filtered.map((f) => ({
              name: f.FunctionName ?? "",
              runtime: f.Runtime ?? "",
              last_modified: f.LastModified ?? null,
            })),
            function_count: filtered.length,
          };
        },
      },
      describe_db: {
        description: "Describe an RDS DB instance by identifier",
        params: describeDbParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof describeDbParams>, ctx) => {
          const result = await ctx.sdk.describeDBInstances({
            DBInstanceIdentifier: p.db_identifier,
          });
          throwIfError(result);
          const inst = (result.data.DBInstances ?? [])[0];
          if (!inst) {
            throw new AwsSdkError(
              "NOT_FOUND",
              `No instance found for identifier '${p.db_identifier}'`,
              false,
            );
          }
          return {
            region: p.region,
            db_identifier: inst.DBInstanceIdentifier ?? p.db_identifier,
            engine: inst.Engine ?? "",
            engine_version: inst.EngineVersion ?? "",
            instance_class: inst.DBInstanceClass ?? "",
            status: inst.DBInstanceStatus ?? "",
            endpoint: inst.Endpoint?.Address ?? "",
            storage_gb: inst.AllocatedStorage ?? 0,
          };
        },
      },
      list_buckets: {
        description: "List S3 buckets (optionally filtered by prefix)",
        params: listBucketsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listBucketsParams>, ctx) => {
          const result = await ctx.sdk.listBuckets();
          throwIfError(result);
          const buckets = result.data.Buckets ?? [];
          const filtered = p.prefix
            ? buckets.filter((b) => (b.Name ?? "").startsWith(p.prefix))
            : buckets;
          return {
            buckets: filtered.map((b) => ({
              name: b.Name ?? "",
              created_at: b.CreationDate
                ? b.CreationDate instanceof Date
                  ? b.CreationDate.toISOString()
                  : String(b.CreationDate)
                : null,
            })),
            bucket_count: filtered.length,
          };
        },
      },
      get_metrics: {
        description: "Get CloudWatch metric statistics for the last N hours",
        params: getMetricsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof getMetricsParams>, ctx) => {
          const endTime = new Date();
          const startTime = new Date(endTime.getTime() - p.hours * 3600_000);
          const result = await ctx.sdk.getMetricStatistics({
            Namespace: p.namespace,
            MetricName: p.metric_name,
            Dimensions: Object.entries(p.dimensions).map(([Name, Value]) => ({
              Name,
              Value,
            })),
            StartTime: startTime,
            EndTime: endTime,
            Period: 300,
            Statistics: ["Average", "Sum", "Maximum"],
          });
          throwIfError(result);
          const dps = result.data.Datapoints ?? [];
          return {
            region: p.region,
            namespace: p.namespace,
            metric_name: p.metric_name,
            dimensions: p.dimensions,
            hours: p.hours,
            datapoints: dps.map((d) => ({
              timestamp:
                d.Timestamp instanceof Date
                  ? d.Timestamp.toISOString()
                  : d.Timestamp ?? null,
              sum: d.Sum ?? null,
              average: d.Average ?? null,
              maximum: d.Maximum ?? null,
            })),
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof AwsSdkError) {
        return {
          error_code: CODE_MAP[err.code] ?? "CONNECTION_ERROR",
          message: err.message,
          retriable: err.retriable,
        };
      }
      return undefined;
    },
  });
}

// Default production connector.
const connector = buildAwsConnector();
export default connector;
export const { main, fetch, validActions } = connector;

// Re-exports for advanced consumers.
export {
  AwsClient,
  loadAwsCredentialsOverride,
  type AwsCommand,
  type AwsClientOptions,
  type AwsSdkFactories,
  type AwsResult,
  type AwsErrorPayload,
  type AwsSuccessPayload,
  type AwsDBInstance,
  type AwsDynamoTable,
  type AwsBucket,
  type AwsLambdaFunction,
  type AwsDatapoint,
} from "./lib/aws_client.js";
export { AwsSdkError } from "./lib/aws_error.js";
