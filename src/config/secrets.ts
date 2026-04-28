/**
 * Secret-reference syntax validation.
 *
 * V1 only validates syntax — it does not eagerly resolve secrets. Strings
 * starting with `env:NAME` pass through unchanged so each connector can
 * resolve them lazily via its own credential-providers chain at the moment
 * of use. The wrong form `env.NAME` (with a dot) is rejected with a clear
 * error so it doesn't silently flow through as a literal.
 */

const REJECTED_DOT_PREFIX = "env.";

/**
 * Throws if the string uses the wrong form. Other content (including
 * `env:NAME`, `keychain:NAME`, plain literals) is accepted unchanged.
 */
export function assertValidSecretSyntax(value: string, location?: string): void {
  if (value.startsWith(REJECTED_DOT_PREFIX)) {
    const loc = location !== undefined ? ` at ${location}` : "";
    throw new Error(
      `Invalid secret reference '${value}'${loc}. Use 'env:NAME' (with a colon), not 'env.NAME' (with a dot).`,
    );
  }
}

/**
 * Recursively validates every string in a value tree. Throws on the first
 * malformed reference, with a dotted path indicating where the bad value lives.
 */
export function validateSecretsInTree(node: unknown, path = ""): void {
  if (typeof node === "string") {
    assertValidSecretSyntax(node, path === "" ? undefined : path);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      validateSecretsInTree(node[i], `${path}[${i}]`);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const next = path === "" ? k : `${path}.${k}`;
      validateSecretsInTree(v, next);
    }
  }
}
