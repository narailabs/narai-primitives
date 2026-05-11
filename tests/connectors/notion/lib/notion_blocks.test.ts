/**
 * Unit tests for notion_blocks.ts block builders.
 */
import { describe, expect, it } from "vitest";
import {
  bulletedListItem,
  code,
  heading1,
  heading2,
  heading3,
  numberedListItem,
  paragraph,
  quote,
  richText,
  toDo,
} from "../../../../src/connectors/notion/lib/notion_blocks.js";

describe("richText", () => {
  it("produces plain span with null link by default", () => {
    const rt = richText("hello");
    expect(rt).toEqual({
      type: "text",
      text: { content: "hello", link: null },
    });
  });

  it("produces linked span when url provided", () => {
    const rt = richText("click", "https://example.com");
    expect(rt.text.link).toEqual({ url: "https://example.com" });
  });
});

describe("paragraph", () => {
  it("accepts a plain string", () => {
    const b = paragraph("hi");
    expect(b).toEqual({
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "hi", link: null } }],
      },
    });
  });

  it("accepts a RichText array", () => {
    const b = paragraph([richText("a"), richText("b")]);
    const rt = (b["paragraph"] as Record<string, unknown>)["rich_text"] as unknown[];
    expect(rt).toHaveLength(2);
  });
});

describe("heading1 / heading2 / heading3", () => {
  it("heading1 uses heading_1 discriminator", () => {
    const b = heading1("Title");
    expect(b["type"]).toBe("heading_1");
    const payload = b["heading_1"] as Record<string, unknown>;
    const rt = payload["rich_text"] as Array<Record<string, unknown>>;
    expect(rt[0]?.["type"]).toBe("text");
    const text = rt[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("Title");
  });

  it("heading2 uses heading_2 discriminator", () => {
    const b = heading2("Sub");
    expect(b["type"]).toBe("heading_2");
  });

  it("heading3 uses heading_3 discriminator", () => {
    const b = heading3("Sub-sub");
    expect(b["type"]).toBe("heading_3");
  });
});

describe("code", () => {
  it("defaults language to 'plain text'", () => {
    const b = code("x = 1");
    const payload = b["code"] as Record<string, unknown>;
    expect(payload["language"]).toBe("plain text");
    const rt = payload["rich_text"] as Array<Record<string, unknown>>;
    const text = rt[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("x = 1");
  });

  it("uses provided language", () => {
    const b = code("print(1)", "python");
    const payload = b["code"] as Record<string, unknown>;
    expect(payload["language"]).toBe("python");
  });
});

describe("bulletedListItem", () => {
  it("uses bulleted_list_item type", () => {
    const b = bulletedListItem("item");
    expect(b["type"]).toBe("bulleted_list_item");
    const payload = b["bulleted_list_item"] as Record<string, unknown>;
    expect(payload["rich_text"]).toBeDefined();
  });
});

describe("numberedListItem", () => {
  it("uses numbered_list_item type", () => {
    const b = numberedListItem("step");
    expect(b["type"]).toBe("numbered_list_item");
  });
});

describe("quote", () => {
  it("uses quote type", () => {
    const b = quote("wise words");
    expect(b["type"]).toBe("quote");
    const payload = b["quote"] as Record<string, unknown>;
    const rt = payload["rich_text"] as Array<Record<string, unknown>>;
    const text = rt[0]?.["text"] as Record<string, unknown>;
    expect(text?.["content"]).toBe("wise words");
  });
});

describe("toDo", () => {
  it("defaults checked to false", () => {
    const b = toDo("task");
    const payload = b["to_do"] as Record<string, unknown>;
    expect(payload["checked"]).toBe(false);
  });

  it("accepts checked=true", () => {
    const b = toDo("done", true);
    const payload = b["to_do"] as Record<string, unknown>;
    expect(payload["checked"]).toBe(true);
  });

  it("uses to_do type discriminator", () => {
    expect(toDo("x")["type"]).toBe("to_do");
  });
});
