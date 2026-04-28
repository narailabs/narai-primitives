/**
 * Apply environment + consumer overrides on top of a base config and
 * materialize a strongly-typed `ResolvedConfig`.
 *
 * Merge order (latest wins):
 *   1. base (user file ⊕ repo file)
 *   2. environments.<envName>
 *   3. consumers.<consumerName>
 *
 * Environment and consumer blocks may override top-level fields
 * (`model`, `policy`, `enforce_hooks`, `hub`) AND per-connector blocks
 * (any non-reserved key is treated as a connector name). A consumer
 * additionally accepts `enabled: [...]` to filter which connectors are
 * active for that consumer.
 */

import { deepMerge } from "./load.js";
import type {
  PolicyMap,
  RawConfigInput,
  ResolveOptions,
  ResolvedConfig,
  ResolvedConnector,
} from "./types.js";

/** Reserved keys at the top of a consumer block (everything else is a connector override). */
const RESERVED_CONSUMER_KEYS = new Set([
  "enabled",
  "policy",
  "model",
  "enforce_hooks",
  "hub",
]);

/** Reserved keys at the top of an environment block. */
const RESERVED_ENVIRONMENT_KEYS = new Set([
  "policy",
  "model",
  "enforce_hooks",
  "hub",
]);

/** Reserved per-connector fields the lib understands directly; everything else flows into `options`. */
const RESERVED_CONNECTOR_FIELDS = new Set([
  "skill",
  "model",
  "enforce_hooks",
  "policy",
  "disable",
]);

export function resolveConfig(raw: RawConfigInput, opts: ResolveOptions = {}): ResolvedConfig {
  // 1. Determine the active environment (explicit override > environments.default > none).
  const environments = (raw["environments"] as Record<string, unknown> | undefined) ?? {};
  const defaultEnvName = typeof environments["default"] === "string" ? environments["default"] : undefined;
  const envName: string | null = opts.environment ?? defaultEnvName ?? null;

  // 2. Apply environment overrides on top of the base.
  let merged: Record<string, unknown> = { ...raw };
  if (envName !== null) {
    const envBlock = environments[envName];
    if (envBlock === undefined) {
      throw new Error(`Environment '${envName}' not found in config.`);
    }
    if (!isPlainObject(envBlock)) {
      throw new Error(`Environment '${envName}' must be a mapping.`);
    }
    merged = applyOverlay(merged, envBlock as Record<string, unknown>, RESERVED_ENVIRONMENT_KEYS);
  }

  // 3. Apply consumer overrides.
  //
  // The consumers block is *optional*. A consumer requested via opts.consumer
  // that has no entry in `consumers.<name>` is treated as "no overrides" —
  // the base config (with environment overlay already applied) is used as-is.
  // This lets every consumer share the default connector setup and only opt
  // in to overrides when they actually need them, instead of forcing every
  // user to declare a stub block.
  //
  // A non-mapping consumer block is still an error (it's almost certainly a
  // typo in YAML).
  const consumerName: string | null = opts.consumer ?? null;
  let enabledList: Set<string> | null = null;
  if (consumerName !== null) {
    const consumers = (raw["consumers"] as Record<string, unknown> | undefined) ?? {};
    const consumerBlock = consumers[consumerName];
    if (consumerBlock !== undefined) {
      if (!isPlainObject(consumerBlock)) {
        throw new Error(`Consumer '${consumerName}' must be a mapping.`);
      }
      const block = consumerBlock as Record<string, unknown>;
      merged = applyOverlay(merged, block, RESERVED_CONSUMER_KEYS);
      const enabled = block["enabled"];
      if (Array.isArray(enabled)) {
        enabledList = new Set(enabled.filter((x): x is string => typeof x === "string"));
      }
    }
  }

  return materialize(merged, envName, consumerName, enabledList);
}

/**
 * Apply an overlay block to `merged`. Reserved keys (top-level
 * settings) deep-merge into top-level fields; non-reserved keys are
 * treated as connector names and deep-merge into `connectors[name]`.
 */
function applyOverlay(
  merged: Record<string, unknown>,
  overlay: Record<string, unknown>,
  reservedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...merged };
  // Top-level field overrides
  for (const k of reservedKeys) {
    if (k === "enabled") continue; // consumer-only, handled by caller
    if (overlay[k] !== undefined) {
      next[k] = deepMerge(next[k], overlay[k]);
    }
  }
  // Per-connector overrides (any non-reserved key)
  const baseConnectors = isPlainObject(next["connectors"])
    ? { ...(next["connectors"] as Record<string, unknown>) }
    : {};
  for (const [k, v] of Object.entries(overlay)) {
    if (reservedKeys.has(k)) continue;
    if (v === undefined) continue;
    baseConnectors[k] = deepMerge(baseConnectors[k], v);
  }
  next["connectors"] = baseConnectors;
  return next;
}

function materialize(
  merged: Record<string, unknown>,
  envName: string | null,
  consumerName: string | null,
  enabledList: Set<string> | null,
): ResolvedConfig {
  const connectorsRaw = isPlainObject(merged["connectors"])
    ? (merged["connectors"] as Record<string, unknown>)
    : {};

  const topPolicy: PolicyMap = isPlainObject(merged["policy"])
    ? (merged["policy"] as PolicyMap)
    : {};
  const topEnforceHooks: boolean = typeof merged["enforce_hooks"] === "boolean"
    ? (merged["enforce_hooks"] as boolean)
    : true;
  const topModel: string | null = typeof merged["model"] === "string"
    ? (merged["model"] as string)
    : null;

  const resolvedConnectors: Record<string, ResolvedConnector> = {};
  for (const [name, blockRaw] of Object.entries(connectorsRaw)) {
    if (!isPlainObject(blockRaw)) {
      throw new Error(`Connector '${name}' must be a mapping.`);
    }
    const block = blockRaw as Record<string, unknown>;

    const disabled = block["disable"] === true;
    const inEnabledList = enabledList === null || enabledList.has(name);
    const enabled = inEnabledList && !disabled;

    const skill = typeof block["skill"] === "string" ? (block["skill"] as string) : "";
    if (skill === "" && enabled) {
      throw new Error(`Connector '${name}' is enabled but has no 'skill' set.`);
    }

    const model = typeof block["model"] === "string"
      ? (block["model"] as string)
      : null;

    const enforceHooks = typeof block["enforce_hooks"] === "boolean"
      ? (block["enforce_hooks"] as boolean)
      : topEnforceHooks;

    const blockPolicy: PolicyMap = isPlainObject(block["policy"])
      ? (block["policy"] as PolicyMap)
      : {};
    const policy: PolicyMap = { ...topPolicy, ...blockPolicy };

    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(block)) {
      if (!RESERVED_CONNECTOR_FIELDS.has(k)) {
        options[k] = v;
      }
    }

    resolvedConnectors[name] = {
      name,
      enabled,
      skill,
      model,
      enforce_hooks: enforceHooks,
      policy,
      options,
    };
  }

  const hubRaw = isPlainObject(merged["hub"])
    ? (merged["hub"] as Record<string, unknown>)
    : {};

  return {
    hub: {
      model: typeof hubRaw["model"] === "string" ? (hubRaw["model"] as string) : null,
      max_tokens: typeof hubRaw["max_tokens"] === "number" ? (hubRaw["max_tokens"] as number) : null,
    },
    policy: { ...topPolicy },
    enforce_hooks: topEnforceHooks,
    model: topModel,
    environment: envName,
    consumer: consumerName,
    connectors: resolvedConnectors,
  };
}

/**
 * Convenience: pull a single connector's resolved view by name. Throws if
 * the name is missing from the resolved config.
 */
export function resolveConnector(name: string, resolved: ResolvedConfig): ResolvedConnector {
  const slice = resolved.connectors[name];
  if (slice === undefined) {
    throw new Error(`Connector '${name}' not found in resolved config.`);
  }
  return slice;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
