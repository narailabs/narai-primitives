/**
 * parse_ref.ts — the `provider:key` reference-string syntax.
 *
 * Config values of the form `<provider>:<key>` are treated as references to
 * a secret backend. This module owns the string grammar and the allowlist
 * of known provider names. The resolution itself happens via
 * {@link resolveSecret} in `index.ts`.
 *
 * Recognized providers: `env`, `env_var`, `keychain`, `file`, `cloud`,
 * `cloud_secrets`. The `env`/`cloud` aliases normalize to the registered
 * names (`env_var`/`cloud_secrets`) so config files can stay concise.
 *
 * `file` references carry an embedded `:path.json:dotted.key` because the
 * FileProvider treats the secret name as a dotted path within a JSON file.
 */

/** Parsed reference split — `{provider, key}`. */
export interface CredentialRef {
  provider: string;
  key: string;
}

/** The closed set of provider prefixes we recognize in config values. */
export const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([
  "env",
  "env_var",
  "keychain",
  "file",
  "cloud",
  "cloud_secrets",
]);

/**
 * Parse a `provider:key` credential reference string. Returns `null` for
 * plain literals (no recognized provider prefix, empty key, or missing
 * colon).
 *
 * Empty colon-prefixed strings (`:foo`) are not references: the key starts
 * at position 0. Unknown provider names pass through as literals — the
 * caller gets back `null` and treats the original string as-is.
 */
export function parseCredentialRef(value: string): CredentialRef | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const provider = value.slice(0, colon);
  if (!KNOWN_PROVIDERS.has(provider)) return null;
  const key = value.slice(colon + 1);
  if (key.length === 0) return null;
  // Normalize the short aliases to the registered provider names used by
  // resolveSecret(). `env` → `env_var`, `cloud` → `cloud_secrets`.
  const normalized =
    provider === "env"
      ? "env_var"
      : provider === "cloud"
        ? "cloud_secrets"
        : provider;
  return { provider: normalized, key };
}
