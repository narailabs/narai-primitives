import { describe, expect, it } from "vitest";
import {
  validateAdf,
  assertValidAdf,
  type ADFDocument,
} from "../../../src/toolkit/atlassian/adf_validator.js";

const minimalDoc: ADFDocument = {
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

describe("validateAdf — happy paths", () => {
  it("accepts a minimal valid doc", () => {
    const r = validateAdf(minimalDoc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  it("accepts a doc with empty content", () => {
    const r = validateAdf({ type: "doc", version: 1, content: [] });
    expect(r.ok).toBe(true);
  });

  it("accepts nested content", () => {
    const r = validateAdf({
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("warns but accepts unknown leaf node types", () => {
    const r = validateAdf({
      type: "doc",
      version: 1,
      content: [{ type: "futureNode", attrs: { foo: "bar" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.warnings.some((w) => w.includes("futureNode"))).toBe(true);
  });
});

describe("validateAdf — root errors", () => {
  it("rejects a non-object", () => {
    const r = validateAdf("not a doc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/root/);
  });

  it("rejects null", () => {
    const r = validateAdf(null);
    expect(r.ok).toBe(false);
  });

  it("rejects an array at the root", () => {
    const r = validateAdf([]);
    expect(r.ok).toBe(false);
  });

  it("rejects wrong root type", () => {
    const r = validateAdf({ type: "paragraph", version: 1, content: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("root.type"))).toBe(true);
  });

  it("rejects wrong version", () => {
    const r = validateAdf({ type: "doc", version: 2, content: [] });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.includes("root.version"))).toBe(true);
  });

  it("rejects missing content", () => {
    const r = validateAdf({ type: "doc", version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.includes("root.content"))).toBe(true);
  });

  it("rejects non-array content", () => {
    const r = validateAdf({ type: "doc", version: 1, content: "oops" });
    expect(r.ok).toBe(false);
  });
});

describe("validateAdf — node errors", () => {
  it("rejects a node without a type", () => {
    const r = validateAdf({
      type: "doc",
      version: 1,
      content: [{ text: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.includes("content[0].type"))).toBe(true);
  });

  it("rejects a node where content is not an array", () => {
    const r = validateAdf({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: "oops" }],
    });
    expect(r.ok).toBe(false);
  });

  it("recurses and reports nested errors with full path", () => {
    const r = validateAdf({
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ noType: true }] }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(
        r.errors.some((e) =>
          e.includes("root.content[0].content[0].content[0].type"),
        ),
      ).toBe(true);
  });
});

describe("assertValidAdf", () => {
  it("does not throw on a valid doc", () => {
    expect(() => assertValidAdf(minimalDoc)).not.toThrow();
  });

  it("throws on an invalid doc with a useful message", () => {
    expect(() => assertValidAdf({ type: "paragraph" })).toThrow(/Invalid ADF/);
  });
});
