/**
 * parse_ref.ts — the `provider:key` reference-string syntax.
 *
 * Config values of the form `<provider>:<key>` are treated as references to
 * a secret backend. This module owns the string grammar and decides whether
 * a parsed prefix counts as a known provider. The resolution itself happens
 * via {@link CredentialResolver.resolveSecret}.
 *
 * Recognized providers come from two sources, unioned:
 *   1. The resolver's registry (custom providers registered at runtime).
 *   2. A small fallback allowlist of built-in names
 *      (`env_var`, `keychain`, `file`, `cloud_secrets`) so that callers can
 *      parse references written against the built-ins without first
 *      registering provider instances.
 *
 * Aliases (`env` → `env_var`, `cloud` → `cloud_secrets`) are normalization
 * only — they are NOT gating and apply before the recognition check.
 *
 * `file` references carry an embedded `:path.json:dotted.key` because the
 * FileProvider treats the secret name as a dotted path within a JSON file.
 */
import { defaultResolver, type CredentialResolver } from "./index.js";

/** Parsed reference split — `{provider, key}`. */
export interface CredentialRef {
  provider: string;
  key: string;
}

export interface ParseCredentialRefOptions {
  /**
   * When true, unknown provider prefixes throw rather than returning null.
   * Useful when the caller wants to catch typos in config up front.
   */
  strict?: boolean;
  /**
   * Resolver whose registry contributes to the recognized-provider set.
   * Defaults to the module-level {@link defaultResolver}.
   */
  resolver?: CredentialResolver;
}

/**
 * Fallback allowlist of built-in provider names. Kept alongside the
 * registry so references to `env_var:*`, `keychain:*`, etc. parse
 * successfully before a provider instance is registered — this preserves
 * the ergonomic "validate config at startup, construct providers later"
 * flow used by most consumers.
 */
const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set([
  "env_var",
  "keychain",
  "file",
  "cloud_secrets",
]);

/**
 * Parse a `provider:key` credential reference string. Returns `null` for
 * plain literals (no recognized provider prefix, empty key, or missing
 * colon).
 *
 * Empty colon-prefixed strings (`:foo`) are not references: the key starts
 * at position 0. Unknown provider names return `null` by default, or throw
 * when `options.strict` is true.
 */
export function parseCredentialRef(
  value: string,
  options: ParseCredentialRefOptions = {},
): CredentialRef | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const rawProvider = value.slice(0, colon);
  const key = value.slice(colon + 1);
  if (key.length === 0) return null;

  // Normalize the short aliases to the registered provider names used by
  // resolveSecret(). `env` → `env_var`, `cloud` → `cloud_secrets`.
  const provider =
    rawProvider === "env"
      ? "env_var"
      : rawProvider === "cloud"
        ? "cloud_secrets"
        : rawProvider;

  const resolver = options.resolver ?? defaultResolver;
  const known =
    resolver.get(provider) !== undefined || BUILTIN_PROVIDERS.has(provider);
  if (!known) {
    if (options.strict) {
      throw new Error(
        `unknown credential provider '${rawProvider}' in '${value}'`,
      );
    }
    return null;
  }
  return { provider, key };
}
