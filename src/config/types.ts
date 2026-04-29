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

/**
 * The base policy decisions every connector understands. Connectors with
 * outcomes beyond this (e.g. db's `present`) declare them locally and
 * specialize `PolicyMap` / `ResolvedConnector` via the `TExtra` parameter.
 */
export type PolicyDecision = "allow" | "escalate" | "deny";

/**
 * A policy block. Universal actions (read/write/...) take a `PolicyDecision`,
 * optionally widened by a connector-specific `TExtra` string union (e.g.
 * `PolicyMap<"present">` for db-agent). Connector-specific extra *actions*
 * (e.g. `unbounded_select` for db-agent) flow through the index signature
 * with no constraint — the library does not interpret them; the connector
 * does.
 *
 * Default `TExtra = string` keeps the type connector-agnostic (any string
 * value is admitted) so the hub and resolve layer can pass policy blocks
 * around without knowing which connector they target. Code that wants
 * strict typing — db-agent, custom connectors — specializes.
 */
export interface PolicyMap<TExtra extends string = string> {
  read?: PolicyDecision | TExtra;
  write?: PolicyDecision | TExtra;
  delete?: PolicyDecision | TExtra;
  admin?: PolicyDecision | TExtra;
  privilege?: PolicyDecision | TExtra;
  /** Connector-specific extras (e.g. `unbounded_select`). */
  [extra: string]: PolicyDecision | TExtra | string | undefined;
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
 * (consumer, environment) pair. `TExtra` mirrors `PolicyMap`'s parameter so
 * a connector that defines extra decision values (e.g. db's `"present"`)
 * can specialize once and have its policy slot strictly typed throughout.
 */
export interface ResolvedConnector<TExtra extends string = string> {
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
  policy: PolicyMap<TExtra>;
  /**
   * All connector-specific extras (`audit`, `servers`, `atlassian-api-key`,
   * etc.). Secrets like `env:NAME` are passed through unresolved so each
   * connector can resolve them lazily at use time.
   */
  options: Record<string, unknown>;
}

/**
 * The fully-resolved view of the whole config for a given call. `TExtra`
 * widens the policy decision union for both the top-level `policy` and
 * every connector slice; the hub keeps the default `string` so it doesn't
 * have to know what extras any individual connector contributes.
 */
export interface ResolvedConfig<TExtra extends string = string> {
  /** Hub-specific settings. Read by `@narai/connector-hub`. */
  hub: {
    model: string | null;
    max_tokens: number | null;
  };
  /** Top-level policy defaults (apply unless a connector overrides). */
  policy: PolicyMap<TExtra>;
  /** Top-level enforce_hooks default. */
  enforce_hooks: boolean;
  /** Top-level model default; null means inherit from the active session. */
  model: string | null;
  /** Resolved environment name, or null if none was selected. */
  environment: string | null;
  /** Resolved consumer name, or null if none was provided. */
  consumer: string | null;
  /** Per-connector resolved views. */
  connectors: Record<string, ResolvedConnector<TExtra>>;
}
