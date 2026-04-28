/**
 * @narai/gcp-agent-connector — read-only GCP connector.
 *
 * Built on @narai/connector-toolkit. The default export is a ready-to-use
 * `Connector`; `buildGcpConnector(overrides?)` is exposed for tests that
 * want to inject a fake GcpClient.
 *
 * Runtime requirement: `gcloud` (and optionally `bq`) must be on PATH with
 * Application Default Credentials configured. Missing binaries surface as
 * CONFIG_ERROR envelopes.
 */
import { createConnector, type Connector, type ErrorCode } from "narai-primitives/toolkit";
import { z } from "zod";
import {
  GcpClient,
  detectGcloudAvailable,
  type GcpResult,
} from "./lib/gcp_client.js";
import { GcpCliError } from "./lib/gcp_error.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_DEFAULT = 100;
const MAX_RESULTS_CAP = 1000;
const MAX_LOG_HOURS = 168;

const projectIdField = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    "Invalid project_id — must be 6-30 lowercase letters, digits, hyphens",
  );

const listServicesParams = z.object({ project_id: projectIdField });
const listTopicsParams = z.object({ project_id: projectIdField });

const describeDbParams = z.object({
  project_id: projectIdField,
  instance_id: z.string().min(1, "describe_db requires a non-empty 'instance_id'"),
  database: z.string().default(""),
});

const queryLogsParams = z.object({
  project_id: projectIdField,
  filter: z
    .string()
    .min(1, "query_logs requires a non-empty 'filter'")
    .refine((f) => !/[;'"]/.test(f), {
      message:
        "Filter contains forbidden characters — no semicolons or quotes allowed",
    })
    .transform((f) => f.trim()),
  hours: z.coerce.number().int().positive().max(MAX_LOG_HOURS).default(24),
  max_results: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_RESULTS_CAP)
    .default(MAX_RESULTS_DEFAULT),
});

// ───────────────────────────────────────────────────────────────────────────
// Error-code translation
// ───────────────────────────────────────────────────────────────────────────

const CODE_MAP: Record<string, ErrorCode> = {
  INVALID_PROJECT: "VALIDATION_ERROR",
  INVALID_INSTANCE: "VALIDATION_ERROR",
  INVALID_FILTER: "VALIDATION_ERROR",
  FORBIDDEN_BINARY: "VALIDATION_ERROR",
  FORBIDDEN_COMMAND: "VALIDATION_ERROR",
  UNSAFE_ARG: "VALIDATION_ERROR",
  WRITE_FORBIDDEN: "VALIDATION_ERROR",
  EXEC_ERROR: "CONNECTION_ERROR",
  TIMEOUT: "TIMEOUT",
  PARSE_ERROR: "CONNECTION_ERROR",
  GCLOUD_MISSING: "CONFIG_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "AUTH_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
};

function throwIfError<T>(
  result: GcpResult<T>,
): asserts result is Extract<GcpResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new GcpCliError(result.code, result.message, result.retriable);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  sdk?: () => Promise<GcpClient>;
  credentials?: () => Promise<Record<string, unknown>>;
}

async function loadGcpDefaults(): Promise<{
  defaultProjectId: string | null;
  defaultRegion: string | null;
}> {
  return {
    defaultProjectId: process.env["GCP_PROJECT_ID"] ?? null,
    defaultRegion: process.env["GCP_REGION"] ?? null,
  };
}

export function buildGcpConnector(overrides: BuildOptions = {}): Connector {
  const defaultCredentials = async (): Promise<Record<string, unknown>> => {
    // GCP uses Application Default Credentials via gcloud; no explicit secret load.
    return {};
  };

  const defaultSdk = async (): Promise<GcpClient> => {
    if (!detectGcloudAvailable()) {
      throw new GcpCliError(
        "GCLOUD_MISSING",
        "gcloud CLI not available on PATH. Install Google Cloud SDK and " +
          "authenticate with Application Default Credentials (gcloud auth " +
          "application-default login).",
        false,
      );
    }
    const defaults = await loadGcpDefaults();
    return new GcpClient({
      ...(defaults.defaultProjectId
        ? { defaultProjectId: defaults.defaultProjectId }
        : {}),
      ...(defaults.defaultRegion
        ? { defaultRegion: defaults.defaultRegion }
        : {}),
    });
  };

  return createConnector<GcpClient>({
    name: "gcp",
    version: "3.0.0",
    scope: (ctx) =>
      ctx.sdk.defaultProjectId && ctx.sdk.defaultRegion
        ? `${ctx.sdk.defaultProjectId}/${ctx.sdk.defaultRegion}`
        : null,
    credentials: overrides.credentials ?? defaultCredentials,
    sdk: overrides.sdk ?? defaultSdk,
    actions: {
      list_services: {
        description: "List Cloud Run services in a project",
        params: listServicesParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listServicesParams>, ctx) => {
          const result = await ctx.sdk.listServices(p.project_id);
          throwIfError(result);
          return {
            project_id: p.project_id,
            services: result.data.map((s) => ({
              name: s.name ?? "",
              title: s.config?.title ?? "",
              state: s.state ?? "",
            })),
            service_count: result.data.length,
          };
        },
      },
      describe_db: {
        description: "Describe a Cloud SQL instance",
        params: describeDbParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof describeDbParams>, ctx) => {
          const result = await ctx.sdk.describeSqlInstance(p.project_id, p.instance_id);
          throwIfError(result);
          const inst = result.data;
          const [engine, version] = (inst.databaseVersion ?? "").split("_");
          return {
            project_id: p.project_id,
            instance_id: p.instance_id,
            database: p.database,
            engine: (engine ?? "").toLowerCase(),
            version: version ?? "",
            tier: inst.settings?.tier ?? "",
            region: inst.region ?? "",
            state: inst.state ?? "",
            tables: [],
          };
        },
      },
      list_topics: {
        description: "List Pub/Sub topics in a project",
        params: listTopicsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof listTopicsParams>, ctx) => {
          const result = await ctx.sdk.listPubsubTopics(p.project_id);
          throwIfError(result);
          return {
            project_id: p.project_id,
            topics: result.data.map((t) => t.name ?? ""),
            topic_count: result.data.length,
          };
        },
      },
      query_logs: {
        description: "Query Cloud Logging for entries matching a filter",
        params: queryLogsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof queryLogsParams>, ctx) => {
          const result = await ctx.sdk.queryLogs(
            p.project_id,
            p.filter,
            p.hours,
            p.max_results,
          );
          throwIfError(result);
          return {
            project_id: p.project_id,
            filter: p.filter,
            hours: p.hours,
            entries: result.data.map((e) => ({
              timestamp: e.timestamp ?? null,
              severity: e.severity ?? "",
              message: e.textPayload ?? "",
            })),
            entry_count: result.data.length,
            truncated: result.data.length >= p.max_results,
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof GcpCliError) {
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
const connector = buildGcpConnector();
export default connector;
export const { main, fetch, validActions } = connector;

export {
  GcpClient,
  detectGcloudAvailable,
  type GcpClientOptions,
  type GcpResult,
} from "./lib/gcp_client.js";
export { GcpCliError } from "./lib/gcp_error.js";
