import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCurateSnapshot } from "../../src/toolkit/plugin/curate-cmd.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "curate-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "curate-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function seedJsonl(home: string, connector: string, entries: object[]) {
  // Post-3.0 tier layout: global/ subdir is where null-scope entries live.
  const dir = path.join(home, ".claude", "connectors", connector, "global");
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(dir, "hardships.jsonl"), lines + "\n");
}

describe("buildCurateSnapshot", () => {
  it("returns empty snapshot for a connector with no entries", () => {
    const snap = buildCurateSnapshot({
      connector: "aws",
      cwd: tmpCwd,
      home: tmpHome,
    });
    expect(snap.connector).toBe("aws");
    expect(snap.total_entries).toBe(0);
    expect(snap.new_entries).toBe(0);
    expect(snap.clusters).toEqual([]);
    expect(snap.marker.last_curated_ts).toBeNull();
    expect(snap.paths.read_from).toEqual([]);
  });

  it("includes clusters from raw JSONL when present", () => {
    seedJsonl(tmpHome, "aws", [
      { ts: "2026-04-01T00:00:00Z", connector: "aws", action: "x", kind: "rl", context: "c" },
      { ts: "2026-04-02T00:00:00Z", connector: "aws", action: "x", kind: "rl", context: "c" },
      { ts: "2026-04-03T00:00:00Z", connector: "aws", action: "y", kind: "auth", context: "other" },
    ]);
    const snap = buildCurateSnapshot({ connector: "aws", cwd: tmpCwd, home: tmpHome });
    expect(snap.total_entries).toBe(3);
    expect(snap.new_entries).toBe(3); // no marker yet
    expect(snap.clusters.length).toBeGreaterThanOrEqual(2);
  });

  it("respects curation marker — only new entries are returned", () => {
    seedJsonl(tmpHome, "aws", [
      { ts: "2026-04-01T00:00:00Z", connector: "aws", action: "x", kind: "rl", context: "c" },
      { ts: "2026-04-10T00:00:00Z", connector: "aws", action: "x", kind: "rl", context: "c" },
    ]);
    const mdDir = path.join(tmpHome, ".claude", "connectors", "aws", "global");
    fs.writeFileSync(
      path.join(mdDir, "hardships.md"),
      "---\nlast_curated_ts: 2026-04-05T00:00:00Z\nlast_curated_count: 1\n---\nbody",
    );

    const snap = buildCurateSnapshot({ connector: "aws", cwd: tmpCwd, home: tmpHome });
    expect(snap.total_entries).toBe(2);
    expect(snap.new_entries).toBe(1);
    expect(snap.marker.last_curated_ts).toBe("2026-04-05T00:00:00Z");
  });

  it("target_md points to user-global when cwd has no .claude/", () => {
    const snap = buildCurateSnapshot({ connector: "aws", cwd: tmpCwd, home: tmpHome });
    expect(snap.paths.target_md).toContain(tmpHome);
  });

  it("target_md points to project-local when cwd/.claude/ exists", () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const snap = buildCurateSnapshot({ connector: "aws", cwd: tmpCwd, home: tmpHome });
    expect(snap.paths.target_md).toContain(tmpCwd);
  });

  it("read_from lists both layers when both have JSONL", () => {
    seedJsonl(tmpHome, "aws", [
      { ts: "2026-04-01T00:00:00Z", connector: "aws", action: "x", kind: "y", context: "c" },
    ]);
    seedJsonl(tmpCwd, "aws", [
      { ts: "2026-04-02T00:00:00Z", connector: "aws", action: "x", kind: "y", context: "c" },
    ]);
    const snap = buildCurateSnapshot({ connector: "aws", cwd: tmpCwd, home: tmpHome });
    expect(snap.paths.read_from).toHaveLength(2);
  });
});
