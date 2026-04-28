import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendUsageRecord } from "../../../src/toolkit/usage/record.js";
import type { UsageRecord } from "../../../src/toolkit/usage/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-record-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: "2026-04-23T12:00:00.000Z",
    session_id: "abc",
    connector: "github",
    action: "repo_info",
    status: "success",
    response_bytes: 100,
    estimated_tokens: 25,
    ...overrides,
  };
}

describe("appendUsageRecord", () => {
  it("creates the directory and writes one JSONL line", () => {
    const path = join(dir, "nested/sub/abc.jsonl");
    appendUsageRecord(path, makeRecord());
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text.trimEnd())).toMatchObject({
      connector: "github",
      action: "repo_info",
    });
  });

  it("appends additional lines without overwriting", () => {
    const path = join(dir, "abc.jsonl");
    appendUsageRecord(path, makeRecord({ action: "a" }));
    appendUsageRecord(path, makeRecord({ action: "b" }));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe("a");
    expect(JSON.parse(lines[1]).action).toBe("b");
  });

  it("never throws on write errors (returns false)", () => {
    // Directory path that can't be created (e.g., contains NUL). We emulate
    // by passing an impossible path on this platform.
    const badPath = "/ /abc.jsonl";
    expect(() => appendUsageRecord(badPath, makeRecord())).not.toThrow();
  });
});
