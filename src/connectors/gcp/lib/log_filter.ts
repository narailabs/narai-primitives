/**
 * log_filter.ts — structured Cloud Logging filter builder.
 *
 * Compiles a JSON clause tree into a Cloud Logging filter string. Safety is
 * by construction, not by blocklist:
 *   - `op` is allowlisted (`=`, `!=`, `>=`, `<=`, `:` / `contains`);
 *   - `field` must match a dotted-identifier pattern (covers `severity`,
 *     `textPayload`, `resource.type`, `resource.labels.*`, `jsonPayload.*`,
 *     `trace`, `logName`, …);
 *   - `value` is treated strictly as data — it is always emitted as a
 *     double-quoted string literal with embedded quotes, backslashes, and
 *     control characters escaped per the Cloud Logging filter grammar.
 *
 * A value like `" OR severity>="DEBUG` therefore compiles to the harmless
 * literal `"\" OR severity>=\"DEBUG"` instead of becoming filter syntax.
 */
import { z } from "zod";

/** Dotted identifier path: `severity`, `resource.labels.pod_name`, `jsonPayload.level`, … */
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const OPS = ["=", "!=", ">=", "<=", ":", "contains"] as const;
export type LogFilterOp = (typeof OPS)[number];

export interface LogFilterClause {
  field: string;
  op: LogFilterOp;
  value: string | number | boolean;
}

export interface LogFilterGroup {
  and?: ReadonlyArray<LogFilterClause | LogFilterGroup> | undefined;
  or?: ReadonlyArray<LogFilterClause | LogFilterGroup> | undefined;
}

export type StructuredLogFilter = LogFilterClause | LogFilterGroup;

const clauseSchema = z
  .object({
    field: z
      .string()
      .regex(
        FIELD_PATTERN,
        "field must be a dotted identifier path (letters, digits, '_', '.')",
      ),
    op: z.enum(OPS),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

/** Inner group: `and`/`or` over plain clauses only (one nesting level). */
const innerGroupSchema = z
  .object({
    and: z.array(clauseSchema).min(1).optional(),
    or: z.array(clauseSchema).min(1).optional(),
  })
  .strict()
  .refine((g) => (g.and !== undefined) !== (g.or !== undefined), {
    message: "group must have exactly one of 'and' / 'or'",
  });

const groupItemSchema = z.union([clauseSchema, innerGroupSchema]);

const topGroupSchema = z
  .object({
    and: z.array(groupItemSchema).min(1).optional(),
    or: z.array(groupItemSchema).min(1).optional(),
  })
  .strict()
  .refine((g) => (g.and !== undefined) !== (g.or !== undefined), {
    message: "group must have exactly one of 'and' / 'or'",
  });

/**
 * Zod schema for the `structured_filter` action param: a single clause, or
 * an `and`/`or` group whose items are clauses or one-level-deep sub-groups.
 */
export const structuredLogFilterSchema = z.union([
  clauseSchema,
  topGroupSchema,
]);

/**
 * Escape a value for embedding in a double-quoted Cloud Logging filter
 * string literal. Backslash and double-quote get backslash-escaped; control
 * characters are emitted as `\n` / `\r` / `\t` escape sequences so the
 * compiled filter is always a single line.
 */
function quoteValue(value: string | number | boolean): string {
  const s = String(value);
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function isClause(node: StructuredLogFilter): node is LogFilterClause {
  return "field" in node;
}

function compileClause(clause: LogFilterClause): string {
  if (!FIELD_PATTERN.test(clause.field)) {
    throw new Error(`Invalid filter field: ${clause.field}`);
  }
  if (!OPS.includes(clause.op)) {
    throw new Error(`Invalid filter op: ${String(clause.op)}`);
  }
  const op = clause.op === "contains" ? ":" : clause.op;
  return `${clause.field}${op}${quoteValue(clause.value)}`;
}

function compileNode(node: StructuredLogFilter, depth: number): string {
  if (isClause(node)) return compileClause(node);
  const items = node.and ?? node.or;
  const joiner = node.and !== undefined ? " AND " : " OR ";
  if (node.and !== undefined && node.or !== undefined) {
    throw new Error("Filter group must have exactly one of 'and' / 'or'");
  }
  if (items === undefined || items.length === 0) {
    throw new Error("Filter group must contain at least one clause");
  }
  if (depth >= 2) {
    throw new Error("Filter groups may only nest one level deep");
  }
  const parts = items.map((item) => {
    const compiled = compileNode(item, depth + 1);
    return isClause(item) ? compiled : `(${compiled})`;
  });
  return parts.join(joiner);
}

/**
 * Compile a structured filter to a Cloud Logging filter string. Throws
 * `Error` on structurally invalid input (callers map this to
 * `INVALID_FILTER`); inputs that passed `structuredLogFilterSchema` never
 * throw.
 */
export function compileLogFilter(filter: StructuredLogFilter): string {
  return compileNode(filter, 0);
}
