/**
 * adf.ts — convert Atlassian Document Format (ADF) trees to plain text.
 *
 * ADF is a JSON document shape used for Jira comments, descriptions, and
 * some custom field values. Each node has a `type` and optional `content`
 * (child nodes), plus type-specific fields (`text` for text nodes, `attrs`
 * for anchors, etc.).
 *
 * This converter is a best-effort walker that preserves paragraph / list
 * boundaries by emitting newlines, prefixes list items with `- ` /
 * `{n}. `, and drops marks. Full fidelity (bold/italic/color, mentions,
 * embedded smart-links) is deferred — plain text is enough for grep /
 * embedding indexes, which is what comments-to-text is for.
 */

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string }>;
}

export function adfToPlainText(doc: AdfNode | undefined | null): string {
  if (!doc) return "";
  const out: string[] = [];
  walk(doc, out, { listDepth: 0, orderedIndex: [] });
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

interface WalkState {
  listDepth: number;
  orderedIndex: number[];
}

function walk(node: AdfNode, out: string[], state: WalkState): void {
  const type = node.type ?? "";
  switch (type) {
    case "text":
      if (node.text) out.push(node.text);
      return;
    case "hardBreak":
      out.push("\n");
      return;
    case "paragraph":
      walkChildren(node, out, state);
      out.push("\n\n");
      return;
    case "heading":
      walkChildren(node, out, state);
      out.push("\n\n");
      return;
    case "blockquote":
      walkChildren(node, out, state);
      out.push("\n\n");
      return;
    case "bulletList":
    case "orderedList": {
      const next: WalkState = {
        listDepth: state.listDepth + 1,
        orderedIndex: [...state.orderedIndex],
      };
      if (type === "orderedList") next.orderedIndex.push(0);
      for (const child of node.content ?? []) walk(child, out, next);
      out.push("\n");
      return;
    }
    case "listItem": {
      const indent = "  ".repeat(Math.max(0, state.listDepth - 1));
      let prefix = "- ";
      if (state.orderedIndex.length > 0) {
        const idx = state.orderedIndex.length - 1;
        state.orderedIndex[idx] = (state.orderedIndex[idx] ?? 0) + 1;
        prefix = `${state.orderedIndex[idx]}. `;
      }
      const inner: string[] = [];
      walkChildren(node, inner, state);
      const body = inner.join("").replace(/\n+$/, "");
      out.push(indent + prefix + body + "\n");
      return;
    }
    case "codeBlock":
      walkChildren(node, out, state);
      out.push("\n\n");
      return;
    case "rule":
      out.push("\n---\n");
      return;
    case "mention": {
      const text = (node.attrs?.["text"] as string) ?? "";
      if (text) out.push(text);
      return;
    }
    case "inlineCard": {
      const url = (node.attrs?.["url"] as string) ?? "";
      if (url) out.push(url);
      return;
    }
    case "emoji": {
      const shortName = (node.attrs?.["shortName"] as string) ?? "";
      const text = (node.attrs?.["text"] as string) ?? shortName;
      if (text) out.push(text);
      return;
    }
    default:
      walkChildren(node, out, state);
  }
}

function walkChildren(node: AdfNode, out: string[], state: WalkState): void {
  for (const child of node.content ?? []) walk(child, out, state);
}
