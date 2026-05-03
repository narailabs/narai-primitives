/**
 * redact.ts — string redaction helpers for secret-safe logging.
 *
 * Typical use: pass a resolved secret (or a set of them) through `redact` /
 * `redactAll` before logging exceptions, stack traces, or request bodies.
 * Composes cleanly with error scrubbing, Sentry `beforeSend` hooks, and
 * any structured-log post-processing pipeline.
 */

const DEFAULT_PLACEHOLDER = "[REDACTED]";

/**
 * Minimum needle length. Secrets shorter than this are left alone to avoid
 * catastrophic false positives on common substrings ("api", "key", …).
 * Hardcoded in this pass; a future version may make it configurable.
 */
const MIN_NEEDLE_LENGTH = 4;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence of `needle` inside `haystack` with `placeholder`.
 *
 * Needles shorter than 4 characters are NOT redacted — too risky for
 * collision with common tokens ("api", "key", etc.). Returns `haystack`
 * unchanged when `needle` is empty or under the length threshold.
 *
 * Regex-special characters in `needle` are escaped, so passing a literal
 * secret containing `.`, `+`, `(`, etc. is safe. Match is case-sensitive
 * and global (all occurrences are replaced).
 */
export function redact(
  needle: string,
  haystack: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): string {
  if (needle.length < MIN_NEEDLE_LENGTH) return haystack;
  const pattern = new RegExp(escapeRegex(needle), "g");
  return haystack.replace(pattern, placeholder);
}

/**
 * Apply {@link redact} for each needle in sequence. Equivalent to
 * `[...needles].reduce((h, n) => redact(n, h, placeholder), haystack)`.
 *
 * Order matters only when needles overlap — longest first is generally
 * safer if you care about overlap, but the caller controls order.
 * Accepts any `Iterable<string>` (arrays, Sets, generators, …).
 */
export function redactAll(
  needles: Iterable<string>,
  haystack: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): string {
  let out = haystack;
  for (const needle of needles) {
    out = redact(needle, out, placeholder);
  }
  return out;
}
