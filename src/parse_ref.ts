/**
 * parse_ref.ts — the `provider:key` reference-string syntax.
 *
 * Config values of the form `<provider>:<key>` (bare) or
 * `<scheme>://<rest>` (URI) are treated as references to a secret backend.
 * This module owns the string grammar and decides whether a parsed prefix
 * counts as a known provider. The resolution itself happens via
 * {@link CredentialResolver.resolveSecret}.
 *
 * Recognized providers come from two sources, unioned:
 *   1. The resolver's registry (custom providers registered at runtime).
 *   2. A small fallback allowlist of built-in names
 *      (`env_var`, `keychain`, `file`, `cloud_secrets`) so that callers can
 *      parse references written against the built-ins without first
 *      registering provider instances.
 *
 * Aliases (`env` -> `env_var`, `cloud` -> `cloud_secrets`) are normalization
 * only - they are NOT gating and apply before the recognition check.
 *
 * `file` references carry an embedded `:path.json:dotted.key` because the
 * FileProvider treats the secret name as a dotted path within a JSON file.
 * URI-form `file:///p/creds.json#dotted.key` is normalized back into that
 * shape so the FileProvider itself needs no URI awareness.
 */
import { defaultResolver, type CredentialResolver } from "./index.js";

/** Parsed reference split - `{provider, key}`. */
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
 * successfully before a provider instance is registered - this preserves
 * the ergonomic "validate config at startup, construct providers later"
 * flow used by most consumers.
 */
const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set([
  "env_var",
  "keychain",
  "file",
  "cloud_secrets",
]);

/** Matches `scheme://...` where scheme follows RFC 3986 (letter + alnum/+/-/.). */
const URI_FORM = /^[a-z][a-z0-9_+.-]*:\/\//i;

/**
 * Normalize a URI-form reference into `{rawProvider, key}`.
 *
 * Two paths, because the WHATWG URL parser only treats a short list of
 * "special" schemes (http, https, ws, wss, ftp, file) as authority-based.
 * For a custom scheme like `env://DB` the URL parser folds the `//` into
 * the pathname - not useful. So:
 *
 *   - `file:` -> `new URL()`, then recombine `pathname` and the `hash`
 *     fragment into the FileProvider's native `<path>:<dotted.key>`
 *     shape. Windows drive paths parse with a leading slash
 *     (`file:///C:/...` -> pathname `/C:/...`); we keep it so the recombined
 *     key reads `/C:/creds.json:user` - FileProvider opens the absolute
 *     path normally.
 *   - Any other scheme -> plain split on `://`: take everything after as
 *     the key. `env://A/B` -> key `A/B`; `env://` -> empty -> null upstream.
 *     Predictable without per-scheme authority/path rules.
 */
function parseUriForm(
  value: string,
): { rawProvider: string; key: string } | null {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd <= 0) return null;
  const rawProvider = value.slice(0, schemeEnd);

  if (rawProvider === "file") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const path = decodeURIComponent(url.pathname);
    const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
    const key = fragment ? `${path}:${fragment}` : path;
    return { rawProvider, key };
  }

  return { rawProvider, key: value.slice(schemeEnd + 3) };
}

/**
 * Parse a credential reference string.
 *
 * Accepts two forms:
 *   - **Bare:** `provider:key` (e.g. `env:DB_PASSWORD`)
 *   - **URI:**  `scheme://rest` (e.g. `env://DB_PASSWORD`,
 *     `file:///etc/creds.json#staging.password`)
 *
 * Returns `null` for plain literals: no recognized provider prefix, empty
 * key, missing colon, or - for bare form - a leading colon (the key starts
 * at position 0). Unknown provider names return `null` by default, or throw
 * when `options.strict` is true.
 */
export function parseCredentialRef(
  value: string,
  options: ParseCredentialRefOptions = {},
): CredentialRef | null {
  let rawProvider: string;
  let key: string;

  if (URI_FORM.test(value)) {
    const parsed = parseUriForm(value);
    if (parsed === null) return null;
    rawProvider = parsed.rawProvider;
    key = parsed.key;
  } else {
    const colon = value.indexOf(":");
    if (colon <= 0) return null;
    rawProvider = value.slice(0, colon);
    key = value.slice(colon + 1);
  }
  if (key.length === 0) return null;

  // Normalize the short aliases to the registered provider names used by
  // resolveSecret(). `env` -> `env_var`, `cloud` -> `cloud_secrets`.
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
