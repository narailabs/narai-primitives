/** Tests for the planner-prompt builder, JSON extractor, and plan validator. */

import { describe, expect, it } from "vitest";

import {
  buildSystemPrompt,
  buildUserPrompt,
  extractJsonArray,
  validatePlan,
} from "../../src/hub/plan.js";
import type { PreparedConnector } from "../../src/hub/types.js";

function fakePrepared(name: string, skill: string): PreparedConnector {
  return {
    name,
    binCommand: "node",
    binArgs: ["/dev/null"],
    skillContent: skill,
    slice: {
      name,
      enabled: true,
      skill: `${name}-agent-connector`,
      model: null,
      enforce_hooks: true,
      policy: {},
      options: {},
    },
  };
}

describe("buildSystemPrompt", () => {
  it("concatenates SKILL.md content under stable alphabetical ## Connector: <name> headers", () => {
    const out = buildSystemPrompt([
      fakePrepared("notion", "Notion skill body."),
      fakePrepared("aws", "AWS skill body."),
      fakePrepared("github", "GitHub skill body."),
    ]);
    const awsIdx = out.indexOf("## Connector: `aws`");
    const githubIdx = out.indexOf("## Connector: `github`");
    const notionIdx = out.indexOf("## Connector: `notion`");
    expect(awsIdx).toBeGreaterThan(-1);
    expect(githubIdx).toBeGreaterThan(awsIdx);
    expect(notionIdx).toBeGreaterThan(githubIdx);
    expect(out).toContain("AWS skill body.");
    expect(out).toContain("GitHub skill body.");
    expect(out).toContain("Notion skill body.");
  });

  it("includes the planner intro and trailing JSON instruction", () => {
    const out = buildSystemPrompt([fakePrepared("aws", "skill body")]);
    expect(out).toContain("planner for a set of read-only data connectors");
    expect(out).toContain('Return JSON only, no prose.');
  });
});

describe("buildUserPrompt", () => {
  it("returns the prompt as-is when no extraContext is given", () => {
    expect(buildUserPrompt("hello")).toBe("hello");
  });

  it("appends extraContext under a delimiter when provided", () => {
    const out = buildUserPrompt("hello", "world");
    expect(out).toContain("hello");
    expect(out).toContain("--- extra context ---");
    expect(out).toContain("world");
  });

  it("ignores empty/whitespace extraContext", () => {
    expect(buildUserPrompt("hello", "")).toBe("hello");
    expect(buildUserPrompt("hello", "   ")).toBe("hello");
  });
});

describe("extractJsonArray", () => {
  it("parses a clean JSON array", () => {
    expect(extractJsonArray('[{"a": 1}]')).toEqual([{ a: 1 }]);
  });

  it("extracts a JSON array wrapped in prose", () => {
    const raw = "Sure, here is your plan:\n\n```json\n[{\"connector\":\"aws\",\"action\":\"x\",\"params\":{}}]\n```\n";
    const out = extractJsonArray(raw);
    expect(out).toEqual([{ connector: "aws", action: "x", params: {} }]);
  });

  it("throws when no JSON array is present", () => {
    expect(() => extractJsonArray("nothing useful here")).toThrow(/no JSON array/);
  });
});

describe("validatePlan", () => {
  const enabled = new Set(["aws", "github"]);

  it("keeps valid entries", () => {
    const v = validatePlan(
      [
        { connector: "aws", action: "x", params: {} },
        { connector: "github", action: "y", params: { repo: "z" } },
      ],
      enabled,
    );
    expect(v.valid).toHaveLength(2);
    expect(v.invalid).toHaveLength(0);
  });

  it("drops entries with unknown connector and tags PLAN_ENTRY_INVALID", () => {
    const v = validatePlan(
      [{ connector: "jira", action: "x", params: {} }],
      enabled,
    );
    expect(v.valid).toHaveLength(0);
    expect(v.invalid).toHaveLength(1);
    expect(v.invalid[0]?.reason).toMatch(/unknown connector/);
  });

  it("drops entries with non-object params", () => {
    const v = validatePlan(
      [{ connector: "aws", action: "x", params: "not-an-object" }],
      enabled,
    );
    expect(v.valid).toHaveLength(0);
    expect(v.invalid[0]?.reason).toMatch(/params must be a plain object/);
  });

  it("drops entries with missing or empty action", () => {
    const v = validatePlan(
      [
        { connector: "aws", action: "", params: {} },
        { connector: "aws", params: {} },
      ],
      enabled,
    );
    expect(v.valid).toHaveLength(0);
    expect(v.invalid).toHaveLength(2);
  });

  it("drops non-object entries entirely", () => {
    const v = validatePlan(["hello", 42, null] as unknown[], enabled);
    expect(v.valid).toHaveLength(0);
    expect(v.invalid).toHaveLength(3);
  });

  it("returns empty result when input is not an array", () => {
    const v = validatePlan({ not: "an array" }, enabled);
    expect(v.valid).toHaveLength(0);
    expect(v.invalid).toHaveLength(1);
    expect(v.invalid[0]?.reason).toMatch(/not an array/);
  });
});
