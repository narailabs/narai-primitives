/**
 * bootstrap — single-shot helper for connectors that runs at CLI startup.
 *
 * The hub injects `NARAI_CONFIG_BLOB` (a JSON-serialized `ResolvedConnector`)
 * when it spawns a connector subprocess. Standalone invocations have no blob
 * and fall back to reading `~/.connectors/config.yaml` directly.
 *
 * Either way, this helper hands the connector its resolved slice and applies
 * a per-connector mapping from YAML option keys to process.env entries, so
 * existing connector code that reads from env vars (e.g. `JIRA_API_TOKEN`,
 * `GCP_PROJECT_ID`) continues to work unchanged.
 */

import { loadResolvedConfig } from "./load.js";
import type { LoadOptions, ResolvedConnector } from "./types.js";

const ENV_PREFIX = "env:";

export interface LoadConnectorEnvironmentOptions extends LoadOptions {
  /**
   * Map of YAML option key → environment variable name. For each entry, if
   * the slice's `options[key]` resolves to a string value, set
   * `process.env[envName]` to it.
   */
  envMapping: Record<string, string>;
  /**
   * If true, overwrite existing `process.env` entries. Default: only set
   * when the env var is currently undefined, so manual exports always win.
   */
  overwrite?: boolean;
}

export async function loadConnectorEnvironment(
  connectorName: string,
  opts: LoadConnectorEnvironmentOptions,
): Promise<ResolvedConnector | null> {
  const slice = await loadOwnSlice(connectorName, opts);
  if (slice === null) return null;
  applyEnvMapping(slice, opts.envMapping, opts.overwrite ?? false);
  return slice;
}

/**
 * Load this connector's resolved slice — `NARAI_CONFIG_BLOB` first, else
 * the on-disk config files via `loadResolvedConfig`. Returns null when the
 * blob is malformed or the file doesn't list this connector.
 */
async function loadOwnSlice(
  connectorName: string,
  opts: LoadOptions,
): Promise<ResolvedConnector | null> {
  const blob = process.env["NARAI_CONFIG_BLOB"];
  if (typeof blob === "string" && blob !== "") {
    try {
      const parsed = JSON.parse(blob);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ResolvedConnector;
      }
    } catch {
      // bad blob — fall through to file load
    }
  }
  try {
    const loadOpts: LoadOptions = {};
    if (opts.consumer !== undefined) loadOpts.consumer = opts.consumer;
    if (opts.environment !== undefined) loadOpts.environment = opts.environment;
    if (opts.cwd !== undefined) loadOpts.cwd = opts.cwd;
    const resolved = await loadResolvedConfig(loadOpts);
    return resolved.connectors[connectorName] ?? null;
  } catch {
    return null;
  }
}

function applyEnvMapping(
  slice: ResolvedConnector,
  mapping: Record<string, string>,
  overwrite: boolean,
): void {
  for (const [optKey, envKey] of Object.entries(mapping)) {
    if (!overwrite && process.env[envKey] !== undefined) continue;
    const raw = slice.options[optKey];
    const value = resolveStringRef(raw);
    if (value !== undefined) {
      process.env[envKey] = value;
    }
  }
}

/**
 * Translate a config value into a concrete string — `env:NAME` becomes
 * `process.env.NAME`, plain strings pass through. Anything non-string or
 * a missing env var returns undefined.
 */
function resolveStringRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith(ENV_PREFIX)) {
    const name = value.slice(ENV_PREFIX.length);
    return process.env[name];
  }
  return value;
}
