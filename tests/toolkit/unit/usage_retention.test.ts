import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetention } from "../../../src/toolkit/usage/retention.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "retention-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seed(name: string, content: string, daysOld: number) {
  const path = join(dir, name);
  writeFileSync(path, content);
  const when = (Date.now() - daysOld * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, when, when);
  return path;
}

describe("runRetention", () => {
  it("gzips old .jsonl and leaves fresh .jsonl alone", async () => {
    seed("fresh.jsonl", "x", 1);
    seed("old.jsonl", "y", 60);
    await runRetention(dir, { gzipDays: 30, deleteDays: 180 });
    const files = readdirSync(dir).sort();
    expect(files).toContain("fresh.jsonl");
    expect(files).toContain("old.jsonl.gz");
    expect(files).not.toContain("old.jsonl");
  });

  it("deletes very old .jsonl.gz", async () => {
    seed("ancient.jsonl.gz", "gz-bytes", 365);
    await runRetention(dir, { gzipDays: 30, deleteDays: 180 });
    expect(existsSync(join(dir, "ancient.jsonl.gz"))).toBe(false);
  });

  it("never touches .json summaries", async () => {
    seed("summary-x.json", "{}", 365);
    await runRetention(dir, { gzipDays: 30, deleteDays: 180 });
    expect(existsSync(join(dir, "summary-x.json"))).toBe(true);
  });

  it("does nothing when gzipDays=0 and deleteDays=0", async () => {
    seed("old.jsonl", "y", 60);
    await runRetention(dir, { gzipDays: 0, deleteDays: 0 });
    expect(existsSync(join(dir, "old.jsonl"))).toBe(true);
  });

  it("is idempotent: running twice produces the same result", async () => {
    seed("old.jsonl", "y", 60);
    await runRetention(dir, { gzipDays: 30, deleteDays: 180 });
    await runRetention(dir, { gzipDays: 30, deleteDays: 180 });
    const files = readdirSync(dir);
    expect(files).toContain("old.jsonl.gz");
    expect(files).not.toContain("old.jsonl");
  });
});
