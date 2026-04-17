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

/** Minimal interface every secret backend satisfies. */
export interface CredentialProvider {
  /** Look up a secret by logical name. Returns `null` on miss. */
  getSecret(name: string): Promise<string | null>;
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
}

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

// Re-export provider implementations so callers can import everything from
// `@narai/credential-providers` directly.
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
