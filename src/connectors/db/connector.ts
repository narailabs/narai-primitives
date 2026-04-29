/**
 * Framework wrapper for `db-agent-connector`.
 *
 * Wraps the internal `fetch(action, params)` dispatcher (see `dispatcher.ts`)
 * in a `@narai/connector-toolkit` `createConnector` shell. The toolkit
 * provides the CLI harness, `--curate` slash-command entry, hardship logging,
 * and SessionStart reminder helper; the internal dispatcher still owns all
 * DB-specific work (SQL classification, policy gate, per-server config
 * merging, driver lazy-loading, audit JSONL, approval grants).
 *
 * Envelope translation at the boundary: the internal dispatcher emits
 * `{status: "ok"|"denied"|"escalate"|"present_only"|"error", ...}`; the
 * framework's canonical envelope uses `success` in place of `ok`. The
 * handler unwraps `ok` into the success envelope's `data` and uses the
 * toolkit's `EnvelopeOverride` escape hatch to emit `denied` / `escalate`
 * / `present_only` envelopes verbatim (with their rich shape intact).
 *
 * The toolkit's own policy gate runs over `{kind: "read"}` for every call
 * — a pass-through — because the real, SQL-aware policy logic lives in the
 * dispatcher. The YAML config shape (V2.0: under `connectors.db.*` with
 * `servers` + `policy` + `unbounded_select` etc.) is owned by the
 * dispatcher's call into `@narai/connector-config`.
 */
import { createConnector, EnvelopeOverride, type Connector, type ExtendedEnvelope } from "narai-primitives/toolkit";
import { z } from "zod";
import { fetch as dispatcherFetch, type FetchResult } from "./dispatcher.js";
import { DB_POLICY_EXTRAS } from "./lib/plugin_config.js";

// ───────────────────────────────────────────────────────────────────────────
// Param schemas
// ───────────────────────────────────────────────────────────────────────────

// Toolkit 3.0.0-rc.1 fixed ZodError identity mismatches (structural duck-type
// in `isZodErrorLike()` replaces `instanceof z.ZodError`). It is now safe to
// enforce `.min(1)` here so empty-SQL is caught at the toolkit boundary and
// returned as VALIDATION_ERROR rather than reaching the dispatcher.
const queryParams = z.object({
  sqlite_path: z.string().optional(),
  env: z.string().optional(),
  config_path: z.string().optional(),
  sql: z.string().min(1, "sql is required"),
  approval_mode: z.string().optional(),
  max_rows: z.coerce.number().int().positive().default(1000),
  timeout_ms: z.coerce.number().int().positive().default(30000),
});

const schemaParams = z.object({
  sqlite_path: z.string().optional(),
  env: z.string().optional(),
  config_path: z.string().optional(),
  filter: z.string().optional(),
});

// ───────────────────────────────────────────────────────────────────────────
// Envelope translation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Take the internal dispatcher's result and translate it into what
 * `createConnector`'s handler is expected to return (or throw).
 *
 *   internal status        → framework behavior
 *   -----------------------  ---------------------------------------------
 *   ok                     → return data (stripped of the internal status)
 *   denied/escalate/       → throw EnvelopeOverride with
 *     present_only           {status, reason, [formatted_sql],
 *                             execution_time_ms}
 *   error                  → throw with error_code in the message, picked up
 *                            by mapError
 */
function translateOrThrow(action: string, result: FetchResult): Record<string, unknown> {
  const status = result["status"];
  if (status === "ok") {
    // Drop the internal status; the framework wraps the rest in a success envelope.
    const { status: _status, ...body } = result as { status: string } & Record<string, unknown>;
    return body;
  }
  if (status === "denied" || status === "escalate") {
    const reason = typeof result["reason"] === "string" ? result["reason"] : undefined;
    const envelope: Omit<ExtendedEnvelope, "action"> = {
      status,
      ...(reason !== undefined ? { message: reason } : {}),
      extension: {},
    };
    throw new EnvelopeOverride(envelope);
  }
  if (status === "present_only") {
    const ext: Record<string, unknown> = {};
    if (typeof result["formatted_sql"] === "string") ext["formatted_sql"] = result["formatted_sql"];
    if (typeof result["execution_time_ms"] === "number") ext["execution_time_ms"] = result["execution_time_ms"];
    const reason = typeof result["reason"] === "string" ? result["reason"] : undefined;
    const envelope: Omit<ExtendedEnvelope, "action"> = {
      status: "present_only",
      ...(reason !== undefined ? { message: reason } : {}),
      extension: ext,
    };
    throw new EnvelopeOverride(envelope);
  }
  // status === "error" or unknown: bubble up as a thrown error so mapError
  // produces a canonical error envelope.
  const errorCode = typeof result["error_code"] === "string" ? result["error_code"] : "";
  const errorMsg = typeof result["error"] === "string" ? result["error"] : `db-agent ${action} failed`;
  throw new DbError(errorCode || "CONNECTION_ERROR", errorMsg);
}

class DbError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "DbError";
    this.errorCode = errorCode;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Connector factory
// ───────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Test hook — override the dispatcher used by handlers. */
  dispatch?: typeof dispatcherFetch;
}

export function buildDbConnector(overrides: BuildOptions = {}): Connector {
  const dispatch = overrides.dispatch ?? dispatcherFetch;

  return createConnector({
    name: "db",
    version: "2.0.0",
    // The new `~/.connectors/config.yaml` uses the V2.0 vocab
    // (`allow`/`deny` + `read`/`write`/`delete`/`admin`/`privilege`) and a
    // connector-specific `servers:` section under options. Skip the
    // toolkit's YAML discovery — the dispatcher loads and gates against
    // the resolved config internally.
    disablePolicyDiscovery: true,
    // Declare the extra decision values db understands beyond the
    // universal PolicyDecision set. Mirrors `DbExtraDecision` at runtime.
    policyExtras: DB_POLICY_EXTRAS,
    credentials: async () => ({}),
    // No SDK to preload — drivers are lazy-loaded via `getConnection` inside
    // the dispatcher on the allow path only.
    actions: {
      query: {
        description:
          "Execute SQL against a configured DB. WRITE/DELETE/ADMIN return status=present_only or escalate per policy; PRIVILEGE returns denied.",
        params: queryParams,
        // Classify is pass-through — the real SQL-aware gate lives in the
        // dispatcher; we hand { kind: "read" } to the toolkit so its gate
        // always allows and the dispatcher's decision wins.
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof queryParams>) => {
          const result = await dispatch("query", p as Record<string, unknown>);
          return translateOrThrow("query", result);
        },
      },
      schema: {
        description: "Introspect table/column schema for a configured DB",
        params: schemaParams,
        classify: { kind: "read" },
        handler: async (p: z.infer<typeof schemaParams>) => {
          const result = await dispatch("schema", p as Record<string, unknown>);
          return translateOrThrow("schema", result);
        },
      },
    },
    mapError: (err) => {
      if (err instanceof DbError) {
        const code = mapDbErrorCode(err.errorCode);
        return { error_code: code, message: err.message, retriable: false };
      }
      return undefined;
    },
  });
}

function mapDbErrorCode(internal: string): import("narai-primitives/toolkit").ErrorCode {
  const upper = internal.toUpperCase();
  if (upper === "VALIDATION_ERROR") return "VALIDATION_ERROR";
  if (upper === "CONFIG_ERROR") return "CONFIG_ERROR";
  if (upper === "CONNECTION_ERROR") return "CONNECTION_ERROR";
  if (upper === "AUTH_ERROR" || upper === "UNAUTHORIZED") return "AUTH_ERROR";
  if (upper === "NOT_FOUND") return "NOT_FOUND";
  if (upper === "TIMEOUT") return "TIMEOUT";
  if (upper === "RATE_LIMITED") return "RATE_LIMITED";
  if (upper === "SCHEMA_ERROR" || upper.endsWith("_ERROR")) return "CONNECTION_ERROR";
  return "CONNECTION_ERROR";
}
