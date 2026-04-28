import { describe, expect, it } from "vitest";
import { aggregateRecords, renderSummaryMarkdown } from "../../../src/toolkit/usage/aggregate.js";
import type { UsageRecord } from "../../../src/toolkit/usage/types.js";

function r(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    ts: "2026-04-23T12:00:00.000Z",
    session_id: "sid",
    connector: "github",
    action: "repo_info",
    status: "success",
    response_bytes: 100,
    estimated_tokens: 25,
    execution_time_ms: 100,
    ...overrides,
  };
}

describe("aggregateRecords", () => {
  it("returns an empty-shape summary for no records", () => {
    const s = aggregateRecords("sid", "github", []);
    expect(s.total_calls).toBe(0);
    expect(s.by_action).toEqual({});
    expect(s.top_responses).toEqual([]);
    expect(s.error_rate).toBe(0);
  });

  it("aggregates a mixed session correctly", () => {
    const records: UsageRecord[] = [
      r({ ts: "2026-04-23T12:00:00.000Z", action: "repo_info", response_bytes: 100, estimated_tokens: 25, execution_time_ms: 100, status: "success" }),
      r({ ts: "2026-04-23T12:01:00.000Z", action: "repo_info", response_bytes: 200, estimated_tokens: 50, execution_time_ms: 200, status: "success" }),
      r({ ts: "2026-04-23T12:02:00.000Z", action: "get_file", response_bytes: 700, estimated_tokens: 175, execution_time_ms: 50, status: "error" }),
    ];
    const s = aggregateRecords("sid", "github", records);
    expect(s.total_calls).toBe(3);
    expect(s.total_response_bytes).toBe(1000);
    expect(s.total_estimated_tokens).toBe(250);
    expect(s.error_rate).toBeCloseTo(1 / 3, 3);
    expect(s.start).toBe("2026-04-23T12:00:00.000Z");
    expect(s.end).toBe("2026-04-23T12:02:00.000Z");
    expect(s.by_action["repo_info"]).toEqual({
      calls: 2,
      response_bytes: 300,
      estimated_tokens: 75,
      avg_ms: 150,
    });
    expect(s.by_action["get_file"].calls).toBe(1);
    expect(s.top_responses[0]).toEqual({ action: "get_file", response_bytes: 700 });
    expect(s.top_responses.length).toBeLessThanOrEqual(3);
  });

  it("omits avg_ms as 0 when execution_time_ms is missing", () => {
    const s = aggregateRecords("sid", "github", [r({ execution_time_ms: undefined })]);
    expect(s.by_action["repo_info"].avg_ms).toBe(0);
  });
});

describe("renderSummaryMarkdown", () => {
  it("renders a table that includes totals and the by_action rows", () => {
    const records: UsageRecord[] = [
      r({ action: "repo_info", response_bytes: 100, estimated_tokens: 25 }),
      r({ action: "get_file", response_bytes: 200, estimated_tokens: 50 }),
    ];
    const summary = aggregateRecords("sid", "github", records);
    const md = renderSummaryMarkdown(summary);
    expect(md).toContain("# github usage — session sid");
    expect(md).toContain("| repo_info");
    expect(md).toContain("| get_file");
    expect(md).toContain("Calls: 2");
  });
});
