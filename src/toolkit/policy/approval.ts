/**
 * Grant + session approval state machine.
 *
 * Lives in-process only: both session approval and grants are stored on the
 * `ApprovalEngine` instance. A fresh CLI invocation always starts with no
 * approvals, so `approval_mode: confirm_once` / `grant_required` are
 * single-invocation gates — suitable for the agent-connector CLI's
 * short-lived process model.
 *
 * Uses `performance.now()` (monotonic, process-relative) for grant expiry —
 * not wall-clock, so DST jumps and clock skew don't affect active grants.
 */
import { performance } from "node:perf_hooks";
import type { ApprovalState } from "./gate.js";

export class ApprovalEngine implements ApprovalState {
  private _sessionApproved = false;
  private readonly _grants = new Map<string, number>(); // grantType → expiry (performance.now ms)
  private readonly _expiryLogged = new Set<string>();   // dedup log spam
  private readonly _onExpired: ((grantType: string) => void) | undefined;

  constructor(opts: { onGrantExpired?: (grantType: string) => void } = {}) {
    this._onExpired = opts.onGrantExpired;
  }

  get sessionApproved(): boolean {
    return this._sessionApproved;
  }

  /** Mark the session as approved (used by `confirm_once` mode). */
  approveSession(): void {
    this._sessionApproved = true;
  }

  /** Issue a time-limited grant, expiring `ttlSeconds` from now. */
  addGrant(grantType: string, ttlSeconds: number = 300): void {
    this._grants.set(grantType, performance.now() + ttlSeconds * 1000);
  }

  /** Revoke a grant if it exists. */
  revokeGrant(grantType: string): void {
    this._grants.delete(grantType);
    this._expiryLogged.delete(grantType);
  }

  /**
   * Is `grantType` currently active? Returns false for unknown or expired
   * grants. On first observation that a grant has expired, invokes the
   * `onGrantExpired` callback once (subsequent checks are silent).
   */
  hasActiveGrant(grantType: string): boolean {
    const expiry = this._grants.get(grantType);
    if (expiry === undefined) return false;
    if (performance.now() < expiry) return true;
    if (!this._expiryLogged.has(grantType)) {
      this._expiryLogged.add(grantType);
      this._onExpired?.(grantType);
    }
    return false;
  }
}
