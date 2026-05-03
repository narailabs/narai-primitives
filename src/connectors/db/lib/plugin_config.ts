/**
 * plugin_config.ts — db-agent plugin-level configuration.
 *
 * V2.0: configuration is loaded by `@narai/connector-config` from
 * `~/.connectors/config.yaml` and `./.connectors/config.yaml`. The CLI
 * builds a `PluginConfig` from the resolved `db` connector's slice. The
 * `loadPluginConfig({ explicitPath })` API still parses a YAML file
 * directly when `--config-path` is supplied — it now expects the new
 * vocab.
 *
 * Shape:
 *   policy:     global default rules, one of allow/present/escalate/deny per op
 *   servers:    named DB servers, each with a driver + driver-specific fields,
 *               and optional per-server `policy` override that merges on top
 *               of the global.
 *   audit:      optional JSONL audit trail (path + enabled flag)
 *
 * Safety floor: `admin` and `privilege` may be downgraded to `present` /
 * `escalate` / `deny` but never `allow`. Validation fails at config-load.
 */
import * as fs from "node:fs";
import * as yaml from "js-yaml";

import type {
  PolicyDecision,
  PolicyMap,
  ResolvedConnector,
} from "narai-primitives/config";

import type { OperationType } from "./policy.js";

/**
 * The extra decision value db-agent contributes on top of the universal
 * `PolicyDecision` set. Exported so `PolicyMap<DbExtraDecision>` can be
 * built by consumers that want strict typing on db's policy block.
 */
export type DbExtraDecision = "present";

/**
 * The full set of policy rules valid in a db-agent config. Composed from
 * the universal `PolicyDecision` (`"allow" | "escalate" | "deny"`) plus
 * db's local `"present"`. Stated this way rather than re-listing the four
 * literals so the base set has exactly one source of truth.
 */
export type PolicyRule = PolicyDecision | DbExtraDecision;
export type RestrictedPolicyRule = Exclude<PolicyRule, "allow">;

/**
 * `PolicyMap` specialized to db-agent's decision vocabulary. Use this in
 * db-internal code that wants `policy.read = "present"` to typecheck while
 * `policy.read = "anything-else"` does not.
 */
export type DbPolicyMap = PolicyMap<DbExtraDecision>;

/** `ResolvedConnector` specialized to db-agent's decision vocabulary. */
export type DbResolvedConnector = ResolvedConnector<DbExtraDecision>;

/**
 * Tuple-typed vocabulary suitable for `createConnector`'s `policyExtras`
 * field. Kept as a single source of truth so the type-level extras and the
 * runtime declaration stay in lockstep.
 */
export const DB_POLICY_EXTRAS = ["present"] as const satisfies readonly DbExtraDecision[];

export type UnboundedSelectMode = "escalate" | "allow";

export interface PolicyRules {
  read: PolicyRule;
  write: PolicyRule;
  delete: PolicyRule;
  admin: RestrictedPolicyRule;
  privilege: RestrictedPolicyRule;
  // How to handle SELECTs that lack WHERE/LIMIT/OFFSET/HAVING/GROUP BY/JOIN.
  // 'escalate' (default): block with a request to add a bound.
  // 'allow': skip the unbounded check.
  unbounded_select: UnboundedSelectMode;
}

// `OperationType` is `read | write | delete | admin | privilege`; PolicyRules
// is keyed exactly by those names so `rules[op]` is type-safe.
type _AssertPolicyRulesKeys = OperationType extends keyof PolicyRules
  ? true
  : never;
const _ASSERT_POLICYRULES_KEYS: _AssertPolicyRulesKeys = true;
void _ASSERT_POLICYRULES_KEYS;

export interface ServerConfig {
  driver: string;
  policy?: Partial<PolicyRules>;
  approval_mode?: string;
  [key: string]: unknown;
}

export interface AuditConfig {
  enabled: boolean;
  path?: string;
}

export interface PluginConfig {
  policy: PolicyRules;
  servers: Record<string, ServerConfig>;
  audit?: AuditConfig;
}

export const DEFAULT_POLICY: PolicyRules = {
  read: "allow",
  write: "escalate",
  delete: "present",
  admin: "present",
  privilege: "deny",
  unbounded_select: "escalate",
};

const VALID_UNBOUNDED_MODES: ReadonlySet<UnboundedSelectMode> = new Set([
  "escalate",
  "allow",
]);

const VALID_RULES: ReadonlySet<PolicyRule> = new Set([
  "allow",
  "present",
  "escalate",
  "deny",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { constructor?: unknown }).constructor === Object
  );
}

function readYaml(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, { encoding: "utf-8" });
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new Error(`Failed to parse YAML (${filePath}): ${msg}`);
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Config must be a YAML mapping (${filePath}), got: ${
        Array.isArray(parsed) ? "list" : typeof parsed
      }`,
    );
  }
  return parsed;
}

/**
 * Merge a global + (optional) per-server policy on top of defaults.
 * Keys absent from the override fall back to `base`.
 */
export function mergePolicy(
  base: PolicyRules,
  override?: Partial<PolicyRules>,
): PolicyRules {
  if (override === undefined) return { ...base };
  return {
    read: override.read ?? base.read,
    write: override.write ?? base.write,
    delete: override.delete ?? base.delete,
    admin: (override.admin ?? base.admin) as RestrictedPolicyRule,
    privilege: (override.privilege ?? base.privilege) as RestrictedPolicyRule,
    unbounded_select: override.unbounded_select ?? base.unbounded_select,
  };
}

function validateRule(
  field: string,
  value: unknown,
  restricted: boolean,
): PolicyRule {
  if (typeof value !== "string" || !VALID_RULES.has(value as PolicyRule)) {
    throw new Error(
      `${field}: expected one of [allow, present, escalate, deny], got: ${JSON.stringify(
        value,
      )}`,
    );
  }
  const rule = value as PolicyRule;
  if (restricted && rule === "allow") {
    throw new Error(
      `${field}: 'allow' is not permitted (admin and privilege can be at most 'escalate'; safety floor)`,
    );
  }
  return rule;
}

function validatePolicyObject(
  path: string,
  raw: unknown,
  allowPartial: boolean,
): Partial<PolicyRules> | PolicyRules {
  if (raw === undefined || raw === null) {
    if (allowPartial) return {};
    return { ...DEFAULT_POLICY };
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${path}: expected an object, got: ${typeof raw}`);
  }
  const out: Partial<PolicyRules> = {};
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case "read":
        out.read = validateRule(`${path}.read`, v, false);
        break;
      case "write":
        out.write = validateRule(`${path}.write`, v, false);
        break;
      case "delete":
        out.delete = validateRule(`${path}.delete`, v, false);
        break;
      case "admin":
        out.admin = validateRule(
          `${path}.admin`,
          v,
          true,
        ) as RestrictedPolicyRule;
        break;
      case "privilege":
        out.privilege = validateRule(
          `${path}.privilege`,
          v,
          true,
        ) as RestrictedPolicyRule;
        break;
      case "unbounded_select":
        if (typeof v !== "string" || !VALID_UNBOUNDED_MODES.has(v as UnboundedSelectMode)) {
          throw new Error(
            `${path}.unbounded_select: expected one of [escalate, allow], got: ${JSON.stringify(v)}`,
          );
        }
        out.unbounded_select = v as UnboundedSelectMode;
        break;
      default:
        throw new Error(
          `${path}: unknown key '${k}' (expected: read, write, delete, admin, privilege, unbounded_select)`,
        );
    }
  }
  if (allowPartial) return out;
  return {
    read: out.read ?? DEFAULT_POLICY.read,
    write: out.write ?? DEFAULT_POLICY.write,
    delete: out.delete ?? DEFAULT_POLICY.delete,
    admin: (out.admin ?? DEFAULT_POLICY.admin) as RestrictedPolicyRule,
    privilege: (out.privilege ?? DEFAULT_POLICY.privilege) as RestrictedPolicyRule,
    unbounded_select: out.unbounded_select ?? DEFAULT_POLICY.unbounded_select,
  };
}

function validateServer(alias: string, raw: unknown): ServerConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`servers.${alias}: expected an object, got: ${typeof raw}`);
  }
  const driverRaw = raw["driver"];
  if (typeof driverRaw !== "string" || driverRaw.length === 0) {
    throw new Error(
      `servers.${alias}.driver: required string field (e.g. "sqlite", "postgresql", "mongodb", ...)`,
    );
  }
  const policyRaw = raw["policy"];
  const policy =
    policyRaw === undefined
      ? undefined
      : (validatePolicyObject(
          `servers.${alias}.policy`,
          policyRaw,
          true,
        ) as Partial<PolicyRules>);

  const approvalModeRaw = raw["approval_mode"];
  if (
    approvalModeRaw !== undefined &&
    typeof approvalModeRaw !== "string"
  ) {
    throw new Error(
      `servers.${alias}.approval_mode: expected string, got: ${typeof approvalModeRaw}`,
    );
  }
  const out: ServerConfig = { driver: driverRaw };
  if (policy !== undefined) out.policy = policy;
  if (typeof approvalModeRaw === "string") out.approval_mode = approvalModeRaw;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "driver" || k === "policy" || k === "approval_mode") continue;
    out[k] = v;
  }
  return out;
}

function validateAudit(raw: unknown): AuditConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`audit: expected an object, got: ${typeof raw}`);
  }
  const enabled = raw["enabled"];
  const pathVal = raw["path"];
  if (typeof enabled !== "boolean") {
    throw new Error(`audit.enabled: expected boolean, got: ${typeof enabled}`);
  }
  if (enabled) {
    if (typeof pathVal !== "string" || pathVal.length === 0) {
      throw new Error(`audit.path: expected non-empty string when audit.enabled is true`);
    }
    return { enabled, path: pathVal };
  }
  if (pathVal !== undefined && pathVal !== null) {
    if (typeof pathVal !== "string" || pathVal.length === 0) {
      throw new Error(`audit.path: expected non-empty string when present`);
    }
    return { enabled, path: pathVal };
  }
  return { enabled };
}

/**
 * Validate a raw parsed YAML object against the plugin-config schema.
 * Throws a descriptive error on any shape or value violation.
 */
export function validatePluginConfig(raw: unknown): PluginConfig {
  if (!isPlainObject(raw)) {
    throw new Error(
      `plugin config: expected a YAML mapping at root, got: ${typeof raw}`,
    );
  }
  const policy = validatePolicyObject(
    "policy",
    raw["policy"],
    false,
  ) as PolicyRules;

  const serversRaw = raw["servers"];
  if (serversRaw === undefined || serversRaw === null) {
    throw new Error(
      `servers: required (at least one named server — keys are aliases)`,
    );
  }
  if (!isPlainObject(serversRaw)) {
    throw new Error(`servers: expected an object, got: ${typeof serversRaw}`);
  }
  if (Object.keys(serversRaw).length === 0) {
    throw new Error(`servers: must contain at least one named server`);
  }
  const servers: Record<string, ServerConfig> = {};
  for (const [alias, rawSrv] of Object.entries(serversRaw)) {
    servers[alias] = validateServer(alias, rawSrv);
  }

  const audit = validateAudit(raw["audit"]);

  const out: PluginConfig = { policy, servers };
  if (audit !== undefined) out.audit = audit;

  for (const k of Object.keys(raw)) {
    if (k !== "policy" && k !== "servers" && k !== "audit") {
      throw new Error(
        `plugin config: unknown top-level key '${k}' (expected: policy, servers, audit)`,
      );
    }
  }
  return out;
}

export interface LoadPluginConfigOptions {
  /** Explicit path (file is parsed directly). */
  explicitPath?: string;
}

/**
 * Parse + validate a plugin config from an explicit YAML file. Returns null
 * when the file is not plugin-shaped (no `policy:` or `servers:` at the
 * root) so callers can fall through to legacy parsers.
 *
 * V2.0: discovery via `~/.db-agent/` is removed. Standalone CLI runs read
 * from `~/.connectors/config.yaml` via `@narai/connector-config`. This API
 * remains for callers that pass `--config-path` directly.
 */
export function loadPluginConfig(
  opts: LoadPluginConfigOptions = {},
): PluginConfig | null {
  if (opts.explicitPath === undefined || opts.explicitPath.length === 0) {
    return null;
  }
  if (!fs.existsSync(opts.explicitPath)) {
    throw new Error(`Config file not found: ${opts.explicitPath}`);
  }
  const parsed = readYaml(opts.explicitPath);
  if (!isPluginShape(parsed)) return null;
  return validatePluginConfig(parsed);
}

function isPluginShape(raw: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(raw, "policy") ||
    Object.prototype.hasOwnProperty.call(raw, "servers")
  );
}

/**
 * Build a `PluginConfig` from a `connector-config`-resolved slice.
 *
 * The connector-config lib uses the new vocab natively. Each value in
 * `slice.policy` is mapped onto our `PolicyRules`; `slice.options.servers`
 * is validated through the same `validateServer` path so per-server
 * overrides are still safety-checked.
 */
export function pluginConfigFromSlice(slice: {
  policy?: Record<string, unknown>;
  options?: Record<string, unknown>;
}): PluginConfig {
  const policy = validatePolicyObject(
    "policy",
    slice.policy ?? {},
    false,
  ) as PolicyRules;

  const options = slice.options ?? {};
  const serversRaw = options["servers"];
  if (serversRaw === undefined || serversRaw === null) {
    throw new Error(
      `servers: required (at least one named server — keys are aliases)`,
    );
  }
  if (!isPlainObject(serversRaw)) {
    throw new Error(`servers: expected an object, got: ${typeof serversRaw}`);
  }
  if (Object.keys(serversRaw).length === 0) {
    throw new Error(`servers: must contain at least one named server`);
  }
  const servers: Record<string, ServerConfig> = {};
  for (const [alias, rawSrv] of Object.entries(serversRaw)) {
    servers[alias] = validateServer(alias, rawSrv);
  }

  const audit = validateAudit(options["audit"]);

  const out: PluginConfig = { policy, servers };
  if (audit !== undefined) out.audit = audit;
  return out;
}

// `parseCredentialRef`, `CredentialRef`, and `KNOWN_PROVIDERS` live in
// `narai-primitives/credentials` now.
