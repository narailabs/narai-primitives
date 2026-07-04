/**
 * log_filter.ts — compile structured JSON clauses into a Cloud Logging
 * filter string.
 *
 * Security model: injection safety comes by construction, not by blocklist.
 * - `op` is an allowlist (`=`, `!=`, `>=`, `<=`, `contains`/`:`).
 * - `field` must be a dotted identifier (`[A-Za-z0-9_.]` segments), so a
 *   field can never smuggle operators or quotes.
 * - `value` is always treated as data: strings are double-quoted with
 *   embedded quotes/backslashes/control characters escaped per Cloud
 *   Logging filter syntax; numbers must be finite and are emitted bare.
 *
 * Nesting: a top-level clause, or one `and`/`or` group whose members are
 * clauses or one further level of `and`/`or` groups of clauses.
 */

export type FilterOp = "=" | "!=" | ">=" | "<=" | "contains" | ":";

export interface FilterClause {
  field: string;
  op: FilterOp;
  value: string | number;
}

export interface FilterGroup {
  and?: FilterNode[];
  or?: FilterNode[];
}

export type FilterNode = FilterClause | FilterGroup;

export class LogFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogFilterError";
  }
}

const ALLOWED_OPS: ReadonlySet<string> = new Set([
  "=",
  "!=",
  ">=",
  "<=",
  "contains",
  ":",
]);

const FIELD_SAFE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function quoteValue(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LogFilterError("Numeric filter values must be finite");
    }
    return String(value);
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function compileClause(clause: FilterClause): string {
  if (typeof clause.field !== "string" || !FIELD_SAFE.test(clause.field)) {
    throw new LogFilterError(
      `Invalid filter field '${String(clause.field)}' — must be a dotted identifier`,
    );
  }
  if (!ALLOWED_OPS.has(clause.op)) {
    throw new LogFilterError(
      `Invalid filter op '${String(clause.op)}' — allowed: =, !=, >=, <=, contains, :`,
    );
  }
  const op = clause.op === "contains" ? ":" : clause.op;
  return `${clause.field}${op}${quoteValue(clause.value)}`;
}

function isClause(node: FilterNode): node is FilterClause {
  return !("and" in node) && !("or" in node);
}

function compileGroup(group: FilterGroup, depth: number): string {
  const hasAnd = group.and !== undefined;
  const hasOr = group.or !== undefined;
  if (hasAnd === hasOr) {
    throw new LogFilterError(
      "Filter group must have exactly one of 'and' / 'or'",
    );
  }
  const members = (hasAnd ? group.and : group.or) ?? [];
  if (!Array.isArray(members) || members.length === 0) {
    throw new LogFilterError("Filter group must contain at least one clause");
  }
  const joiner = hasAnd ? " AND " : " OR ";
  const parts = members.map((member) => {
    if (isClause(member)) return compileClause(member);
    if (depth >= 1) {
      throw new LogFilterError(
        "Filter groups may only nest one level deep",
      );
    }
    return `(${compileGroup(member, depth + 1)})`;
  });
  return parts.join(joiner);
}

/**
 * Compile a structured filter node into a Cloud Logging filter string.
 * Throws LogFilterError on any shape/op/field violation.
 */
export function compileLogFilter(node: FilterNode): string {
  if (node === null || typeof node !== "object") {
    throw new LogFilterError("Structured filter must be an object");
  }
  if (isClause(node)) return compileClause(node);
  return compileGroup(node, 0);
}
