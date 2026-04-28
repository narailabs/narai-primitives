/**
 * Universal types shared by the hub, every connector, and any consumer
 * that reads ~/.connectors/config.yaml.
 *
 * Only fields universal to every connector are declared with strict types.
 * Anything connector-specific (db's `servers:`, jira's `atlassian-api-key`,
 * etc.) flows through as opaque entries on `ResolvedConnector.options` and
 * is validated by the connector itself when it consumes its slice.
 */

/** The five canonical policy actions every connector understands. */
export type PolicyAction = "read" | "write" | "delete" | "admin" | "privilege";

/** The base policy decisions. db-agent extends this with `present`. */
export type PolicyDecision = "allow" | "escalate" | "deny" | "present";

/**
 * A policy block. Universal actions (read/write/...) take a PolicyDecision;
 * connector-specific extras (e.g. `unbounded_select` for db-agent) may take
 * any string value. The library does not interpret extras — the connector
 * does.
 */
export interface PolicyMap {
  read?: PolicyDecision;
  write?: PolicyDecision;
  delete?: PolicyDecision;
  admin?: PolicyDecision;
  privilege?: PolicyDecision;
  /** Connector-specific extras (e.g. `unbounded_select`). */
  [extra: string]: PolicyDecision | string | undefined;
}

/**
 * The raw input shape — what `js-yaml` returns from a ~/.connectors/config.yaml
 * file. Loose by design: the actual interpretation happens in resolve.ts.
 */
export type RawConfigInput = Record<string, unknown>;

/** Options consumed by the public API. */
export interface LoadOptions {
  /** Apply `consumers.<name>` overrides on top of base + environment. */
  consumer?: string;
  /** Pick a specific environment. Falls back to `environments.default`. */
  environment?: string;
  /** CWD for resolving `./.connectors/config.yaml`. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Same as LoadOptions but without `cwd`, used by the in-memory resolver. */
export interface ResolveOptions {
  consumer?: string;
  environment?: string;
}

/**
 * The fully-resolved view of one connector's effective config for a given
 * (consumer, environment) pair.
 */
export interface ResolvedConnector {
  /** Connector name, matching its key under `connectors:` in the config. */
  name: string;
  /**
   * Whether this connector is active for the current call. False if the
   * consumer's `enabled:` allowlist excludes it, or if any merge level set
   * `disable: true`.
   */
  enabled: boolean;
  /**
   * `skill:` value, unresolved. Three syntaxes:
   *   - bare word (`jira-agent-connector`) → built-in connector skill.
   *   - starts with `~` (`~/.claude/skills/foo`) → user-level skill at that path.
   *   - other (`./path/to/skill`, `path/to/skill`) → repo-level skill resolved
   *     against the consumer's CWD.
   * Path-to-disk and SKILL.md content resolution lives in
   * `@narai/connector-toolkit`, not here.
   */
  skill: string;
  /** Per-connector model override; null means inherit. */
  model: string | null;
  /** Whether this connector's guardrail rules participate in the unified hook. */
  enforce_hooks: boolean;
  /** Effective policy after base+env+consumer merge. */
  policy: PolicyMap;
  /**
   * All connector-specific extras (`audit`, `servers`, `atlassian-api-key`,
   * etc.). Secrets like `env:NAME` are passed through unresolved so each
   * connector can resolve them lazily at use time.
   */
  options: Record<string, unknown>;
}

/** The fully-resolved view of the whole config for a given call. */
export interface ResolvedConfig {
  /** Hub-specific settings. Read by `@narai/connector-hub`. */
  hub: {
    model: string | null;
    max_tokens: number | null;
  };
  /** Top-level policy defaults (apply unless a connector overrides). */
  policy: PolicyMap;
  /** Top-level enforce_hooks default. */
  enforce_hooks: boolean;
  /** Top-level model default; null means inherit from the active session. */
  model: string | null;
  /** Resolved environment name, or null if none was selected. */
  environment: string | null;
  /** Resolved consumer name, or null if none was provided. */
  consumer: string | null;
  /** Per-connector resolved views. */
  connectors: Record<string, ResolvedConnector>;
}
