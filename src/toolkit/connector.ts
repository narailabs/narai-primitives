/**
 * `createConnector` — the common framework factory.
 *
 * Each connector's package declares a config (name, credentials loader,
 * optional SDK loader, action registry, hooks). The factory returns
 * `{main, fetch, validActions, name}`:
 *
 *   - `main(argv)` parses `--action`/`--params`/`--curate`/`--help`,
 *     dispatches to `fetch`, emits the envelope on stdout, returns an
 *     exit code.
 *   - `fetch(action, params)` is the library surface — validates Zod,
 *     classifies, runs the policy gate, loads sdk/credentials lazily
 *     on success, runs the handler, wraps exceptions in error envelopes.
 *
 * Every step emits audit events and writes hardship entries where
 * appropriate.
 */
import type { ZodSchema } from "zod";
import { z } from "zod";
import { parseAgentArgs } from "./agent_cli.js";
import { createAuditWriter, scrubSecrets, type AuditWriter } from "./audit/writer.js";
import { readFirstMatchingPattern } from "./hardship/read.js";
import { createHardshipRecorder, type HardshipRecorder } from "./hardship/record.js";
import { buildCurateSnapshot } from "./plugin/curate-cmd.js";
import { ApprovalEngine } from "./policy/approval.js";
import { loadPolicyConfig, type LoadedPolicy } from "./policy/config.js";
import { checkPolicy } from "./policy/gate.js";
import {
  DEFAULT_POLICY,
  type ApprovalMode,
  type Classification,
  type Decision,
  type DeniedEnvelope,
  type Envelope,
  type ErrorCode,
  type ErrorEnvelope,
  type EscalateEnvelope,
  type ExtendedEnvelope,
  type PolicyRules,
  type SuccessEnvelope,
} from "./policy/types.js";

// ───────────────────────────────────────────────────────────────────────────
// Public API types
// ───────────────────────────────────────────────────────────────────────────

export interface Context<TSdk> {
  sdk: TSdk;
  credentials: Credentials;
  policy: Decision;
  recordHardship: HardshipRecorder;
  logger: { debug(msg: string): void; warn(msg: string): void };
}

export interface ActionSpec<TParams = any, TSdk = unknown> {
  params: ZodSchema<TParams>;
  classify: Classification | ((p: TParams) => Classification);
  handler: (p: TParams, ctx: Context<TSdk>) => Promise<unknown>;
  description?: string;
}

/**
 * Helper for writing a single action spec with full param-type inference.
 * TypeScript can't thread `z.infer<S>` through the `actions` record on its
 * own, so wrapping each spec in `defineAction` gives the handler's `p` the
 * exact schema-inferred type without manual annotations.
 *
 * Usage:
 *   actions: {
 *     list_functions: defineAction({
 *       params: z.object({ region: z.string() }),
 *       classify: { kind: "read" },
 *       handler: async (p, ctx) => ctx.sdk.lambda.list(p),
 *     }),
 *   },
 */
export function defineAction<S extends ZodSchema, TSdk = unknown>(
  spec: {
    params: S;
    classify: Classification | ((p: z.infer<S>) => Classification);
    handler: (p: z.infer<S>, ctx: Context<TSdk>) => Promise<unknown>;
    description?: string;
  },
): ActionSpec<z.infer<S>, TSdk> {
  return spec;
}

export type Credentials = Record<string, unknown>;

export interface DecisionContext {
  action: string;
  params: unknown;
  classification: Classification;
}

/**
 * Escape hatch for handlers that need to emit a non-success envelope the
 * base framework doesn't model directly. Throw this from a handler with
 * the exact envelope shape you want returned — the framework will add the
 * `action` field and emit it verbatim.
 *
 * Typical use: `db-agent-connector` throws this for `denied` / `escalate` /
 * `present_only` results coming back from its internal policy gate, since
 * those are shaped with additional fields (`reason`, `formatted_sql`,
 * `execution_time_ms`) that ErrorEnvelope can't carry.
 *
 * Prefer the `classify` hook + `extendDecision` for policy-gate-driven
 * envelopes whenever possible — this escape hatch is for cases where the
 * status decision can only be made after running the handler.
 */
export class EnvelopeOverride extends Error {
  readonly envelope: Omit<ExtendedEnvelope, "action"> & Partial<Pick<ExtendedEnvelope, "action">>;
  constructor(envelope: Omit<ExtendedEnvelope, "action"> & Partial<Pick<ExtendedEnvelope, "action">>) {
    super(`EnvelopeOverride: ${envelope.status}`);
    this.name = "EnvelopeOverride";
    this.envelope = envelope;
  }
}

export interface ConnectorConfig<TSdk = unknown> {
  name: string;
  version?: string;
  credentials: () => Promise<Credentials>;
  sdk?: () => Promise<TSdk>;
  /** Action registry, keyed by action name. */
  actions: Record<string, ActionSpec<any, TSdk>>;

  // Optional hooks ───────────────────────────────────────────────────────────
  /** Override per-action classification (e.g. db-agent classifies based on SQL). */
  classify?: (
    action: string,
    params: unknown,
  ) => Classification | Promise<Classification>;
  /** Extend the Decision before it becomes an envelope (e.g. attach formatted_sql). */
  extendDecision?: (
    decision: Decision,
    ctx: DecisionContext,
  ) => Decision | ExtendedEnvelope;
  /** Map a caught exception to a custom error envelope. Return `undefined` to fall through. */
  mapError?: (err: unknown, action: string) => Partial<ErrorEnvelope> | undefined;

  // Optional config ──────────────────────────────────────────────────────────
  policyConfigPath?: string;
  /** Aspects that cannot be downgraded to `"success"` in operator config. */
  policyFloorAspects?: readonly string[];
  /** Default rules when no config is found. Defaults to `DEFAULT_POLICY`. */
  defaultPolicy?: PolicyRules;
  /**
   * Skip the toolkit's YAML discovery entirely. Use this when the connector
   * owns a different config format (e.g. `db-agent-connector`'s
   * `.db-agent/config.yaml` has legacy labels + `servers:` that the toolkit's
   * validator rejects). The handler is responsible for gating calls itself.
   */
  disablePolicyDiscovery?: boolean;
  audit?: { enabled: boolean; path?: string };
  hardship?: {
    enabled?: boolean;
    recorder?: HardshipRecorder;
  };
  /** Derive a per-request tenant scope key from the resolved SDK. Used to tag hardship entries. */
  scope?: (ctx: { sdk: TSdk; action: string; params: unknown }) => string | null;
  /** Path overrides for test isolation — forwarded to readFirstMatchingPattern. */
  runtime?: {
    cwd?: string;
    home?: string;
  };
}

export interface Connector {
  main(argv: readonly string[]): Promise<number>;
  fetch(action: string, params: unknown): Promise<Envelope>;
  readonly validActions: ReadonlySet<string>;
  readonly name: string;
  recordResolution(input: {
    pattern_id: string;
    advice: string;
    action?: string;
    scope?: string | null;
  }): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Error-code mapping defaults
// ───────────────────────────────────────────────────────────────────────────

const RETRIABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "CONNECTION_ERROR",
]);

function isZodErrorLike(
  err: unknown,
): err is { name: string; issues: Array<{ path: unknown[]; message: string }> } {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e["name"] === "ZodError" &&
    Array.isArray(e["issues"]) &&
    e["issues"].every((i) => {
      if (!i || typeof i !== "object") return false;
      const issue = i as Record<string, unknown>;
      return Array.isArray(issue["path"]) && typeof issue["message"] === "string";
    })
  );
}

function defaultErrorMap(err: unknown): { error_code: ErrorCode; message: string } {
  // Structural check instead of `instanceof z.ZodError` because consumers
  // may install toolkit via `file:` deps or otherwise end up with their
  // own zod instance — instanceof would return false and the error would
  // leak through as a misclassified CONNECTION_ERROR. Duck-typing on
  // `name === "ZodError"` + shape catches every zod instance regardless
  // of module identity.
  if (isZodErrorLike(err)) {
    const msg = err.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { error_code: "VALIDATION_ERROR", message: msg };
  }
  const message = err instanceof Error ? err.message : String(err);
  // Heuristic mapping — connectors override via mapError for service-specific codes.
  const lower = message.toLowerCase();
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("network")) {
    return { error_code: "CONNECTION_ERROR", message };
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return { error_code: "TIMEOUT", message };
  }
  if (lower.includes("401") || lower.includes("unauthor") || lower.includes("forbidden")) {
    return { error_code: "AUTH_ERROR", message };
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return { error_code: "NOT_FOUND", message };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { error_code: "RATE_LIMITED", message };
  }
  if (lower.includes("sdk") && lower.includes("not installed")) {
    return { error_code: "CONFIG_ERROR", message };
  }
  return { error_code: "CONNECTION_ERROR", message };
}

// ───────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────

export function createConnector<TSdk = unknown>(
  cfg: ConnectorConfig<TSdk>,
): Connector {
  if (cfg.name.length === 0) {
    throw new Error("createConnector: 'name' is required");
  }
  if (Object.keys(cfg.actions).length === 0) {
    throw new Error(
      `createConnector(${cfg.name}): at least one action must be declared`,
    );
  }

  const validActions: ReadonlySet<string> = new Set(Object.keys(cfg.actions));

  // Policy config — loaded once per connector instance.
  let loadedPolicy: LoadedPolicy | null = null;
  let policyLoadError: string | null = null;
  if (cfg.disablePolicyDiscovery !== true) {
    try {
      loadedPolicy = loadPolicyConfig({
        name: cfg.name,
        floorAspects: cfg.policyFloorAspects ?? [],
        ...(cfg.policyConfigPath !== undefined
          ? { explicitPath: cfg.policyConfigPath }
          : {}),
      });
    } catch (err) {
      // Surface config errors deterministically on first call via fetch.
      policyLoadError = err instanceof Error ? err.message : String(err);
    }
  }
  const rules: PolicyRules = loadedPolicy?.rules ?? cfg.defaultPolicy ?? DEFAULT_POLICY;
  const approvalMode: ApprovalMode = loadedPolicy?.approval_mode ?? "auto";

  // Audit + approval engine + hardship recorder (all instance-scoped).
  const audit: AuditWriter = createAuditWriter(
    cfg.audit !== undefined
      ? {
          enabled: cfg.audit.enabled,
          ...(cfg.audit.path !== undefined ? { path: cfg.audit.path } : {}),
        }
      : { enabled: false },
  );
  const approvals = new ApprovalEngine({
    onGrantExpired: (grantType) =>
      audit.logEvent({ event_type: "grant_expired", grant_type: grantType }),
  });
  const recorder: HardshipRecorder =
    cfg.hardship?.recorder ??
    createHardshipRecorder({
      connector: cfg.name,
      ...(cfg.hardship?.enabled !== undefined ? { enabled: cfg.hardship.enabled } : {}),
      sessionId: audit.sessionId,
    });

  // Lazy SDK loading — only on first success decision.
  let sdkPromise: Promise<TSdk> | null = null;
  const loadSdk = async (): Promise<TSdk> => {
    if (cfg.sdk === undefined) return undefined as unknown as TSdk;
    if (sdkPromise === null) sdkPromise = cfg.sdk();
    return sdkPromise;
  };

  // Lazy credentials loading — only on first success decision.
  let credsPromise: Promise<Credentials> | null = null;
  const loadCreds = async (): Promise<Credentials> => {
    if (credsPromise === null) credsPromise = cfg.credentials();
    return credsPromise;
  };

  // Track last successful SDK resolution for recordResolution defaulting.
  let lastCtx: { sdk: TSdk; action: string; params: unknown } | null = null;

  // ─── fetch ──────────────────────────────────────────────────────────────
  const fetch = async (action: string, params: unknown): Promise<Envelope> => {
    // Argument validation: action must be registered.
    if (!validActions.has(action)) {
      return {
        status: "error",
        action,
        error_code: "VALIDATION_ERROR",
        message: `Unknown action '${action}'. Valid: ${[...validActions].join(", ")}`,
        retriable: false,
      };
    }
    if (policyLoadError !== null) {
      return {
        status: "error",
        action,
        error_code: "CONFIG_ERROR",
        message: `Policy config error: ${policyLoadError}`,
        retriable: false,
      };
    }

    const spec = cfg.actions[action]!;
    const start = Date.now();

    // 1. Validate params via Zod.
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      const mapped = defaultErrorMap(parsed.error);
      const env: ErrorEnvelope = {
        status: "error",
        action,
        error_code: mapped.error_code,
        message: mapped.message,
        retriable: false,
      };
      audit.logEvent({
        event_type: "action",
        connector: cfg.name,
        action,
        status: "error",
        execution_time_ms: Date.now() - start,
      } as never);
      recorder({
        action,
        kind: "validation",
        context: mapped.message,
        scope: safeScope(cfg, { sdk: undefined as unknown as TSdk, action, params }),
      });
      return env;
    }
    const validated = parsed.data;

    // 2. Classify (factory hook wins; else per-action static/fn classify).
    let classification: Classification;
    try {
      if (cfg.classify !== undefined) {
        classification = await cfg.classify(action, validated);
      } else if (typeof spec.classify === "function") {
        classification = (spec.classify as (p: unknown) => Classification)(validated);
      } else {
        classification = spec.classify;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorEnvelope(action, "CONFIG_ERROR", `classify() threw: ${message}`, false, start);
    }

    // 3. Policy gate.
    let decision: Decision = checkPolicy(classification, rules, approvalMode, approvals);

    // 4. extendDecision hook: may widen Decision into an ExtendedEnvelope.
    let extended: Decision | ExtendedEnvelope = decision;
    if (cfg.extendDecision !== undefined) {
      try {
        extended = cfg.extendDecision(decision, {
          action,
          params: validated,
          classification,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorEnvelope(action, "CONFIG_ERROR", `extendDecision() threw: ${message}`, false, start);
      }
    }

    audit.logEvent({
      event_type: `policy_${decision.status}` as never,
      connector: cfg.name,
      action,
      reason: decision.reason,
      kind: classification.kind,
      ...(classification.aspects !== undefined ? { aspects: classification.aspects } : {}),
    } as never);

    // 5. If not a base success, the caller gets an envelope now (no SDK load).
    if (isEnvelopeLike(extended)) {
      return toEnvelope(cfg.name, action, extended, start, audit);
    }
    if (decision.status === "denied") {
      const deniedScope = safeScope(cfg, { sdk: undefined as unknown as TSdk, action, params: validated });
      const deniedHitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
        connector: cfg.name,
        scope: deniedScope,
        facts: { kind: "policy_denied", action, context: decision.reason },
      };
      if (cfg.runtime?.cwd !== undefined) deniedHitOpts.cwd = cfg.runtime.cwd;
      if (cfg.runtime?.home !== undefined) deniedHitOpts.home = cfg.runtime.home;
      const deniedHit = readFirstMatchingPattern(deniedHitOpts);
      const env: DeniedEnvelope = {
        status: "denied",
        action,
        reason: decision.reason,
        ...(deniedHit
          ? {
              resolution_hint: {
                pattern_id: deniedHit.match.pattern_id,
                advice: deniedHit.match.advice,
                confidence: deniedHit.match.confidence,
                scope: deniedHit.scopeLevel,
              },
            }
          : {}),
      };
      auditAction(audit, cfg.name, action, "denied", start);
      return env;
    }
    if (decision.status === "escalate") {
      const escalateScope = safeScope(cfg, { sdk: undefined as unknown as TSdk, action, params: validated });
      const escalateHitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
        connector: cfg.name,
        scope: escalateScope,
        facts: { kind: "policy_escalate", action, context: decision.reason },
      };
      if (cfg.runtime?.cwd !== undefined) escalateHitOpts.cwd = cfg.runtime.cwd;
      if (cfg.runtime?.home !== undefined) escalateHitOpts.home = cfg.runtime.home;
      const escalateHit = readFirstMatchingPattern(escalateHitOpts);
      const env: EscalateEnvelope = {
        status: "escalate",
        action,
        reason: decision.reason,
        ...(escalateHit
          ? {
              resolution_hint: {
                pattern_id: escalateHit.match.pattern_id,
                advice: escalateHit.match.advice,
                confidence: escalateHit.match.confidence,
                scope: escalateHit.scopeLevel,
              },
            }
          : {}),
      };
      auditAction(audit, cfg.name, action, "escalate", start);
      return env;
    }
    // 6. decision.status === "success". Load SDK + creds lazily, run handler.
    let sdk: TSdk;
    let credentials: Credentials;
    try {
      [sdk, credentials] = await Promise.all([loadSdk(), loadCreds()]);
    } catch (err) {
      return mapAndBuildError(
        err,
        action,
        cfg,
        audit,
        recorder,
        classification,
        start,
        undefined as unknown as TSdk,
        validated,
      );
    }

    lastCtx = { sdk, action, params: validated };

    const ctx: Context<TSdk> = {
      sdk,
      credentials,
      policy: decision,
      recordHardship: recorder,
      logger: {
        debug: (msg: string) => audit.logEvent({ event_type: "debug", details: { msg } } as never),
        warn: (msg: string) => audit.logEvent({ event_type: "warn", details: { msg } } as never),
      },
    };

    let data: unknown;
    try {
      data = await spec.handler(validated as never, ctx);
    } catch (err) {
      // Handlers can emit any envelope shape via EnvelopeOverride.
      if (err instanceof EnvelopeOverride) {
        const envOverride = { ...err.envelope, action } as ExtendedEnvelope;
        auditAction(audit, cfg.name, action, envOverride.status, start);
        return envOverride;
      }
      return mapAndBuildError(err, action, cfg, audit, recorder, classification, start, sdk, validated);
    }

    const env: SuccessEnvelope = {
      status: "success",
      action,
      data: isRecord(data) ? data : { result: data },
    };
    auditAction(audit, cfg.name, action, "success", start);
    return env;
  };

  // ─── main ───────────────────────────────────────────────────────────────
  const main = async (argv: readonly string[]): Promise<number> => {
    // --help / --curate / --version are handled here before action dispatch.
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp(cfg);
      return 0;
    }
    if (argv.includes("--curate")) {
      const snap = buildCurateSnapshot({ connector: cfg.name });
      process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
      return 0;
    }
    if (argv.includes("--version") || argv.includes("-v")) {
      process.stdout.write(`${cfg.name} ${cfg.version ?? ""}\n`);
      return 0;
    }

    // Argument errors emit a structured envelope on stdout (status=error,
    // error_code=VALIDATION_ERROR) so consumers parsing JSON from stdout never
    // hit the case where stdout is empty and the failure is text on stderr.
    // Exit code is 2 (CLI misuse), distinct from 1 (handled action-level error).
    const writeArgErrorEnvelope = (action: string, message: string): void => {
      const env = {
        status: "error",
        action,
        error_code: "VALIDATION_ERROR",
        message,
        retriable: false,
      };
      process.stdout.write(JSON.stringify(env) + "\n");
      process.stderr.write(`argument error: ${message}\n`);
    };

    let parsed;
    try {
      parsed = parseAgentArgs(argv, { flags: ["action", "params"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeArgErrorEnvelope("<unknown>", msg);
      return 2;
    }

    const action = parsed.action;
    const paramsRaw = parsed.params ?? "{}";
    if (typeof action !== "string" || action.length === 0) {
      writeArgErrorEnvelope("<unknown>", "--action is required");
      return 2;
    }
    let params: unknown;
    try {
      params = JSON.parse(paramsRaw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeArgErrorEnvelope(
        action,
        `--params must be valid JSON (${msg})`,
      );
      return 2;
    }

    const env = await fetch(action, params);
    process.stdout.write(JSON.stringify(env) + "\n");
    return exitCodeForEnvelope(env);
  };

  return {
    main,
    fetch,
    validActions,
    name: cfg.name,
    recordResolution(input) {
      const scope =
        input.scope !== undefined
          ? input.scope
          : lastCtx && cfg.scope
            ? safeScope(cfg, lastCtx)
            : null;
      recorder({
        action: input.action ?? lastCtx?.action ?? "unknown",
        kind: "resolution",
        context: `pattern=${input.pattern_id}`,
        resolution: input.advice,
        scope,
      });
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEnvelopeLike(v: unknown): v is ExtendedEnvelope {
  if (!isRecord(v)) return false;
  const status = v["status"];
  if (typeof status !== "string") return false;
  // Base decision statuses (success/denied/escalate) come back from
  // checkPolicy without an `action` field; anything else is an extension.
  const action = v["action"];
  return typeof action === "string";
}

function toEnvelope(
  connector: string,
  action: string,
  value: Decision | ExtendedEnvelope,
  start: number,
  audit: AuditWriter,
): Envelope {
  if (isEnvelopeLike(value)) {
    auditAction(audit, connector, action, value.status, start);
    return value;
  }
  // Fallback: decision without envelope form (shouldn't hit in practice —
  // main path handles base decisions explicitly).
  auditAction(audit, connector, action, value.status, start);
  return {
    status: value.status,
    action,
    message: value.reason,
    extension: {},
  } as ExtendedEnvelope;
}

function auditAction(
  audit: AuditWriter,
  connector: string,
  action: string,
  status: string,
  start: number,
): void {
  audit.logEvent({
    event_type: "action",
    connector,
    action,
    status,
    execution_time_ms: Date.now() - start,
  } as never);
}

function errorEnvelope(
  action: string,
  code: ErrorCode,
  message: string,
  retriable: boolean,
  _start: number,
): ErrorEnvelope {
  return {
    status: "error",
    action,
    error_code: code,
    message,
    retriable,
  };
}

function safeScope<TSdk>(
  cfg: ConnectorConfig<TSdk>,
  ctx: { sdk: TSdk; action: string; params: unknown },
): string | null {
  if (!cfg.scope) return null;
  try {
    return cfg.scope(ctx);
  } catch {
    return null;
  }
}

function mapAndBuildError<TSdk>(
  err: unknown,
  action: string,
  cfg: ConnectorConfig<TSdk>,
  audit: AuditWriter,
  recorder: HardshipRecorder,
  _classification: Classification,
  start: number,
  sdk: TSdk,
  params: unknown,
): ErrorEnvelope {
  let code: ErrorCode;
  let message: string;
  let retriable: boolean;

  const override = cfg.mapError?.(err, action);
  if (override?.error_code !== undefined && override?.message !== undefined) {
    code = override.error_code;
    message = override.message;
    retriable = override.retriable ?? RETRIABLE_CODES.has(code);
  } else {
    const def = defaultErrorMap(err);
    code = def.error_code;
    message = def.message;
    retriable = RETRIABLE_CODES.has(code);
  }

  const scope = safeScope(cfg, { sdk, action, params });

  auditAction(audit, cfg.name, action, "error", start);
  recorder({
    action,
    kind: code.toLowerCase(),
    context: scrubSecrets(message),
    scope,
  });

  const hitOpts: Parameters<typeof readFirstMatchingPattern>[0] = {
    connector: cfg.name,
    scope,
    facts: {
      kind: code.toLowerCase(),
      action,
      context: scrubSecrets(message),
    },
  };
  if (cfg.runtime?.cwd !== undefined) hitOpts.cwd = cfg.runtime.cwd;
  if (cfg.runtime?.home !== undefined) hitOpts.home = cfg.runtime.home;
  const hit = readFirstMatchingPattern(hitOpts);

  return {
    status: "error",
    action,
    error_code: code,
    message,
    retriable,
    ...(hit
      ? {
          resolution_hint: {
            pattern_id: hit.match.pattern_id,
            advice: hit.match.advice,
            confidence: hit.match.confidence,
            scope: hit.scopeLevel,
          },
        }
      : {}),
  };
}

function exitCodeForEnvelope(env: Envelope): number {
  const status = (env as { status?: unknown }).status;
  if (status === "success") return 0;
  // Connector-extended "presentation" statuses (e.g. db-agent's present_only)
  // exit 0 since they represent a valid non-error response.
  if (typeof status === "string" && status.startsWith("present")) return 0;
  return 1;
}

function printHelp<TSdk>(cfg: ConnectorConfig<TSdk>): void {
  const lines = [
    `${cfg.name}${cfg.version ? ` (${cfg.version})` : ""}`,
    "",
    "Usage:",
    `  ${cfg.name} --action <name> --params '<json>'`,
    `  ${cfg.name} --curate                 # dump hardship clusters as JSON`,
    `  ${cfg.name} --help | --version`,
    "",
    "Actions:",
  ];
  for (const [name, spec] of Object.entries(cfg.actions)) {
    const desc = spec.description ?? "";
    lines.push(`  ${name.padEnd(24)} ${desc}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
