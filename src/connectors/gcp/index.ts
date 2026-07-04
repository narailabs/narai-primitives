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
import {
  compileLogFilter,
  LogFilterError,
  type FilterNode,
} from "./lib/log_filter.js";

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

// Structured filter clauses — compiled to a Cloud Logging filter string by
// log_filter.ts, which owns the security model (op allowlist, identifier
// fields, values escaped as data). The zod shape mirrors those constraints
// so bad input fails fast as a VALIDATION_ERROR.
const FILTER_FIELD_SAFE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const filterClauseSchema = z
  .object({
    field: z
      .string()
      .regex(
        FILTER_FIELD_SAFE,
        "Filter field must be a dotted identifier (e.g. resource.labels.namespace_name)",
      ),
    op: z.enum(["=", "!=", ">=", "<=", "contains", ":"]),
    value: z.union([z.string(), z.number()]),
  })
  .strict();

const filterLeafGroupSchema = z.union([
  z.object({ and: z.array(filterClauseSchema).min(1) }).strict(),
  z.object({ or: z.array(filterClauseSchema).min(1) }).strict(),
]);

const filterMemberSchema = z.union([filterClauseSchema, filterLeafGroupSchema]);

const structuredFilterSchema = z.union([
  filterClauseSchema,
  z.object({ and: z.array(filterMemberSchema).min(1) }).strict(),
  z.object({ or: z.array(filterMemberSchema).min(1) }).strict(),
]);

const queryLogsParams = z
  .object({
    project_id: projectIdField,
    filter: z
      .string()
      .min(1, "query_logs requires a non-empty 'filter'")
      .refine((f) => !/[;'"]/.test(f), {
        message:
          "Filter contains forbidden characters — no semicolons or quotes allowed",
      })
      .transform((f) => f.trim())
      .optional(),
    structured_filter: structuredFilterSchema.optional(),
    hours: z.coerce.number().int().positive().max(MAX_LOG_HOURS).default(24),
    max_results: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_RESULTS_CAP)
      .default(MAX_RESULTS_DEFAULT),
  })
  .refine(
    (p) => (p.filter !== undefined) !== (p.structured_filter !== undefined),
    {
      message:
        "query_logs requires exactly one of 'filter' (raw string) or 'structured_filter' (JSON clauses)",
    },
  );

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

const MAX_JSON_MESSAGE_BYTES = 2048;

/**
 * Project a raw Cloud Logging entry into the envelope shape. Existing
 * fields keep their pre-2.6 semantics; new fields are null when absent —
 * never omitted.
 *
 * message fallback chain: textPayload → jsonPayload.message →
 * JSON.stringify(jsonPayload) truncated to ~2KB → null.
 */
function projectLogEntry(e: GcpLogEntry): {
  timestamp: string | null;
  severity: string;
  message: string | null;
  container: string | null;
  namespace: string | null;
  pod: string | null;
  trace_id: string | null;
  log_name: string | null;
  insert_id: string | null;
} {
  let message: string | null = e.textPayload ?? null;
  if (message === null && e.jsonPayload !== undefined) {
    const jsonMessage = e.jsonPayload["message"];
    if (typeof jsonMessage === "string" && jsonMessage.length > 0) {
      message = jsonMessage;
    } else {
      const serialized = JSON.stringify(e.jsonPayload);
      message =
        serialized.length > MAX_JSON_MESSAGE_BYTES
          ? serialized.slice(0, MAX_JSON_MESSAGE_BYTES)
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
          "Query Cloud Logging for entries matching a filter. Prefer " +
          "'structured_filter' (JSON clauses with and/or, compiled with " +
          "correct quoting) over the raw 'filter' string, which forbids " +
          "quotes and semicolons.",
        params: queryLogsParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof queryLogsParams>, ctx) => {
          const compiled = p.structured_filter !== undefined;
          const filter = compiled
            ? compileLogFilter(p.structured_filter as FilterNode)
            : (p.filter as string);
          const result = await ctx.sdk.queryLogs(
            p.project_id,
            filter,
            p.hours,
            p.max_results,
            { compiled },
          );
          throwIfError(result);
          return {
            project_id: p.project_id,
            filter,
            hours: p.hours,
            entries: result.data.map(projectLogEntry),
            entry_count: result.data.length,
            truncated: result.data.length >= p.max_results,
          };
        },
      },
    },
    mapError: (err) => {
      if (err instanceof LogFilterError) {
        return {
          error_code: "VALIDATION_ERROR",
          message: err.message,
          retriable: false,
        };
      }
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
  LogFilterError,
  type FilterClause,
  type FilterGroup,
  type FilterNode,
  type FilterOp,
} from "./lib/log_filter.js";
