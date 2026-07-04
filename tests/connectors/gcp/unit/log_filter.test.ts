/**
 * Unit tests for the structured Cloud Logging filter compiler — exact
 * compiled strings for the common query shapes, injection attempts kept
 * inside escaped quoted literals, and validation of fields/ops/nesting.
 */
import { describe, expect, it } from "vitest";
import {
  compileLogFilter,
  structuredLogFilterSchema,
  type StructuredLogFilter,
} from "../../../../src/connectors/gcp/lib/log_filter.js";

describe("compileLogFilter — common query shapes", () => {
  it("compiles a k8s container error query with a severity floor", () => {
    const filter: StructuredLogFilter = {
      and: [
        { field: "resource.type", op: "=", value: "k8s_container" },
        {
          field: "resource.labels.namespace_name",
          op: "=",
          value: "orders-dev-app",
        },
        {
          field: "resource.labels.container_name",
          op: "=",
          value: "data-entry",
        },
        { field: "severity", op: ">=", value: "ERROR" },
      ],
    };
    expect(compileLogFilter(filter)).toBe(
      'resource.type="k8s_container" AND ' +
        'resource.labels.namespace_name="orders-dev-app" AND ' +
        'resource.labels.container_name="data-entry" AND ' +
        'severity>="ERROR"',
    );
  });

  it("compiles multi-word text search via 'contains'", () => {
    expect(
      compileLogFilter({
        field: "textPayload",
        op: "contains",
        value: "connection refused",
      }),
    ).toBe('textPayload:"connection refused"');
  });

  it("accepts ':' as a direct alias for contains", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: "refused" }),
    ).toBe('textPayload:"refused"');
  });

  it("compiles a trace lookup", () => {
    const trace =
      "projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef";
    expect(compileLogFilter({ field: "trace", op: "=", value: trace })).toBe(
      `trace="${trace}"`,
    );
  });

  it("compiles a jsonPayload field match", () => {
    expect(
      compileLogFilter({ field: "jsonPayload.level", op: "=", value: "ERROR" }),
    ).toBe('jsonPayload.level="ERROR"');
  });

  it("compiles != and <= operators", () => {
    expect(
      compileLogFilter({
        and: [
          { field: "severity", op: "<=", value: "WARNING" },
          { field: "resource.type", op: "!=", value: "gce_instance" },
        ],
      }),
    ).toBe('severity<="WARNING" AND resource.type!="gce_instance"');
  });

  it("compiles an OR group and parenthesizes nested groups", () => {
    const filter: StructuredLogFilter = {
      and: [
        { field: "resource.type", op: "=", value: "k8s_container" },
        {
          or: [
            { field: "severity", op: "=", value: "ERROR" },
            { field: "severity", op: "=", value: "CRITICAL" },
          ],
        },
      ],
    };
    expect(compileLogFilter(filter)).toBe(
      'resource.type="k8s_container" AND ' +
        '(severity="ERROR" OR severity="CRITICAL")',
    );
  });

  it("stringifies numeric and boolean values as quoted data", () => {
    expect(
      compileLogFilter({ field: "httpRequest.status", op: ">=", value: 500 }),
    ).toBe('httpRequest.status>="500"');
    expect(
      compileLogFilter({ field: "jsonPayload.retryable", op: "=", value: true }),
    ).toBe('jsonPayload.retryable="true"');
  });
});

describe("compileLogFilter — injection attempts stay inside quoted data", () => {
  it("escapes a quote-breakout attempt into a harmless literal", () => {
    const compiled = compileLogFilter({
      field: "textPayload",
      op: "=",
      value: '" OR severity>="DEBUG',
    });
    expect(compiled).toBe('textPayload="\\" OR severity>=\\"DEBUG"');
    // Every raw double-quote inside the value is preceded by a backslash —
    // nothing can terminate the literal early.
    expect(compiled).not.toMatch(/[^\\]" OR /);
  });

  it("keeps shell-style command substitution as inert text", () => {
    expect(
      compileLogFilter({
        field: "textPayload",
        op: "contains",
        value: "$(rm -rf /)",
      }),
    ).toBe('textPayload:"$(rm -rf /)"');
  });

  it("keeps backticks as inert text", () => {
    expect(
      compileLogFilter({
        field: "textPayload",
        op: "=",
        value: "`whoami`",
      }),
    ).toBe('textPayload="`whoami`"');
  });

  it("escapes newlines so the compiled filter is a single line", () => {
    const compiled = compileLogFilter({
      field: "textPayload",
      op: "=",
      value: 'line1\nline2"\r\tend',
    });
    expect(compiled).toBe('textPayload="line1\\nline2\\"\\r\\tend"');
    expect(compiled).not.toContain("\n");
  });

  it("escapes backslashes before quotes so escapes cannot be neutralized", () => {
    // A trailing backslash in the value must not swallow the closing quote.
    expect(
      compileLogFilter({ field: "textPayload", op: "=", value: 'x\\"y\\' }),
    ).toBe('textPayload="x\\\\\\"y\\\\"');
  });
});

describe("compileLogFilter — validation", () => {
  it("rejects fields that are not dotted identifier paths", () => {
    for (const field of [
      "severity OR textPayload",
      'resource.type="x"',
      "a..b",
      ".leading",
      "trailing.",
      "bad-dash",
      "",
    ]) {
      expect(() =>
        compileLogFilter({ field, op: "=", value: "x" }),
      ).toThrow(/Invalid filter field/);
    }
  });

  it("rejects non-allowlisted operators", () => {
    expect(() =>
      compileLogFilter({
        field: "severity",
        op: ">" as never,
        value: "ERROR",
      }),
    ).toThrow(/Invalid filter op/);
  });

  it("rejects empty groups", () => {
    expect(() => compileLogFilter({ and: [] })).toThrow(/at least one clause/);
  });

  it("rejects groups nested more than one level deep", () => {
    const tooDeep = {
      and: [{ or: [{ and: [{ field: "severity", op: "=", value: "ERROR" }] }] }],
    } as unknown as StructuredLogFilter;
    expect(() => compileLogFilter(tooDeep)).toThrow(/one level deep/);
  });
});

describe("structuredLogFilterSchema", () => {
  it("accepts a bare clause and a one-level nested group", () => {
    expect(
      structuredLogFilterSchema.safeParse({
        field: "severity",
        op: ">=",
        value: "ERROR",
      }).success,
    ).toBe(true);
    expect(
      structuredLogFilterSchema.safeParse({
        and: [
          { field: "resource.type", op: "=", value: "k8s_container" },
          { or: [{ field: "severity", op: "=", value: "ERROR" }] },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown ops, bad fields, unknown keys, and double nesting", () => {
    expect(
      structuredLogFilterSchema.safeParse({
        field: "severity",
        op: ">",
        value: "ERROR",
      }).success,
    ).toBe(false);
    expect(
      structuredLogFilterSchema.safeParse({
        field: "severity; rm -rf /",
        op: "=",
        value: "ERROR",
      }).success,
    ).toBe(false);
    expect(
      structuredLogFilterSchema.safeParse({
        field: "severity",
        op: "=",
        value: "ERROR",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      structuredLogFilterSchema.safeParse({
        and: [{ or: [{ and: [{ field: "a", op: "=", value: "b" }] }] }],
      }).success,
    ).toBe(false);
    expect(
      structuredLogFilterSchema.safeParse({
        and: [{ field: "a", op: "=", value: "b" }],
        or: [{ field: "a", op: "=", value: "b" }],
      }).success,
    ).toBe(false);
  });
});
