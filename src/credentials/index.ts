/**
 * credential_providers — pluggable secret-backend layer.
 *
 * Each provider implements {@link CredentialProvider}. A {@link CredentialResolver}
 * instance keeps a named registry of providers and exposes `resolveSecret`,
 * which chains providers in the given fallback order and returns the first
 * non-null hit.
 *
 * A module-level {@link defaultResolver} plus thin delegators
 * (`registerProvider`, `resolveSecret`, …) are provided so callers that only
 * need a single global registry can keep their imports flat.
 */
import { parseCredentialRef } from "./parse_ref.js";

/** Minimal interface every secret backend satisfies. */
export interface CredentialProvider {
  /** Look up a secret by logical name. Returns `null` on miss. */
  getSecret(name: string): Promise<string | null>;
  /**
   * Optional synchronous lookup, for callers that cannot await (module-level
   * config resolution, legacy synchronous dispatchers). Providers backed by
   * sync-capable stores (`process.env`, `fs.readFileSync`) implement this;
   * keychain and cloud providers do not because their backing APIs are
   * async-only. Callers that need broad backend coverage should prefer
   * `getSecret`.
   */
  getSecretSync?(name: string): string | null;
  /**
   * Optional metadata lookup. Default built-in providers fall back to
   * calling getSecret and reporting `{exists, provider}` only. Cloud
   * providers may override to surface real version / lastModified data.
   */
  describeSecret?(name: string): Promise<SecretMetadata | null>;
}

export interface SecretMetadata {
  /** True when the secret exists in this backend. */
  exists: boolean;
  /** Backend-reported version identifier, if available. */
  version?: string;
  /** When the secret was last modified, if the backend tracks it. */
  lastModified?: Date;
  /** Which registered provider name produced this record. */
  provider: string;
}

export interface ResolveSecretOptions {
  /** Primary provider name. If unset, uses the first registered provider. */
  provider?: string;
  /**
   * Ordered fallback provider names. Tried in order after the primary
   * returns `null` or throws.
   */
  fallback?: string[];
}

export interface ResolveSecretsOptions {
  /** When true, any null result (miss) causes the batch to reject. */
  strict?: boolean;
}

/**
 * A named registry of {@link CredentialProvider} instances plus the
 * `resolveSecret` chain. Instantiate your own resolver for test isolation,
 * multi-tenant setups, or any case where the module-level {@link defaultResolver}
 * is too coarse.
 */
export class CredentialResolver {
  private readonly _registry = new Map<string, CredentialProvider>();

  /** Register a provider under a short name (`keychain`, `env_var`, …). */
  register(name: string, provider: CredentialProvider): void {
    this._registry.set(name, provider);
  }

  /** Look up a provider previously registered via {@link register}. */
  get(name: string): CredentialProvider | undefined {
    return this._registry.get(name);
  }

  /** Drop all registered providers. */
  clear(): void {
    this._registry.clear();
  }

  /** Return the list of currently registered provider names. */
  list(): string[] {
    return [...this._registry.keys()];
  }

  /**
   * Resolve a secret through a primary provider and optional fallback chain.
   *
   * Returns `null` if no provider produces a value while at least one
   * provider runs to completion (hit or miss). If *every* provider throws,
   * an `AggregateError` is raised whose `.errors` array preserves each
   * original error in the order providers were tried.
   */
  async resolveSecret(
    name: string,
    options: ResolveSecretOptions = {},
  ): Promise<string | null> {
    const order: string[] = [];
    if (options.provider) order.push(options.provider);
    if (options.fallback) order.push(...options.fallback);
    if (order.length === 0) {
      // Default: iterate whatever is in the registry, insertion order.
      order.push(...this._registry.keys());
    }

    const errors: unknown[] = [];
    let anySuccess = false;
    for (const providerName of order) {
      const provider = this._registry.get(providerName);
      if (!provider) continue;
      try {
        const value = await provider.getSecret(name);
        anySuccess = true;
        if (value !== null) return value;
      } catch (err) {
        errors.push(err);
      }
    }

    if (!anySuccess && errors.length > 0) {
      throw new AggregateError(
        errors,
        `resolveSecret('${name}') failed: all ${errors.length} provider(s) threw`,
      );
    }
    return null;
  }

  /**
   * Resolve multiple credential references in parallel.
   *
   * Each entry in `specs` maps an alias to a reference string (e.g.
   * `{db: "env:PGPASSWORD", token: "keychain:gh"}`). Every reference is
   * parsed up front with `strict: true` so typos in config surface at
   * batch time rather than silently returning null.
   *
   * Per-alias errors are collected and re-thrown as an `AggregateError`
   * — individual errors are wrapped to include their alias name so the
   * `.errors` array is self-describing. With `strict: true`, any null
   * result (miss) also causes the batch to reject.
   */
  async resolveSecrets(
    specs: Record<string, string>,
    options: ResolveSecretsOptions = {},
  ): Promise<Record<string, string | null>> {
    const aliases = Object.keys(specs);
    const parsed = aliases.map((alias) => ({
      alias,
      ref: parseCredentialRef(specs[alias] as string, {
        strict: true,
        resolver: this,
      }),
    }));

    const settled = await Promise.allSettled(
      parsed.map(({ ref }) => {
        if (ref === null) return Promise.resolve(null);
        return this.resolveSecret(ref.key, { provider: ref.provider });
      }),
    );

    const errors: Error[] = [];
    const failedAliases: string[] = [];
    const out: Record<string, string | null> = {};
    for (let i = 0; i < aliases.length; i++) {
      const alias = aliases[i] as string;
      const result = settled[i];
      if (result === undefined) continue;
      if (result.status === "rejected") {
        const original = result.reason;
        const origMsg =
          original instanceof Error
            ? original.message
            : String(original);
        const wrapped = new Error(
          `resolveSecrets: alias "${alias}" failed: ${origMsg}`,
        );
        errors.push(wrapped);
        failedAliases.push(alias);
      } else {
        out[alias] = result.value;
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `resolveSecrets failed for: ${failedAliases.join(", ")}`,
      );
    }

    if (options.strict) {
      const missingAliases = aliases.filter((a) => out[a] === null);
      if (missingAliases.length > 0) {
        throw new Error(
          `resolveSecrets strict: aliases returned null: ${missingAliases.join(", ")}`,
        );
      }
    }

    return out;
  }
}

/**
 * Built-in provider short names. Matches the reference-string aliases
 * recognized by `parseCredentialRef` (`env` → `env_var`, `cloud` →
 * `cloud_secrets`). Consumers can iterate or narrow against this literal;
 * the tuple is frozen so runtime mutation is rejected in strict mode.
 */
export const KNOWN_PROVIDERS = Object.freeze([
  "env",
  "keychain",
  "file",
  "cloud",
] as const) satisfies readonly ["env", "keychain", "file", "cloud"];
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** Shared resolver used by the module-level delegators below. */
export const defaultResolver = new CredentialResolver();

/** Register a provider on the {@link defaultResolver}. */
export const registerProvider = defaultResolver.register.bind(defaultResolver);
/** Look up a provider on the {@link defaultResolver}. */
export const getProvider = defaultResolver.get.bind(defaultResolver);
/** Drop all providers from the {@link defaultResolver} (test helper). */
export const clearProviders = defaultResolver.clear.bind(defaultResolver);
/** List provider names registered on the {@link defaultResolver}. */
export const listProviders = defaultResolver.list.bind(defaultResolver);
/** Resolve a secret via the {@link defaultResolver}. */
export const resolveSecret =
  defaultResolver.resolveSecret.bind(defaultResolver);
/** Resolve a batch of credential references via the {@link defaultResolver}. */
export const resolveSecrets =
  defaultResolver.resolveSecrets.bind(defaultResolver);

// Re-export provider implementations so callers can import everything from
// `narai-primitives/credentials` directly.
export { FileProvider } from "./file.js";
export { EnvVarProvider } from "./env_var.js";
export { KeychainProvider } from "./keychain.js";
export { CloudSecretsProvider } from "./cloud_secrets.js";
export type { CloudSecretsConfig, CloudSubProvider } from "./cloud_secrets.js";

// Reference-string grammar. Config consumers call `parseCredentialRef` on
// each string value to decide whether it's a literal or a reference into
// one of the registered providers. See `parse_ref.ts` for the grammar.
export { parseCredentialRef } from "./parse_ref.js";
export type {
  CredentialRef,
  ParseCredentialRefOptions,
} from "./parse_ref.js";

export { redact, redactAll } from "./redact.js";
