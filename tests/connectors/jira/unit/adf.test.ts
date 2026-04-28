import { describe, it, expect } from "vitest";
import { adfToPlainText, type AdfNode } from "../../../../src/connectors/jira/lib/adf.js";

describe("adfToPlainText", () => {
  it("returns empty string for empty input", () => {
    expect(adfToPlainText(undefined)).toBe("");
    expect(adfToPlainText(null)).toBe("");
    expect(adfToPlainText({ type: "doc" })).toBe("");
  });

  it("converts a single paragraph with text", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello world" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("hello world");
  });

  it("separates paragraphs with blank lines", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "first" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "second" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("first\n\nsecond");
  });

  it("renders bullet lists with '- ' prefix", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "one" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "two" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("- one\n- two");
  });

  it("renders ordered lists with numeric prefix", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "alpha" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "beta" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("1. alpha\n2. beta");
  });

  it("inlines mention text", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "cc " },
            { type: "mention", attrs: { id: "123", text: "@alice" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("cc @alice");
  });

  it("handles hardBreak as newline inside paragraph", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line1" },
            { type: "hardBreak" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("line1\nline2");
  });

  it("walks unknown node types via children", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "weirdCustomType",
          content: [{ type: "text", text: "still visible" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("still visible");
  });

  it("renders headings as paragraph-spaced text", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "body text" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("Title\n\nbody text");
  });

  it("renders blockquote children with paragraph-style spacing", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted line" }],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("quoted line");
  });

  it("renders codeBlock children inline", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("const x = 1;");
  });

  it("renders rule as a horizontal divider", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "rule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    };
    expect(adfToPlainText(doc)).toBe("before\n\n---\nafter");
  });

  it("inlines inlineCard URL when attrs.url present", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "inlineCard", attrs: { url: "https://example.com/x" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("see https://example.com/x");
  });

  it("emits nothing for inlineCard missing url attr", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "skip:" },
            { type: "inlineCard", attrs: {} },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("skip:");
  });

  it("emits emoji.text when set, otherwise falls back to shortName", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "emoji", attrs: { shortName: ":smile:", text: "😀" } },
            { type: "text", text: " | " },
            { type: "emoji", attrs: { shortName: ":wave:" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("😀 | :wave:");
  });

  it("emits nothing for emoji with neither text nor shortName", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x" },
            { type: "emoji", attrs: {} },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("x");
  });

  it("emits nothing for mention with empty text", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "ping " },
            { type: "mention", attrs: { id: "u1" } },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("ping");
  });

  it("renders nested ordered list with numbered prefixes per depth", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "outer-1" }],
                },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "inner-1" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "outer-2" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = adfToPlainText(doc);
    expect(out).toContain("1. outer-1");
    expect(out).toContain("inner-1");
    expect(out).toContain("2. outer-2");
  });

  it("handles text node without text field as no-op", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text" }, // no text field
            { type: "text", text: "kept" },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("kept");
  });
});
