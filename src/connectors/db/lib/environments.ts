/**
 * environments.ts — Environment configuration registry for wiki_db.
 *
 * Mirrors `environments.py`:
 *  - `EnvironmentConfig` is an immutable plain object (frozen).
 *  - `registerEnvironment` / `getEnvironment` / `listEnvironments` /
 *    `clearEnvironments` operate on a module-level `Map`.
 *
 * Note: Python uses hyphenated approval modes for the environment layer
 * (`confirm-once`, not `confirm_once`). This matches the existing Python
 * tests, which assert on the hyphenated form. The Policy class continues
 * to accept underscores only; the env layer is purely metadata.
 *
 * v2 (plugin config): environments may carry arbitrary driver-specific
 * `extras` (passed through to `driver.connect(envCfg)`) and an optional
 * per-env `policy` rule map (merged with the global defaults by the
 * plugin-config loader).
 */
import type { PolicyRules } from "./plugin_config.js";

/** Valid approval modes for env registration (hyphenated, per Python). */
const _VALID_APPROVAL_MODES: ReadonlySet<string> = new Set([
  "auto", "confirm-once", "confirm-each", "grant-required",
]);

/** Immutable configuration for a database environment. */
export interface EnvironmentConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly schema: string;
  readonly approval_mode: string;
  readonly driver: string;
  /**
   * Duration of a read grant issued via `grant-required` approval mode,
   * in hours. Consumed by `grantFromEnv()` in policy.ts. Per v2 design §4,
   * the default is 8 hours; callers may override per-environment.
   */
  readonly grant_duration_hours?: number;
  /**
   * Arbitrary driver-specific fields (user, password, ssl, region, endpoint,
   * url, pool, ttl, etc.). Passed through to `driver.connect(envCfg)` so
   * each driver can pick up its own knobs without the registry needing to
   * know about them. Populated by the plugin-config path; empty for
   * legacy `wiki.config.yaml` environments.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
  /**
   * Merged policy rules (global defaults + per-server override). Populated
   * by the plugin-config path. When undefined, callers should fall back to
   * `DEFAULT_POLICY` — which matches the legacy hard-coded behaviour.
   */
  readonly policy?: PolicyRules;
}

const _registry: Map<string, EnvironmentConfig> = new Map();

export interface RegisterEnvironmentOptions {
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  approval_mode?: string;
  driver?: string;
  grant_duration_hours?: number;
  extras?: Record<string, unknown>;
  policy?: PolicyRules;
}

/** Register a named environment configuration. */
export function registerEnvironment(
  name: string,
  opts: RegisterEnvironmentOptions,
): void {
  const {
    host = "",
    port = 0,
    database = "",
    schema = "public",
    approval_mode = "auto",
    driver = "postgresql",
    grant_duration_hours,
    extras,
    policy,
  } = opts;
  if (!_VALID_APPROVAL_MODES.has(approval_mode)) {
    // Python sorts the frozenset; mirror that for parity with pytest-match.
    const sorted = [..._VALID_APPROVAL_MODES].sort();
    const sortedRepr = "[" + sorted.map((s) => `'${s}'`).join(", ") + "]";
    throw new Error(
      `approval_mode must be one of ${sortedRepr}, got '${approval_mode}'`,
    );
  }
  const base: {
    host: string;
    port: number;
    database: string;
    schema: string;
    approval_mode: string;
    driver: string;
    grant_duration_hours?: number;
    extras?: Readonly<Record<string, unknown>>;
    policy?: PolicyRules;
  } = {
    host,
    port,
    database,
    schema,
    approval_mode,
    driver,
  };
  if (grant_duration_hours !== undefined) {
    base.grant_duration_hours = grant_duration_hours;
  }
  if (extras !== undefined) {
    base.extras = Object.freeze({ ...extras });
  }
  if (policy !== undefined) {
    base.policy = Object.freeze({ ...policy });
  }
  const cfg: EnvironmentConfig = Object.freeze(base);
  _registry.set(name, cfg);
}

/** Return the config for `name`, or throw an EnvironmentNotRegisteredError. */
export function getEnvironment(name: string): EnvironmentConfig {
  const cfg = _registry.get(name);
  if (cfg === undefined) {
    const err = new Error(`Environment '${name}' is not registered`);
    err.name = "EnvironmentNotRegisteredError";
    throw err;
  }
  return cfg;
}

/** Return a list of registered environment names. */
export function listEnvironments(): string[] {
  return [..._registry.keys()];
}

/** Remove all registered environments. */
export function clearEnvironments(): void {
  _registry.clear();
}
