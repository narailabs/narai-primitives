import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateNudge } from "../../src/toolkit/plugin/reminder.js";
import {
  DEFAULT_PREFS,
  readPrefs,
  setEnabled,
  setSkipDays,
  writePrefs,
} from "../../src/toolkit/plugin/prefs.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// prefs.ts
// ────────────────────────────────────────────────────────────────────────────

describe("CurationPrefs", () => {
  it("readPrefs returns defaults when file missing", () => {
    const p = readPrefs(tmpHome);
    expect(p).toEqual(DEFAULT_PREFS);
  });

  it("writePrefs + readPrefs round-trips", () => {
    writePrefs({ ...DEFAULT_PREFS, min_new_entries: 99 }, tmpHome);
    expect(readPrefs(tmpHome).min_new_entries).toBe(99);
  });

  it("setSkipDays writes a future ISO timestamp", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    setSkipDays(3, now, tmpHome);
    const prefs = readPrefs(tmpHome);
    expect(prefs.skip_until_ts).toBe("2026-04-23T00:00:00.000Z");
  });

  it("setSkipDays(0) clears skip", () => {
    writePrefs({ ...DEFAULT_PREFS, skip_until_ts: "2099-01-01T00:00:00.000Z" }, tmpHome);
    setSkipDays(0, new Date(), tmpHome);
    expect(readPrefs(tmpHome).skip_until_ts).toBeNull();
  });

  it("setEnabled toggles", () => {
    setEnabled(false, tmpHome);
    expect(readPrefs(tmpHome).enabled).toBe(false);
    setEnabled(true, tmpHome);
    expect(readPrefs(tmpHome).enabled).toBe(true);
  });

  it("malformed prefs file falls back to defaults", () => {
    const dir = path.join(tmpHome, ".claude", "connectors");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "curation-prefs.json"), "not json");
    expect(readPrefs(tmpHome)).toEqual(DEFAULT_PREFS);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reminder.ts — evaluateNudge
// ────────────────────────────────────────────────────────────────────────────

function seedJsonl(home: string, connector: string, count: number) {
  // Post-3.0 tier layout: global/ subdir for null-scope entries.
  const dir = path.join(home, ".claude", "connectors", connector, "global");
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      ts: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      connector,
      action: "x",
      kind: "y",
      context: `c-${i}`,
    }));
  }
  fs.writeFileSync(path.join(dir, "hardships.jsonl"), lines.join("\n") + "\n");
}

function seedMarker(home: string, connector: string, ts: string, count: number) {
  const dir = path.join(home, ".claude", "connectors", connector, "global");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "hardships.md"),
    `---\nlast_curated_ts: ${ts}\nlast_curated_count: ${count}\n---\n`,
  );
}

describe("evaluateNudge", () => {
  it("does not nudge when disabled", () => {
    writePrefs({ ...DEFAULT_PREFS, enabled: false }, tmpHome);
    seedJsonl(tmpHome, "aws", 100);
    const d = evaluateNudge({ connectors: ["aws"], home: tmpHome, cwd: tmpCwd });
    expect(d.nudge).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("does not nudge when skip_until_ts is in the future", () => {
    writePrefs(
      { ...DEFAULT_PREFS, skip_until_ts: "2099-01-01T00:00:00.000Z" },
      tmpHome,
    );
    seedJsonl(tmpHome, "aws", 100);
    const d = evaluateNudge({
      connectors: ["aws"],
      home: tmpHome,
      cwd: tmpCwd,
      now: new Date("2026-04-20T00:00:00Z"),
    });
    expect(d.nudge).toBe(false);
    expect(d.reason).toContain("skipped");
  });

  it("nudges when new-entry threshold met and never curated", () => {
    seedJsonl(tmpHome, "aws", 10);
    const d = evaluateNudge({
      connectors: ["aws"],
      home: tmpHome,
      cwd: tmpCwd,
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(d.nudge).toBe(true);
    expect(d.banner).toContain("aws");
  });

  it("does not nudge when below threshold and no time gap", () => {
    seedJsonl(tmpHome, "aws", 3); // < min_new_entries=5
    seedMarker(tmpHome, "aws", "2026-04-20T00:00:00Z", 0);
    const d = evaluateNudge({
      connectors: ["aws"],
      home: tmpHome,
      cwd: tmpCwd,
      now: new Date("2026-04-21T00:00:00Z"), // 1 day after marker, way < 7
    });
    expect(d.nudge).toBe(false);
  });

  it("nudges when days-since-curate threshold met even without new entries", () => {
    seedJsonl(tmpHome, "aws", 1); // 1 entry — low
    seedMarker(tmpHome, "aws", "2026-01-01T00:00:00Z", 0);
    const d = evaluateNudge({
      connectors: ["aws"],
      home: tmpHome,
      cwd: tmpCwd,
      now: new Date("2026-04-20T00:00:00Z"), // 109 days later
    });
    expect(d.nudge).toBe(true);
  });

  it("triggered_by lists each connector over threshold", () => {
    seedJsonl(tmpHome, "aws", 10);
    seedJsonl(tmpHome, "github", 6);
    seedJsonl(tmpHome, "notion", 2); // under threshold
    const d = evaluateNudge({
      connectors: ["aws", "github", "notion"],
      home: tmpHome,
      cwd: tmpCwd,
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(d.nudge).toBe(true);
    expect(d.triggered_by.map((t) => t.connector)).toEqual(["aws", "github"]);
  });
});
