/**
 * file.ts — Plaintext secrets file credential provider.
 *
 * Reads a JSON file shaped like `{ "<secret-name>": "<value>", ... }`.
 * Emits a single `console.warn` on first use to flag that secrets are
 * stored in cleartext. Callers that need at-rest encryption should switch
 * to the `cloud_secrets` or `keychain` provider.
 *
 * Future enhancement: support age/sops-encrypted files. For now the
 * warning makes the trade-off explicit.
 */
import * as fs from "node:fs";
import type { CredentialProvider, SecretMetadata } from "./index.js";

export interface FileProviderOptions {
  /** Absolute path to the JSON secrets file. */
  path: string;
  /**
   * Suppress the plaintext-warning (for tests). Production callers should
   * leave this at its default.
   */
  suppressWarning?: boolean;
  /**
   * Permit group- or world-accessible permission bits on the secrets file.
   * Default: false — the provider refuses to read a file with mode & 0o077 != 0.
   * Override only when running in an environment where the POSIX check cannot apply
   * (shared CI runners with permissive umask, etc.) and you accept the exposure risk.
   */
  allowLoosePermissions?: boolean;
  /**
   * Time-to-live for the parsed JSON cache, in milliseconds.
   * Default: Infinity (cache is held for the lifetime of the provider instance).
   * When finite, the file is re-stat'd and re-read after the TTL elapses.
   */
  cacheTtlMs?: number;
}

export class FileProvider implements CredentialProvider {
  private readonly _path: string;
  private readonly _suppressWarning: boolean;
  private readonly _allowLoosePermissions: boolean;
  private readonly _cacheTtlMs: number;
  private _warned = false;
  private _cache: Record<string, unknown> | null = null;
  private _cacheExpiresAt: number | null = null;

  constructor(opts: FileProviderOptions) {
    this._path = opts.path;
    this._suppressWarning = opts.suppressWarning ?? false;
    this._allowLoosePermissions = opts.allowLoosePermissions ?? false;
    this._cacheTtlMs = opts.cacheTtlMs ?? Infinity;
  }

  /**
   * Discard the cached JSON so the next `getSecret` re-reads from disk.
   * Useful when callers want to invalidate the cache on demand — e.g. after
   * rotating the file — independent of the configured TTL.
   */
  clearCache(): void {
    this._cache = null;
    this._cacheExpiresAt = null;
  }

  /**
   * Return the value for `name`. Two lookup strategies, in order:
   *   1. Literal top-level key — preserves the original flat
   *      `{ "<name>": "<value>" }` contract and lets users have
   *      key names that contain dots.
   *   2. Dot-path traversal — if the literal key doesn't resolve to a
   *      string, treat `name` as a path (e.g. `db-prod.username`) and
   *      walk the nested JSON. Returns null if any segment is missing
   *      or the leaf is not a string. Lets nested credential layouts
   *      reuse the same file/mode/warning machinery.
   */
  async getSecret(name: string): Promise<string | null> {
    return this.getSecretSync(name);
  }

  getSecretSync(name: string): string | null {
    this._warnOnce();
    const data = this._load();
    if (data === null) return null;
    const literal = data[name];
    if (typeof literal === "string") return literal;
    if (name.includes(".")) {
      const parts = name.split(".");
      let cur: unknown = data;
      for (const part of parts) {
        if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
          return null;
        }
        cur = (cur as Record<string, unknown>)[part];
      }
      if (typeof cur === "string") return cur;
    }
    return null;
  }

  async describeSecret(name: string): Promise<SecretMetadata> {
    const value = this.getSecretSync(name);
    let lastModified: Date | undefined;
    try {
      lastModified = fs.statSync(this._path).mtime;
    } catch {
      // file absent or unreadable — skip
    }
    const out: SecretMetadata = { exists: value !== null, provider: "file" };
    if (lastModified !== undefined) out.lastModified = lastModified;
    return out;
  }

  private _warnOnce(): void {
    if (this._warned || this._suppressWarning) return;
    this._warned = true;
    console.warn(
      `[credential_providers/file] reading secrets from plaintext file ${this._path}; ` +
        "consider using the keychain or cloud_secrets provider instead.",
    );
  }

  /**
   * Refuse to read the file if its mode is group- or world-accessible
   * on POSIX systems (matches the OpenSSH posture for private keys).
   * Skipped on Windows where stat().mode does not carry Unix permission
   * bits in a portable way.
   */
  private _checkFileMode(): void {
    if (process.platform === "win32") return;
    if (this._allowLoosePermissions) return;
    const st = fs.statSync(this._path);
    const insecureBits = st.mode & 0o077;
    if (insecureBits !== 0) {
      const octal = (st.mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(
        `[credential_providers/file] refusing to read ${this._path}: ` +
          `file mode ${octal} is group- or world-accessible. ` +
          `Run 'chmod 600 ${this._path}' to restrict to the owner.`,
      );
    }
  }

  /**
   * Parse the credentials JSON. Stores the raw nested structure so
   * dot-path traversal can find values inside subobjects (e.g. a
   * `db-<env>: {username, password}` layout); literal-key lookups still
   * filter to strings in `getSecret`.
   *
   * Cache lifecycle: by default held forever (fast path). When `cacheTtlMs`
   * is finite, the mode check and file read re-run after the TTL elapses —
   * that way rotated files with new bad permissions still get caught.
   */
  private _load(): Record<string, unknown> | null {
    if (this._cache !== null) {
      if (this._cacheTtlMs === Infinity) return this._cache;
      if (
        this._cacheExpiresAt !== null &&
        Date.now() < this._cacheExpiresAt
      ) {
        return this._cache;
      }
    }
    if (!fs.existsSync(this._path)) return null;
    this._checkFileMode();
    const raw = fs.readFileSync(this._path, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._cache = null;
      this._cacheExpiresAt = null;
      throw err;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      this._cache = null;
      this._cacheExpiresAt = null;
      throw new Error(
        `file provider: ${this._path} did not contain a JSON object`,
      );
    }
    this._cache = parsed as Record<string, unknown>;
    if (this._cacheTtlMs !== Infinity) {
      this._cacheExpiresAt = Date.now() + this._cacheTtlMs;
    }
    return this._cache;
  }
}
