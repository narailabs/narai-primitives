import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashScopeKey } from "../../src/toolkit/hardship/scope.js";
import {
  clusterHardships,
  entriesSinceLastCuration,
  normalizeContext,
  readCurationMarker,
  writeCurationMarker,
} from "../../src/toolkit/hardship/curate.js";
import {
  countRawHardships,
  readCuratedHardships,
  readRawHardships,
} from "../../src/toolkit/hardship/read.js";
import {
  createHardshipRecorder,
  resolveHardshipPath,
  type HardshipEntry,
} from "../../src/toolkit/hardship/record.js";

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hs-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "hs-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// record.ts
// ────────────────────────────────────────────────────────────────────────────

describe("resolveHardshipPath", () => {
  it("returns user-global path when cwd has no .claude/", () => {
    const p = resolveHardshipPath({ connector: "aws", scope: null, cwd: tmpCwd, home: tmpHome });
    expect(p).toContain(tmpHome);
    expect(p).toContain("aws/global/hardships.jsonl");
  });

  it("returns project-global path when cwd/.claude/ exists and scope is null", () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const p = resolveHardshipPath({ connector: "aws", scope: null, cwd: tmpCwd, home: tmpHome });
    expect(p).toContain(tmpCwd);
    expect(p).toContain("aws/global/hardships.jsonl");
  });

  it("returns project-tenant path when cwd/.claude/ exists and scope is set", () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const p = resolveHardshipPath({ connector: "aws", scope: "us-east-1", cwd: tmpCwd, home: tmpHome });
    expect(p).toContain(tmpCwd);
    expect(p).toContain("aws/tenants/");
    expect(p).toContain("hardships.jsonl");
  });
});

describe("createHardshipRecorder", () => {
  it("writes JSONL entries to the resolved path", () => {
    const rec = createHardshipRecorder({
      connector: "aws",
      cwd: tmpCwd,
      home: tmpHome,
      sessionId: "s1",
    });
    rec({ action: "list_functions", kind: "rate_limit", context: "429" });
    rec({ action: "list_functions", kind: "rate_limit", context: "429" });

    // No .claude/ in cwd → user-global tier
    const logPath = path.join(
      tmpHome, ".claude", "connectors", "aws", "global", "hardships.jsonl",
    );
    const raw = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(raw).toHaveLength(2);
    const first = JSON.parse(raw[0]!) as HardshipEntry;
    expect(first.connector).toBe("aws");
    expect(first.action).toBe("list_functions");
    expect(first.kind).toBe("rate_limit");
    expect(first.session_id).toBe("s1");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.scope).toBeNull();
  });

  it("disabled recorder writes nothing", () => {
    const rec = createHardshipRecorder({
      connector: "aws",
      enabled: false,
      cwd: tmpCwd,
      home: tmpHome,
    });
    rec({ action: "x", kind: "y", context: "z" });
    const logPath = path.join(tmpHome, ".claude", "connectors", "aws", "global", "hardships.jsonl");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("prefers project-global when cwd/.claude/ exists and scope is null", () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"));
    const rec = createHardshipRecorder({
      connector: "aws",
      cwd: tmpCwd,
      home: tmpHome,
    });
    rec({ action: "x", kind: "y", context: "z" });
    const projectLog = path.join(
      tmpCwd, ".claude", "connectors", "aws", "global", "hardships.jsonl",
    );
    const userLog = path.join(
      tmpHome, ".claude", "connectors", "aws", "global", "hardships.jsonl",
    );
    expect(fs.existsSync(projectLog)).toBe(true);
    expect(fs.existsSync(userLog)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// read.ts
// ────────────────────────────────────────────────────────────────────────────

function seedJsonl(dir: string, entries: HardshipEntry[]) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(dir, "hardships.jsonl"), lines + "\n");
}

describe("readRawHardships", () => {
  it("concatenates both layers newest-first", () => {
    const userDir = path.join(tmpHome, ".claude", "connectors", "aws", "global");
    const projDir = path.join(tmpCwd, ".claude", "connectors", "aws", "global");
    seedJsonl(userDir, [
      { ts: "2026-04-01T00:00:00Z", connector: "aws", action: "x", kind: "y", context: "user-old", scope: null },
    ]);
    seedJsonl(projDir, [
      { ts: "2026-04-10T00:00:00Z", connector: "aws", action: "x", kind: "y", context: "proj-newer", scope: null },
    ]);
    const entries = readRawHardships("aws", { cwd: tmpCwd, home: tmpHome });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.context).toBe("proj-newer");
    expect(entries[1]!.context).toBe("user-old");
  });

  it("silently skips malformed JSONL lines", () => {
    const userDir = path.join(tmpHome, ".claude", "connectors", "aws", "global");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, "hardships.jsonl"),
      '{"ts":"2026-04-01T00:00:00Z","connector":"aws","action":"x","kind":"y","context":"ok","scope":null}\n' +
        "this is not json\n" +
        '{"incomplete": "entry"}\n',
    );
    const entries = readRawHardships("aws", { cwd: tmpCwd, home: tmpHome });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.context).toBe("ok");
  });

  it("countRawHardships matches readRawHardships.length", () => {
    const userDir = path.join(tmpHome, ".claude", "connectors", "aws", "global");
    seedJsonl(userDir, [
      { ts: "2026-04-01T00:00:00Z", connector: "aws", action: "a", kind: "b", context: "c", scope: null },
      { ts: "2026-04-02T00:00:00Z", connector: "aws", action: "a", kind: "b", context: "d", scope: null },
    ]);
    expect(countRawHardships("aws", { cwd: tmpCwd, home: tmpHome })).toBe(2);
  });
});

describe("readCuratedHardships", () => {
  it("merges project and user MD with a visible divider", () => {
    const userDir = path.join(tmpHome, ".claude", "connectors", "aws", "global");
    const projDir = path.join(tmpCwd, ".claude", "connectors", "aws", "global");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "hardships.md"), "user content");
    fs.writeFileSync(path.join(projDir, "hardships.md"), "project content");

    const merged = readCuratedHardships("aws", { cwd: tmpCwd, home: tmpHome });
    expect(merged).toContain("project content");
    expect(merged).toContain("user content");
    expect(merged.indexOf("project content")).toBeLessThan(
      merged.indexOf("user content"),
    );
    expect(merged).toContain("---");
  });

  it("returns empty string when neither layer has MD", () => {
    const merged = readCuratedHardships("aws", { cwd: tmpCwd, home: tmpHome });
    expect(merged).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// curate.ts
// ────────────────────────────────────────────────────────────────────────────

describe("normalizeContext", () => {
  it("collapses timestamps to <ts>", () => {
    expect(normalizeContext("at 2026-04-20T14:02:33.000Z")).toBe("at <ts>");
  });

  it("collapses UUIDs to <uuid>", () => {
    expect(normalizeContext("id aabbccdd-1122-3344-5566-778899aabbcc")).toBe(
      "id <uuid>",
    );
  });

  it("collapses long numbers to <num>", () => {
    expect(normalizeContext("after 1234567 ms")).toBe("after <num> ms");
  });

  it("lowercase + whitespace collapse", () => {
    expect(normalizeContext("  HELLO   WORLD  ")).toBe("hello world");
  });
});

describe("clusterHardships", () => {
  const base = { connector: "aws", action: "get_file", kind: "rate_limit" };
  const e = (ctx: string, ts: string, res?: string): HardshipEntry => ({
    ts,
    ...base,
    context: ctx,
    scope: null,
    ...(res !== undefined ? { resolution: res } : {}),
  });

  it("groups entries with the same (connector,action,kind,normalized context)", () => {
    const clusters = clusterHardships([
      e("hit rate limit at 2026-04-20T14:02:00Z", "2026-04-20T14:02:00Z"),
      e("hit rate limit at 2026-04-20T15:02:00Z", "2026-04-20T15:02:00Z"),
      e("different error", "2026-04-20T16:00:00Z"),
    ]);
    expect(clusters).toHaveLength(2);
    const big = clusters[0]!;
    expect(big.count).toBe(2);
    expect(big.action).toBe("get_file");
  });

  it("tracks first_ts, last_ts, sample_contexts, resolutions", () => {
    const clusters = clusterHardships([
      e("c", "2026-04-01T00:00:00Z", "retry"),
      e("c", "2026-04-10T00:00:00Z", "wait"),
    ]);
    const c = clusters[0]!;
    expect(c.first_ts).toBe("2026-04-01T00:00:00Z");
    expect(c.last_ts).toBe("2026-04-10T00:00:00Z");
    expect(c.sample_contexts).toContain("c");
    expect(c.sample_resolutions).toContain("retry");
    expect(c.sample_resolutions).toContain("wait");
  });

  it("sorts clusters by count desc then last_ts desc", () => {
    const clusters = clusterHardships([
      e("a", "2026-04-01T00:00:00Z"),
      e("b", "2026-04-02T00:00:00Z"),
      e("b", "2026-04-03T00:00:00Z"),
    ]);
    expect(clusters[0]!.sample_contexts[0]).toBe("b");
    expect(clusters[0]!.count).toBe(2);
  });
});

describe("curation marker", () => {
  it("reads frontmatter", () => {
    const md =
      "---\nlast_curated_ts: 2026-04-20T00:00:00Z\nlast_curated_count: 42\n---\nbody";
    const m = readCurationMarker(md);
    expect(m.last_curated_ts).toBe("2026-04-20T00:00:00Z");
    expect(m.last_curated_count).toBe(42);
  });

  it("default when no frontmatter", () => {
    const m = readCurationMarker("just body");
    expect(m.last_curated_ts).toBeNull();
    expect(m.last_curated_count).toBe(0);
  });

  it("writes frontmatter, preserves body", () => {
    const original = "---\nlast_curated_ts: x\nlast_curated_count: 0\n---\nbody content";
    const out = writeCurationMarker(original, {
      last_curated_ts: "2026-04-21T00:00:00Z",
      last_curated_count: 99,
    });
    expect(out).toContain("last_curated_count: 99");
    expect(out).toContain("body content");
    expect(out).not.toContain("last_curated_ts: x");
  });
});

describe("entriesSinceLastCuration", () => {
  const e = (ts: string): HardshipEntry => ({
    ts, connector: "aws", action: "a", kind: "k", context: "c", scope: null,
  });
  const entries = [e("2026-04-05T00:00:00Z"), e("2026-04-10T00:00:00Z"), e("2026-04-15T00:00:00Z")];

  it("returns all when no marker", () => {
    const out = entriesSinceLastCuration(entries, { last_curated_ts: null, last_curated_count: 0 });
    expect(out).toHaveLength(3);
  });

  it("filters entries newer than marker ts", () => {
    const out = entriesSinceLastCuration(entries, {
      last_curated_ts: "2026-04-10T00:00:00Z",
      last_curated_count: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe("2026-04-15T00:00:00Z");
  });
});

describe("HardshipEntry.scope + tiered write (3.0)", () => {
  it("writes tenant-scoped hardship to project×tenant tier when cwd/.claude exists", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hardship-scope-"));
    const cwd = path.join(tmp, "proj");
    await fsp.mkdir(path.join(cwd, ".claude"), { recursive: true });

    const rec = createHardshipRecorder({
      connector: "jira",
      cwd,
      home: tmp,
    });
    rec({
      action: "get_issue",
      kind: "not_found",
      context: "HTTP 404 archived",
      scope: "https://acme.atlassian.net",
    });

    const hash = hashScopeKey("https://acme.atlassian.net");
    const jsonl = path.join(
      cwd,
      ".claude/connectors/jira/tenants",
      hash,
      "hardships.jsonl",
    );
    const content = await fsp.readFile(jsonl, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.scope).toBe("https://acme.atlassian.net");
    expect(entry.kind).toBe("not_found");

    await fsp.rm(tmp, { recursive: true });
  });

  it("writes null-scope hardship to project-global tier", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "hardship-scope-"));
    const cwd = path.join(tmp, "proj");
    await fsp.mkdir(path.join(cwd, ".claude"), { recursive: true });

    const rec = createHardshipRecorder({
      connector: "jira",
      cwd,
      home: tmp,
    });
    rec({
      action: "jql_search",
      kind: "timeout",
      context: "30s",
      scope: null,
    });
    const jsonl = path.join(
      cwd,
      ".claude/connectors/jira/global/hardships.jsonl",
    );
    const content = await fsp.readFile(jsonl, "utf-8");
    expect(JSON.parse(content.trim()).scope).toBeNull();

    await fsp.rm(tmp, { recursive: true });
  });

  it("writer→reader pipeline is coherent across tiers", () => {
    fs.mkdirSync(path.join(tmpCwd, ".claude"), { recursive: true });
    const rec = createHardshipRecorder({
      connector: "jira",
      cwd: tmpCwd,
      home: tmpHome,
    });
    rec({
      action: "get_issue",
      kind: "not_found",
      context: "archived",
      scope: "https://acme.atlassian.net",
    });
    rec({
      action: "jql_search",
      kind: "timeout",
      context: "30s",
      scope: null,
    });

    // scope: null → only global tiers walked; tenant entry NOT returned.
    const global = readRawHardships("jira", { cwd: tmpCwd, home: tmpHome });
    expect(global).toHaveLength(1);
    expect(global[0]!.kind).toBe("timeout");
    expect(global[0]!.scope).toBeNull();

    // scope set → tenant + global tiers walked; both entries returned.
    const scoped = readRawHardships("jira", {
      cwd: tmpCwd,
      home: tmpHome,
      scope: "https://acme.atlassian.net",
    });
    expect(scoped).toHaveLength(2);
    const kinds = scoped.map((e) => e.kind).sort();
    expect(kinds).toEqual(["not_found", "timeout"]);
  });
});

describe("clusterHardships — scope discriminant", () => {
  it("splits clusters by scope", () => {
    const entries: HardshipEntry[] = [
      {
        ts: "t1",
        connector: "jira",
        action: "get",
        kind: "not_found",
        context: "HTTP 404",
        scope: "acme",
      },
      {
        ts: "t2",
        connector: "jira",
        action: "get",
        kind: "not_found",
        context: "HTTP 404",
        scope: "beta",
      },
      {
        ts: "t3",
        connector: "jira",
        action: "get",
        kind: "not_found",
        context: "HTTP 404",
        scope: "acme",
      },
    ];
    const clusters = clusterHardships(entries);
    // 2 clusters, not 1 — acme and beta are separate.
    expect(clusters).toHaveLength(2);
    const acme = clusters.find((c) => c.scope === "acme");
    expect(acme?.count).toBe(2);
  });

  it("null scope does not cluster with tenant scope of the same context", () => {
    const entries: HardshipEntry[] = [
      { ts: "t1", connector: "jira", action: "get", kind: "not_found", context: "HTTP 404", scope: null },
      { ts: "t2", connector: "jira", action: "get", kind: "not_found", context: "HTTP 404", scope: "acme" },
    ];
    const clusters = clusterHardships(entries);
    expect(clusters).toHaveLength(2);
  });
});
