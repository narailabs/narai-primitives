/**
 * notion_blocks.ts — typed builders for Notion block objects.
 *
 * Produces BlockObjectRequest shapes per Notion API 2022-06-28.
 * The `object: "block"` field is a response-only annotation; on create
 * (append_blocks) only the `type` discriminator and the type-specific
 * payload are required.
 *
 * No external dependencies.
 */

export interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
}

export type Block = Record<string, unknown>;

/**
 * Build a single rich_text span. Pass a `link` URL to create a linked span.
 */
export function richText(content: string, link?: string): RichText {
  return {
    type: "text",
    text: {
      content,
      link: link ? { url: link } : null,
    },
  };
}

/** Normalise `string | RichText[]` → `RichText[]`. */
function toRichText(input: string | RichText[]): RichText[] {
  return typeof input === "string" ? [richText(input)] : input;
}

export function paragraph(text: string | RichText[]): Block {
  return {
    type: "paragraph",
    paragraph: { rich_text: toRichText(text) },
  };
}

export function heading1(text: string | RichText[]): Block {
  return {
    type: "heading_1",
    heading_1: { rich_text: toRichText(text) },
  };
}

export function heading2(text: string | RichText[]): Block {
  return {
    type: "heading_2",
    heading_2: { rich_text: toRichText(text) },
  };
}

export function heading3(text: string | RichText[]): Block {
  return {
    type: "heading_3",
    heading_3: { rich_text: toRichText(text) },
  };
}

export function bulletedListItem(text: string | RichText[]): Block {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: toRichText(text) },
  };
}

export function numberedListItem(text: string | RichText[]): Block {
  return {
    type: "numbered_list_item",
    numbered_list_item: { rich_text: toRichText(text) },
  };
}

export function code(text: string, language = "plain text"): Block {
  return {
    type: "code",
    code: {
      rich_text: [richText(text)],
      language,
    },
  };
}

export function quote(text: string | RichText[]): Block {
  return {
    type: "quote",
    quote: { rich_text: toRichText(text) },
  };
}

export function toDo(text: string | RichText[], checked = false): Block {
  return {
    type: "to_do",
    to_do: {
      rich_text: toRichText(text),
      checked,
    },
  };
}
