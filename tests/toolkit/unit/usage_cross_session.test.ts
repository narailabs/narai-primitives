import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateCrossSession, renderCrossSessionMarkdown } from "../../../src/toolkit/usage/aggregate-cross-session.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "xs-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeSummary(connector: string, sessionId: string, payload: Record<string, unknown>) {
  const dir = join(root, connector, "usage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `summary-${sessionId}.json`), JSON.stringify(payload));
}

function seed() {
  writeSummary("github", "S1", {
    session_id: "S1", connector: "github",
    start: "2026-04-20T10:00:00Z", end: "2026-04-20T10:15:00Z",
    total_calls: 10, total_response_bytes: 1000, total_estimated_tokens: 250,
    error_rate: 0.1, by_action: {}, top_responses: [],
  });
  writeSummary("github", "S2", {
    session_id: "S2", connector: "github",
    start: "2026-04-22T09:00:00Z", end: "2026-04-22T09:30:00Z",
    total_calls: 20, total_response_bytes: 2000, total_estimated_tokens: 500,
    error_rate: 0, by_action: {}, top_responses: [],
  });
  writeSummary("notion", "S3", {
    session_id: "S3", connector: "notion",
    start: "2026-04-22T11:00:00Z", end: "2026-04-22T11:10:00Z",
    total_calls: 5, total_response_bytes: 500, total_estimated_tokens: 125,
    error_rate: 0, by_action: {}, top_responses: [],
  });
}

describe("aggregateCrossSession", () => {
  it("aggregates across all connectors by default", async () => {
    seed();
    const r = await aggregateCrossSession({ dir: root, since: "all" });
    expect(r.scope.connector).toBe("all");
    expect(r.scope.sessions_scanned).toBe(3);
    expect(r.totals.calls).toBe(35);
    expect(r.totals.response_bytes).toBe(3500);
    expect(r.by_connector.github.sessions).toBe(2);
    expect(r.by_connector.github.calls).toBe(30);
    expect(r.by_connector.notion.sessions).toBe(1);
  });

  it("filters by connector", async () => {
    seed();
    const r = await aggregateCrossSession({ dir: root, since: "all", connector: "github" });
    expect(r.scope.connector).toBe("github");
    expect(r.scope.sessions_scanned).toBe(2);
    expect(r.totals.calls).toBe(30);
    expect(Object.keys(r.by_connector)).toEqual(["github"]);
  });

  it("filters by since", async () => {
    seed();
    const r = await aggregateCrossSession({ dir: root, since: "1d", now: new Date("2026-04-22T12:00:00Z") });
    // S1 is 2026-04-20 (2 days old) — excluded. S2 and S3 are 2026-04-22 — included.
    expect(r.scope.sessions_scanned).toBe(2);
    expect(r.totals.calls).toBe(25);
  });

  it("buckets by_day correctly", async () => {
    seed();
    const r = await aggregateCrossSession({ dir: root, since: "all" });
    const days = r.by_day.map((d) => d.day).sort();
    expect(days).toEqual(["2026-04-20", "2026-04-22"]);
    const d22 = r.by_day.find((d) => d.day === "2026-04-22")!;
    expect(d22.calls).toBe(25);
  });

  it("renders markdown with expected headers", async () => {
    seed();
    const r = await aggregateCrossSession({ dir: root, since: "all" });
    const md = renderCrossSessionMarkdown(r);
    expect(md).toContain("# Usage report");
    expect(md).toContain("## Totals");
    expect(md).toContain("## By connector");
    expect(md).toContain("| github");
  });
});
