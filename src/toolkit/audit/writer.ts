/**
 * JSONL audit writer. Instance-per-connector (no module-global state).
 *
 * Non-failing: any disk I/O error is swallowed. Audit MUST NEVER crash the
 * caller — a missing audit trail is better than a missing feature.
 *
 * Secret redaction: `scrubSecrets(str)` masks common `password='...'` /
 * `token='...'` / `api_key='...'` literals before writing. Called on
 * caller-supplied strings that might contain credentials.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEvent } from "./events.js";

export interface AuditWriterOptions {
  enabled: boolean;
  /** Absolute path to the JSONL file. Required when `enabled` is true. */
  path?: string;
  /** Fixed session id (tests). If omitted, a random 12-char hex is generated. */
  sessionId?: string;
}

/** Redact common credential-bearing `key='value'` literals in a string. */
const SENSITIVE_SQUOTE_RE =
  /\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|auth)\s*=\s*'[^']*'/gi;
const SENSITIVE_DQUOTE_RE =
  /\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|auth)\s*=\s*"[^"]*"/gi;

export function scrubSecrets(text: string): string {
  return text
    .replace(SENSITIVE_SQUOTE_RE, (_m, key: string) => `${key}='[REDACTED]'`)
    .replace(SENSITIVE_DQUOTE_RE, (_m, key: string) => `${key}="[REDACTED]"`);
}

function isoTimestamp(): string {
  const iso = new Date().toISOString();
  return iso.endsWith("Z") ? iso : iso + "Z";
}

export interface AuditWriter {
  readonly enabled: boolean;
  readonly sessionId: string;
  logEvent(
    event: Omit<AuditEvent, "timestamp" | "session_id"> & Record<string, unknown>,
  ): void;
}

class DiskAuditWriter implements AuditWriter {
  readonly enabled: boolean;
  readonly sessionId: string;
  private readonly _path: string | null;

  constructor(opts: AuditWriterOptions) {
    this.enabled = opts.enabled;
    this.sessionId = opts.sessionId ?? crypto.randomBytes(6).toString("hex");
    this._path = opts.enabled && opts.path ? opts.path : null;
  }

  logEvent(
    event: Omit<AuditEvent, "timestamp" | "session_id"> & Record<string, unknown>,
  ): void {
    if (!this.enabled || this._path === null) return;
    const record: Record<string, unknown> = {
      ...event,
      timestamp: isoTimestamp(),
      session_id: this.sessionId,
    };
    try {
      // Ensure parent dir exists — caller may pass a path whose dir doesn't
      // yet exist (common for first use).
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.appendFileSync(this._path, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // Best-effort; never raise into the caller.
    }
  }
}

/** A no-op writer used when audit is disabled. */
class NullAuditWriter implements AuditWriter {
  readonly enabled = false;
  readonly sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? crypto.randomBytes(6).toString("hex");
  }

  logEvent(): void {
    /* no-op */
  }
}

export function createAuditWriter(opts: AuditWriterOptions): AuditWriter {
  if (!opts.enabled) return new NullAuditWriter(opts.sessionId);
  if (opts.path === undefined || opts.path.length === 0) {
    throw new Error(
      "audit: 'path' is required when 'enabled' is true",
    );
  }
  return new DiskAuditWriter(opts);
}
