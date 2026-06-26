/**
 * grant-store.ts — pluggable backing store for time-limited read grants.
 *
 * The db connector runs as a fresh short-lived subprocess per invocation,
 * so an in-process `Map` of grants never survives between invocations. This
 * module abstracts grant storage behind a tiny interface so the `Policy`
 * engine can be backed either by:
 *
 *  - `MemoryGrantStore` (DEFAULT) — a process-local `Map`. Preserves the
 *    historical single-process behavior; grants vanish when the process
 *    exits. Used everywhere except `grant_required` wiring.
 *  - `FileGrantStore` — a JSON file on disk keyed by grant type, so a grant
 *    issued in one invocation is visible to the next. Expiry values are
 *    wall-clock epoch milliseconds (`Date.now()`-based) precisely because
 *    they must be comparable across processes; a process-relative clock
 *    (`performance.now()`) would be meaningless once serialized.
 *
 * Both stores expose the same `get`/`set` contract. They never throw out of
 * `get`/`set`: all IO errors (missing dir, corrupt JSON, permission denied)
 * are swallowed and treated as "no grant", which fails safe to denial under
 * `grant_required`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Storage contract for grant expiries. Keys are grant types (only `"read"`
 * is ever issued in practice); values are wall-clock epoch-ms expiry
 * timestamps. `get` returns `undefined` when no grant is recorded.
 */
export interface GrantStore {
  get(grantType: string): number | undefined;
  set(grantType: string, expiryEpochMs: number): void;
}

/**
 * In-process grant store backed by a `Map`. This is the DEFAULT and matches
 * the connector's historical behavior: grants live only as long as the
 * process and never persist across invocations.
 */
export class MemoryGrantStore implements GrantStore {
  private readonly _grants: Map<string, number> = new Map();

  get(grantType: string): number | undefined {
    return this._grants.get(grantType);
  }

  set(grantType: string, expiryEpochMs: number): void {
    this._grants.set(grantType, expiryEpochMs);
  }
}

/**
 * File-backed grant store. Persists a flat JSON object
 * `{ [grantType]: expiryEpochMs }` at `filePath`, enabling cross-process
 * grant visibility for the `grant_required` approval mode.
 *
 * Fail-safe semantics (never throw out of get/set):
 *  - A missing file reads as empty (no grants).
 *  - A corrupt/unparseable file reads as empty (no grants) — a damaged file
 *    must never be interpreted as an active grant.
 *  - Writes are ATOMIC: serialized to a temp sibling file then `rename`d into
 *    place, so a reader never observes a half-written file and a crash mid-
 *    write cannot corrupt the canonical file.
 *  - The parent directory is created on demand (`recursive`).
 */
export class FileGrantStore implements GrantStore {
  private readonly _filePath: string;

  constructor(filePath: string) {
    this._filePath = filePath;
  }

  get(grantType: string): number | undefined {
    const data = this._readAll();
    const value = data[grantType];
    return typeof value === "number" ? value : undefined;
  }

  set(grantType: string, expiryEpochMs: number): void {
    try {
      const dir = path.dirname(this._filePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = this._readAll();
      data[grantType] = expiryEpochMs;
      // Atomic write: serialize to a unique temp sibling, then rename.
      // rename(2) is atomic within a filesystem, so a concurrent reader
      // sees either the old file or the fully-written new one.
      const tmpPath = `${this._filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), { encoding: "utf-8" });
      try {
        fs.renameSync(tmpPath, this._filePath);
      } catch (err) {
        // Clean up the temp file if the rename failed so we don't leak it.
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort cleanup */
        }
        throw err;
      }
    } catch {
      // Fail safe: a store that cannot persist simply yields no grant on the
      // next read, which denies under grant_required. Never propagate.
    }
  }

  /**
   * Read and parse the backing file. Returns an empty object for any failure
   * (missing file, unreadable, malformed JSON, non-object root), so a corrupt
   * file can never be read as an active grant.
   */
  private _readAll(): Record<string, number> {
    let raw: string;
    try {
      raw = fs.readFileSync(this._filePath, { encoding: "utf-8" });
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, number>;
  }
}

/**
 * Stable on-disk location for a server's persisted grants, under the
 * connector's config dir (`~/.config/wiki_db/grants/`). Keyed by the server
 * alias so distinct DB targets never share a grant: approving reads on
 * `staging` must not unlock `prod`. The alias is sanitized to a filesystem-
 * safe token so arbitrary server names cannot escape the grants directory.
 */
export function grantStorePathFor(serverName: string): string {
  const safe = serverName.replace(/[^A-Za-z0-9_.-]/g, "_") || "_";
  return path.join(os.homedir(), ".config", "wiki_db", "grants", `${safe}.json`);
}

/**
 * Pure issuance decision for the "approve-once-then-allow-for-window"
 * semantics under `grant_required`.
 *
 * A read grant is issued ONLY when BOTH:
 *  - the approval mode is `grant_required` (the only mode gated on grants); and
 *  - the caller passed an explicit per-run approval signal
 *    (`approveGrant === true`).
 *
 * The explicit `approve_grant` flag IS the human approval: it represents a
 * person authorizing reads against this target for the configured window.
 * Absent the flag, this returns false, so nothing is ever auto-seeded and the
 * gate stands — a first read with no flag and no prior grant still denies.
 * Only `read` grants are ever issued (admin/privilege are never grantable).
 */
export function shouldIssueReadGrant(
  approvalMode: string,
  approveGrant: boolean,
): boolean {
  return approvalMode === "grant_required" && approveGrant === true;
}

/**
 * Whether to issue a session grant for `confirm_once` mode. As with reads,
 * the explicit approval flag IS the human approval; absent it, nothing is
 * seeded and the first read still escalates. The session grant lets a later
 * (fresh-process) read proceed without re-prompting until it expires.
 */
export function shouldIssueSessionGrant(
  approvalMode: string,
  approveGrant: boolean,
): boolean {
  return approvalMode === "confirm_once" && approveGrant === true;
}
