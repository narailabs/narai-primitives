import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPatterns,
  matchPattern,
  type Pattern,
  type PatternsFile,
} from "../../src/toolkit/hardship/patterns.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/patterns",
);

describe("loadPatterns", () => {
  it("parses a valid patterns.yaml", () => {
    const file: PatternsFile = loadPatterns(
      path.join(fixtures, "jira-tenant.yaml"),
    );
    expect(file.version).toBe(1);
    expect(file.patterns).toHaveLength(2);
    expect(file.patterns[0]?.pattern_id).toBe("jira-archived-404");
  });

  it("returns { version:1, patterns:[] } for missing file", () => {
    const file = loadPatterns(path.join(fixtures, "does-not-exist.yaml"));
    expect(file.patterns).toEqual([]);
  });

  it("filters out malformed patterns without crashing", () => {
    const file = loadPatterns(path.join(fixtures, "github-global.yaml"));
    expect(file.patterns).toHaveLength(1);
  });
});

describe("matchPattern", () => {
  const jiraFile = loadPatterns(path.join(fixtures, "jira-tenant.yaml"));

  it("matches kind + action + regex", () => {
    const hit = matchPattern(jiraFile.patterns, {
      kind: "not_found",
      action: "get_issue",
      context: "Jira HTTP 404: project archived since 2025-Q4",
    });
    expect(hit?.pattern_id).toBe("jira-archived-404");
  });

  it("ignores patterns with status != active", () => {
    const hit = matchPattern(jiraFile.patterns, {
      kind: "schema",
      action: "get_comments",
      context: "ADF body is null for comment 12345",
    });
    expect(hit).toBeNull();
  });

  it("returns null when no matcher matches", () => {
    const hit = matchPattern(jiraFile.patterns, {
      kind: "timeout",
      action: "get_issue",
      context: "connection timed out after 30s",
    });
    expect(hit).toBeNull();
  });

  it("matches regardless of action if pattern.actions is empty/undefined", () => {
    const pat: Pattern[] = [
      {
        pattern_id: "generic",
        status: "active",
        confidence: 0.7,
        kind: "timeout",
        matcher: { context_regex: "timed out" },
        advice: "increase timeout",
      },
    ];
    const hit = matchPattern(pat, {
      kind: "timeout",
      action: "anything",
      context: "request timed out",
    });
    expect(hit?.pattern_id).toBe("generic");
  });
});

import * as os from "node:os";
import * as fsp from "node:fs/promises";
import { readFirstMatchingPattern } from "../../src/toolkit/hardship/read.js";

describe("readFirstMatchingPattern (tier walk)", () => {
  it("returns most-specific matching pattern across tiers", async () => {
    const tmp = await fsp.mkdtemp(
      path.join(os.tmpdir(), "toolkit-patterns-"),
    );
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "proj");
    await fsp.mkdir(
      path.join(cwd, ".claude/connectors/jira/global"),
      { recursive: true },
    );
    await fsp.mkdir(
      path.join(home, ".claude/connectors/jira/global"),
      { recursive: true },
    );

    // user-global: generic not_found pattern
    await fsp.writeFile(
      path.join(home, ".claude/connectors/jira/global/patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: generic-404
    status: active
    confidence: 0.5
    kind: not_found
    matcher: { context_regex: "404" }
    advice: generic 404 advice
`,
    );

    // project-global: more specific — wins because of tier order
    await fsp.writeFile(
      path.join(cwd, ".claude/connectors/jira/global/patterns.yaml"),
      `version: 1
patterns:
  - pattern_id: proj-404
    status: active
    confidence: 0.9
    kind: not_found
    matcher: { context_regex: "404" }
    advice: project-specific 404 advice
`,
    );

    const hit = readFirstMatchingPattern({
      connector: "jira",
      scope: null,
      cwd,
      home,
      facts: { kind: "not_found", action: "get_issue", context: "HTTP 404" },
    });

    expect(hit?.match.pattern_id).toBe("proj-404");
    expect(hit?.tier).toBe("project-global");

    await fsp.rm(tmp, { recursive: true });
  });

  it("returns null when no tier has a matching pattern", async () => {
    const tmp = await fsp.mkdtemp(
      path.join(os.tmpdir(), "toolkit-patterns-"),
    );
    const hit = readFirstMatchingPattern({
      connector: "jira",
      scope: null,
      cwd: tmp,
      home: tmp,
      facts: { kind: "not_found", action: "x", context: "y" },
    });
    expect(hit).toBeNull();
    await fsp.rm(tmp, { recursive: true });
  });
});
