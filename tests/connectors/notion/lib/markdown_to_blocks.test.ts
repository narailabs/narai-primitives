/**
 * Unit tests for markdown_to_blocks.ts.
 */
import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../../../../src/connectors/notion/lib/markdown_to_blocks.js";

describe("markdownToBlocks", () => {
  it("converts # heading to heading_1", () => {
    const blocks = markdownToBlocks("# Title");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.["type"]).toBe("heading_1");
    const payload = blocks[0]?.["heading_1"] as Record<string, unknown>;
    const rt = payload?.["rich_text"] as Array<Record<string, unknown>>;
    const text = rt?.[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("Title");
  });

  it("converts ## heading to heading_2", () => {
    const blocks = markdownToBlocks("## Sub");
    expect(blocks[0]?.["type"]).toBe("heading_2");
  });

  it("converts ### heading to heading_3", () => {
    const blocks = markdownToBlocks("### Sub-sub");
    expect(blocks[0]?.["type"]).toBe("heading_3");
  });

  it("converts bullet list items", () => {
    const blocks = markdownToBlocks("- one\n- two");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.["type"]).toBe("bulleted_list_item");
    expect(blocks[1]?.["type"]).toBe("bulleted_list_item");
    const payload0 = blocks[0]?.["bulleted_list_item"] as Record<string, unknown>;
    const rt0 = payload0?.["rich_text"] as Array<Record<string, unknown>>;
    const text0 = rt0?.[0]?.["text"] as Record<string, unknown>;
    expect(text0?.["content"]).toBe("one");
  });

  it("converts * and + bullet markers", () => {
    const blocks = markdownToBlocks("* a\n+ b");
    expect(blocks[0]?.["type"]).toBe("bulleted_list_item");
    expect(blocks[1]?.["type"]).toBe("bulleted_list_item");
  });

  it("converts numbered list items", () => {
    const blocks = markdownToBlocks("1. first\n2. second");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.["type"]).toBe("numbered_list_item");
    expect(blocks[1]?.["type"]).toBe("numbered_list_item");
    const payload = blocks[0]?.["numbered_list_item"] as Record<string, unknown>;
    const rt = payload?.["rich_text"] as Array<Record<string, unknown>>;
    const text = rt?.[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("first");
  });

  it("converts code fence with language", () => {
    const blocks = markdownToBlocks("```python\nprint(1)\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.["type"]).toBe("code");
    const payload = blocks[0]?.["code"] as Record<string, unknown>;
    expect(payload?.["language"]).toBe("python");
    const rt = payload?.["rich_text"] as Array<Record<string, unknown>>;
    const text = rt?.[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("print(1)");
  });

  it("converts code fence without language to plain text", () => {
    const blocks = markdownToBlocks("```\nhello\n```");
    const payload = blocks[0]?.["code"] as Record<string, unknown>;
    expect(payload?.["language"]).toBe("plain text");
  });

  it("converts blockquote lines", () => {
    const blocks = markdownToBlocks("> note");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.["type"]).toBe("quote");
    const payload = blocks[0]?.["quote"] as Record<string, unknown>;
    const rt = payload?.["rich_text"] as Array<Record<string, unknown>>;
    const text = rt?.[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("note");
  });

  it("converts regular text to paragraph", () => {
    const blocks = markdownToBlocks("Hello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.["type"]).toBe("paragraph");
  });

  it("skips blank lines as separators", () => {
    const blocks = markdownToBlocks("# A\n\n# B");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.["type"]).toBe("heading_1");
    expect(blocks[1]?.["type"]).toBe("heading_1");
  });

  it("handles mixed content in correct order", () => {
    const md = [
      "# Main Heading",
      "",
      "Some paragraph text.",
      "",
      "- item one",
      "- item two",
      "",
      "```js",
      "console.log('hi');",
      "```",
      "",
      "> a quote",
    ].join("\n");
    const blocks = markdownToBlocks(md);
    expect(blocks[0]?.["type"]).toBe("heading_1");
    expect(blocks[1]?.["type"]).toBe("paragraph");
    expect(blocks[2]?.["type"]).toBe("bulleted_list_item");
    expect(blocks[3]?.["type"]).toBe("bulleted_list_item");
    expect(blocks[4]?.["type"]).toBe("code");
    expect(blocks[5]?.["type"]).toBe("quote");
  });

  it("returns empty array for empty input", () => {
    expect(markdownToBlocks("")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(markdownToBlocks("   \n\n  ")).toHaveLength(0);
  });
});
