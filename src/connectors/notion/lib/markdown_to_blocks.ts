/**
 * markdown_to_blocks.ts — minimal Markdown → Notion block converter.
 *
 * Covers the common subset:
 *   # / ## / ###       → heading_1 / heading_2 / heading_3
 *   - / * / +          → bulleted_list_item
 *   1. / 2. / …        → numbered_list_item
 *   ```lang…```        → code (with language)
 *   > text             → quote
 *   everything else    → paragraph
 *
 * Inline marks (bold/italic/inline-code) are preserved as plain text in v1
 * to keep the parser simple and dependency-free.
 */
import {
  type Block,
  bulletedListItem,
  code,
  heading1,
  heading2,
  heading3,
  numberedListItem,
  paragraph,
  quote,
} from "./notion_blocks.js";

/**
 * Convert a Markdown string into an array of Notion block objects suitable
 * for use as `children` in a create/append call.
 */
export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // ── Code fence ─────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).startsWith("```")) {
        codeLines.push(lines[i] as string);
        i++;
      }
      i++; // consume closing ```
      blocks.push(code(codeLines.join("\n"), lang));
      continue;
    }

    // ── Headings ────────────────────────────────────────────────────────────
    if (line.startsWith("### ")) {
      blocks.push(heading3(line.slice(4).trim()));
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(heading2(line.slice(3).trim()));
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(heading1(line.slice(2).trim()));
      i++;
      continue;
    }

    // ── Blockquote ─────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      blocks.push(quote(line.slice(2).trim()));
      i++;
      continue;
    }

    // ── Bullet list ────────────────────────────────────────────────────────
    if (/^[-*+] /.test(line)) {
      blocks.push(bulletedListItem(line.slice(2).trim()));
      i++;
      continue;
    }

    // ── Numbered list ──────────────────────────────────────────────────────
    if (/^\d+\. /.test(line)) {
      const text = line.replace(/^\d+\. /, "").trim();
      blocks.push(numberedListItem(text));
      i++;
      continue;
    }

    // ── Empty line → skip (blank separator between blocks) ─────────────────
    if (line.trim() === "") {
      i++;
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    // Accumulate consecutive non-special lines into one paragraph.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] as string;
      if (
        next.trim() === "" ||
        next.startsWith("```") ||
        next.startsWith("# ") ||
        next.startsWith("## ") ||
        next.startsWith("### ") ||
        next.startsWith("> ") ||
        /^[-*+] /.test(next) ||
        /^\d+\. /.test(next)
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    blocks.push(paragraph(paraLines.join("\n").trim()));
  }

  return blocks;
}
