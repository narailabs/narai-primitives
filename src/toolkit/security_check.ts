/**
 * security_check — URL validation, path containment, and label sanitization.
 *
 * Re-exports the fetch-cap symbols from `fetch_helper` so the two
 * security-baseline knobs live under one import at call sites.
 * `fetch_helper` remains the canonical owner; update the numbers there.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export {
  FETCH_MAX_BYTES_DEFAULT,
  FETCH_TIMEOUT_MS_DEFAULT,
  FetchCapExceeded,
  fetchWithCaps,
  type FetchCapsOptions,
} from "./fetch_helper.js";

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);

/**
 * Check that a URL uses an allowed scheme (http or https only).
 */
export function validateUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  const match = url.match(/^([A-Za-z][A-Za-z0-9+.\-]*):/);
  if (!match || match[1] === undefined) {
    return false;
  }
  const scheme = match[1].toLowerCase();
  return ALLOWED_SCHEMES.has(scheme);
}

/**
 * Best-effort realpath that mirrors Python's pathlib.Path.resolve(strict=False).
 *
 * Resolves existing symlinks in the path even when the full path does not
 * exist: walks up from the target until finding an existing ancestor,
 * realpaths it, then re-appends the non-existent tail.
 *
 * TOCTOU note: this function calls `existsSync` / `lstatSync` and then
 * `realpathSync.native` as two distinct system calls. On POSIX there is
 * no atomic replacement (Node's fs API does not expose `openat` /
 * `O_NOFOLLOW`), so on a shared host a malicious local user could swap
 * a parent directory between the two calls and defeat path containment
 * checks built on top of this function. Callers must run this helper in
 * a directory hierarchy under their own control — a developer workstation
 * or a CI runner with a private filesystem. If multi-user isolation is
 * required, sandbox the toolchain (container, user namespace, etc.)
 * rather than relying on this function to police the filesystem.
 */
function bestEffortRealpath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (cur && cur !== path.dirname(cur)) {
    let entryExists = fs.existsSync(cur);
    if (!entryExists) {
      try {
        fs.lstatSync(cur);
        entryExists = true;
      } catch {
        /* path truly absent; continue walking up */
      }
    }
    if (entryExists) {
      const real = fs.realpathSync.native(cur);
      if (tail.length === 0) {
        return real;
      }
      return path.join(real, ...tail.reverse());
    }
    tail.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return abs;
}

/**
 * Verify that `p` resolves to a location inside `wikiRoot`.
 * Symlinks are resolved before the prefix comparison, to prevent traversal.
 */
export function checkPathContainment(p: string, wikiRoot: string): boolean {
  try {
    const resolvedPath = bestEffortRealpath(p);
    const resolvedRoot = bestEffortRealpath(wikiRoot);
    return (
      resolvedPath.startsWith(resolvedRoot + path.sep) ||
      resolvedPath === resolvedRoot
    );
  } catch {
    return false;
  }
}

/**
 * HTML-escape a string the same way Python's html.escape(s, quote=True) does.
 * Ampersand must be escaped first so subsequent replacements don't double-escape.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Regex matching Unicode general-category "Cc" (control chars): U+0000..U+001F, U+007F..U+009F.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Sanitize a label by stripping control characters, capping length, and HTML-escaping.
 */
export function sanitizeLabel(label: string, maxLength: number = 256): string {
  let cleaned = label.replace(CONTROL_CHARS_RE, "");
  cleaned = cleaned.slice(0, maxLength);
  cleaned = htmlEscape(cleaned);
  return cleaned;
}
