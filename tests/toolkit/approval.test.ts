import { describe, expect, it, vi } from "vitest";
import { ApprovalEngine } from "../../src/toolkit/policy/approval.js";

describe("ApprovalEngine", () => {
  it("starts with no session approval", () => {
    const e = new ApprovalEngine();
    expect(e.sessionApproved).toBe(false);
  });

  it("approveSession flips the flag", () => {
    const e = new ApprovalEngine();
    e.approveSession();
    expect(e.sessionApproved).toBe(true);
  });

  it("hasActiveGrant is false for unknown grants", () => {
    const e = new ApprovalEngine();
    expect(e.hasActiveGrant("read")).toBe(false);
  });

  it("addGrant + hasActiveGrant returns true within TTL", () => {
    const e = new ApprovalEngine();
    e.addGrant("read", 60); // 60 seconds
    expect(e.hasActiveGrant("read")).toBe(true);
  });

  it("expired grant returns false", async () => {
    const e = new ApprovalEngine();
    e.addGrant("read", 0); // immediately expired
    // A tiny delay so performance.now() advances past expiry.
    await new Promise((r) => setTimeout(r, 10));
    expect(e.hasActiveGrant("read")).toBe(false);
  });

  it("onGrantExpired callback fires once per grant type", async () => {
    const cb = vi.fn();
    const e = new ApprovalEngine({ onGrantExpired: cb });
    e.addGrant("read", 0);
    await new Promise((r) => setTimeout(r, 10));
    e.hasActiveGrant("read");
    e.hasActiveGrant("read");
    e.hasActiveGrant("read");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("read");
  });

  it("revokeGrant clears the grant", () => {
    const e = new ApprovalEngine();
    e.addGrant("read", 60);
    expect(e.hasActiveGrant("read")).toBe(true);
    e.revokeGrant("read");
    expect(e.hasActiveGrant("read")).toBe(false);
  });

  it("revoking clears expiry-logged dedup so re-added grants can fire callback again", async () => {
    const cb = vi.fn();
    const e = new ApprovalEngine({ onGrantExpired: cb });
    e.addGrant("read", 0);
    await new Promise((r) => setTimeout(r, 10));
    e.hasActiveGrant("read"); // fires cb once
    e.revokeGrant("read");
    e.addGrant("read", 0);
    await new Promise((r) => setTimeout(r, 10));
    e.hasActiveGrant("read"); // fires cb again
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
