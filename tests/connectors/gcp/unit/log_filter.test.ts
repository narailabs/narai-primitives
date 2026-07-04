/**
 * Unit tests for the Cloud Logging structured-filter compiler.
 *
 * The compiler turns JSON clauses into a Cloud Logging filter string with
 * correct quoting/escaping — injection safety comes by construction (op
 * allowlist, identifier-pattern fields, values always treated as data),
 * not by blocklisting characters.
 */
import { describe, expect, it } from "vitest";
import {
  compileLogFilter,
  LogFilterError,
} from "../../../../src/connectors/gcp/lib/log_filter.js";

describe("compileLogFilter — single clauses", () => {
  it("compiles an exact-match clause with a quoted value", () => {
    expect(
      compileLogFilter({ field: "resource.type", op: "=", value: "k8s_container" }),
    ).toBe('resource.type="k8s_container"');
  });

  it("compiles a severity floor (>=)", () => {
    expect(
      compileLogFilter({ field: "severity", op: ">=", value: "ERROR" }),
    ).toBe('severity>="ERROR"');
  });

  it("compiles a multi-word text search with the : operator", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: "connection refused" }),
    ).toBe('textPayload:"connection refused"');
  });

  it("accepts 'contains' as an alias for :", () => {
    expect(
      compileLogFilter({
        field: "textPayload",
        op: "contains",
        value: "NullPointerException",
      }),
    ).toBe('textPayload:"NullPointerException"');
  });

  it("compiles a trace lookup", () => {
    expect(
      compileLogFilter({
        field: "trace",
        op: "=",
        value:
          "projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef",
      }),
    ).toBe(
      'trace="projects/acme-prod-123/traces/0123456789abcdef0123456789abcdef"',
    );
  });

  it("compiles a jsonPayload field match", () => {
    expect(
      compileLogFilter({ field: "jsonPayload.level", op: "=", value: "ERROR" }),
    ).toBe('jsonPayload.level="ERROR"');
  });

  it("compiles != and <= operators", () => {
    expect(
      compileLogFilter({ field: "severity", op: "!=", value: "DEBUG" }),
    ).toBe('severity!="DEBUG"');
    expect(
      compileLogFilter({ field: "severity", op: "<=", value: "WARNING" }),
    ).toBe('severity<="WARNING"');
  });

  it("emits finite numeric values unquoted", () => {
    expect(
      compileLogFilter({ field: "jsonPayload.attempts", op: ">=", value: 3 }),
    ).toBe("jsonPayload.attempts>=3");
  });
});

describe("compileLogFilter — and/or groups", () => {
  it("compiles the canonical GKE error query (acceptance #1)", () => {
    expect(
      compileLogFilter({
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
      }),
    ).toBe(
      'resource.type="k8s_container" AND ' +
        'resource.labels.namespace_name="orders-dev-app" AND ' +
        'resource.labels.container_name="data-entry" AND ' +
        'severity>="ERROR"',
    );
  });

  it("compiles an or group", () => {
    expect(
      compileLogFilter({
        or: [
          { field: "severity", op: "=", value: "ERROR" },
          { field: "severity", op: "=", value: "CRITICAL" },
        ],
      }),
    ).toBe('severity="ERROR" OR severity="CRITICAL"');
  });

  it("parenthesizes a nested group one level deep", () => {
    expect(
      compileLogFilter({
        and: [
          { field: "resource.type", op: "=", value: "k8s_container" },
          {
            or: [
              { field: "severity", op: "=", value: "ERROR" },
              { field: "textPayload", op: ":", value: "timeout" },
            ],
          },
        ],
      }),
    ).toBe(
      'resource.type="k8s_container" AND ' +
        '(severity="ERROR" OR textPayload:"timeout")',
    );
  });
});

describe("compileLogFilter — injection attempts stay data (acceptance #5)", () => {
  it("keeps a quote-breakout attempt inside an escaped quoted string", () => {
    expect(
      compileLogFilter({
        field: "textPayload",
        op: ":",
        value: '" OR severity>="DEBUG',
      }),
    ).toBe('textPayload:"\\" OR severity>=\\"DEBUG"');
  });

  it("keeps command substitution as quoted data", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: "$(rm -rf /)" }),
    ).toBe('textPayload:"$(rm -rf /)"');
  });

  it("keeps backticks as quoted data", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: "`whoami`" }),
    ).toBe('textPayload:"`whoami`"');
  });

  it("escapes newlines so the value cannot span filter lines", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: "a\nb" }),
    ).toBe('textPayload:"a\\nb"');
  });

  it("escapes backslashes before quotes so escapes cannot be neutralized", () => {
    expect(
      compileLogFilter({ field: "textPayload", op: ":", value: 'a\\" OR x' }),
    ).toBe('textPayload:"a\\\\\\" OR x"');
  });
});

describe("compileLogFilter — rejects unsafe shapes", () => {
  it("rejects an op outside the allowlist", () => {
    expect(() =>
      compileLogFilter({
        field: "severity",
        op: "=~" as never,
        value: "ERROR",
      }),
    ).toThrow(LogFilterError);
  });

  it("rejects a field that is not a dotted identifier", () => {
    expect(() =>
      compileLogFilter({
        field: 'severity="ERROR" OR x',
        op: "=",
        value: "y",
      }),
    ).toThrow(LogFilterError);
  });

  it("rejects a field with a leading dot", () => {
    expect(() =>
      compileLogFilter({ field: ".hidden", op: "=", value: "x" }),
    ).toThrow(LogFilterError);
  });

  it("rejects non-finite numeric values", () => {
    expect(() =>
      compileLogFilter({
        field: "jsonPayload.n",
        op: "=",
        value: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(LogFilterError);
  });

  it("rejects an empty group", () => {
    expect(() => compileLogFilter({ and: [] })).toThrow(LogFilterError);
  });

  it("rejects a group with both and + or keys", () => {
    expect(() =>
      compileLogFilter({
        and: [{ field: "severity", op: "=", value: "ERROR" }],
        or: [{ field: "severity", op: "=", value: "INFO" }],
      }),
    ).toThrow(LogFilterError);
  });

  it("rejects nesting deeper than one level", () => {
    expect(() =>
      compileLogFilter({
        and: [
          {
            or: [
              {
                and: [{ field: "severity", op: "=", value: "ERROR" }],
              } as never,
            ],
          },
        ],
      }),
    ).toThrow(LogFilterError);
  });
});
