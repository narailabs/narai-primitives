/**
 * Structural validator for Atlassian Document Format (ADF) documents.
 *
 * Strict on the root: must be `{type: "doc", version: 1, content: array}`.
 * Permissive on leaf nodes: any string `type` is accepted, since Atlassian
 * extends ADF over time. Unknown leaf types surface as warnings rather than
 * errors so the validator does not have to chase the schema; callers decide
 * whether to allow them.
 *
 * No schema dependency. The 25-or-so node types whitelisted below cover the
 * common surface needed for issue/comment bodies, page content, and panels
 * — extending this list is additive and does not break callers.
 */

export interface ADFNode {
  type: string;
  content?: ADFNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
}

export interface ADFDocument {
  type: "doc";
  version: 1;
  content: ADFNode[];
}

export type ValidateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph", "heading", "blockquote", "codeBlock", "rule", "panel",
  "bulletList", "orderedList", "listItem",
  "text", "hardBreak", "mention", "emoji", "inlineCard", "link",
  "table", "tableRow", "tableCell", "tableHeader",
  "media", "mediaSingle", "mediaGroup",
  "expand", "nestedExpand",
  "decisionList", "decisionItem", "taskList", "taskItem",
]);

export function validateAdf(input: unknown): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["root: expected an object"], warnings };
  }

  const doc = input as Record<string, unknown>;
  if (doc["type"] !== "doc") {
    errors.push(`root.type: expected "doc", got ${JSON.stringify(doc["type"])}`);
  }
  if (doc["version"] !== 1) {
    errors.push(`root.version: expected 1, got ${JSON.stringify(doc["version"])}`);
  }
  if (!Array.isArray(doc["content"])) {
    errors.push(`root.content: expected an array, got ${typeof doc["content"]}`);
    return { ok: false, errors, warnings };
  }

  for (let i = 0; i < doc["content"].length; i++) {
    walkNode(doc["content"][i], `root.content[${i}]`, errors, warnings);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, warnings };
}

function walkNode(
  node: unknown,
  path: string,
  errors: string[],
  warnings: string[],
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    errors.push(`${path}: expected an object, got ${typeof node}`);
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n["type"] !== "string") {
    errors.push(`${path}.type: expected string, got ${typeof n["type"]}`);
    return;
  }
  if (!KNOWN_NODE_TYPES.has(n["type"] as string)) {
    warnings.push(
      `${path}.type: unknown ADF node type "${n["type"] as string}" (allowed)`,
    );
  }
  const content = n["content"];
  if (content !== undefined) {
    if (!Array.isArray(content)) {
      errors.push(`${path}.content: expected an array, got ${typeof content}`);
      return;
    }
    for (let i = 0; i < content.length; i++) {
      walkNode(content[i], `${path}.content[${i}]`, errors, warnings);
    }
  }
}

/**
 * Convenience wrapper: throw a single VALIDATION_ERROR-shaped Error if the
 * document is invalid. Use at the connector boundary where errors are mapped
 * to the toolkit's error envelope.
 */
export function assertValidAdf(input: unknown): asserts input is ADFDocument {
  const result = validateAdf(input);
  if (!result.ok) {
    throw new Error(`Invalid ADF document: ${result.errors.join("; ")}`);
  }
}
