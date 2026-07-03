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
  type GcpLogEntry,
  type GcpResult,
} from "./lib/gcp_client.js";
import { GcpCliError } from "./lib/gcp_error.js";
import { structuredLogFilterSchema } from "./lib/log_filter.js";

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

const queryLogsParams = z
  .object({
    // Raw filter string — kept for backward compatibility with its original
    // strict sanitization. Use `structured_filter` for quoted matches,
    // severity floors, and text search.
    filter: z
      .string()
      .min(1, "query_logs requires a non-empty 'filter'")
      .refine((f) => !/[;'"]/.test(f), {
        message:
          "Filter contains forbidden characters — no semicolons or quotes allowed",
      })
      .transform((f) => f.trim())
      .optional(),
    // Structured filter — JSON clauses compiled internally to a Cloud
    // Logging filter string with correct quoting/escaping, e.g.
    // {"and":[{"field":"severity","op":">=","value":"ERROR"}]}.
    structured_filter: structuredLogFilterSchema.optional(),
    project_id: projectIdField,
    hours: z.coerce.number().int().positive().max(MAX_LOG_HOURS).default(24),
    max_results: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_RESULTS_CAP)
      .default(MAX_RESULTS_DEFAULT),
  })
  .refine((p) => (p.filter === undefined) !== (p.structured_filter === undefined), {
    message:
      "query_logs requires exactly one of 'filter' (raw string) or 'structured_filter' (JSON clauses)",
  });

const MAX_JSON_MESSAGE_CHARS = 2048;

/**
 * Project a raw Cloud Logging entry to the connector's wire shape. `message`
 * falls back textPayload → jsonPayload.message → JSON.stringify(jsonPayload)
 * (truncated); every key is always present, with null for missing data.
 */
function projectLogEntry(e: GcpLogEntry): Record<string, unknown> {
  let message: string | null = e.textPayload ?? null;
  if (message === null && e.jsonPayload !== undefined) {
    const jsonMessage = e.jsonPayload["message"];
    if (typeof jsonMessage === "string" && jsonMessage.length > 0) {
      message = jsonMessage;
    } else {
      const serialized = JSON.stringify(e.jsonPayload);
      message =
        serialized.length > MAX_JSON_MESSAGE_CHARS
          ? serialized.slice(0, MAX_JSON_MESSAGE_CHARS) + "…"
          : serialized;
    }
  }
  const labels = e.resource?.labels ?? {};
  return {
    timestamp: e.timestamp ?? null,
    severity: e.severity ?? "",
    message,
    container: labels["container_name"] ?? null,
    namespace: labels["namespace_name"] ?? null,
    pod: labels["pod_name"] ?? null,
    trace_id: e.trace ?? null,
    log_name: e.logName ?? null,
    insert_id: e.insertId ?? null,
  };
}

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
        description:
          "Query Cloud Logging for entries matching a filter (raw string or structured JSON clauses)",
        params: queryLogsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof queryLogsParams>, ctx) => {
          let entries: GcpLogEntry[];
          let filterEcho: string;
          if (p.structured_filter !== undefined) {
            const result = await ctx.sdk.queryLogsStructured(
              p.project_id,
              p.structured_filter,
              p.hours,
              p.max_results,
            );
            throwIfError(result);
            entries = result.data.entries;
            filterEcho = result.data.compiledFilter;
          } else {
            const result = await ctx.sdk.queryLogs(
              p.project_id,
              p.filter ?? "",
              p.hours,
              p.max_results,
            );
            throwIfError(result);
            entries = result.data;
            filterEcho = p.filter ?? "";
          }
          return {
            project_id: p.project_id,
            filter: filterEcho,
            hours: p.hours,
            entries: entries.map(projectLogEntry),
            entry_count: entries.length,
            truncated: entries.length >= p.max_results,
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
export {
  compileLogFilter,
  structuredLogFilterSchema,
  type LogFilterClause,
  type LogFilterGroup,
  type LogFilterOp,
  type StructuredLogFilter,
} from "./lib/log_filter.js";
