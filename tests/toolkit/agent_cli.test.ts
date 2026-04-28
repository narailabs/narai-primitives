/**
 * Tests for `parseAgentArgs` — the shared CLI parser for connectors.
 */
import { describe, expect, it } from "vitest";

import { parseAgentArgs } from "../../src/toolkit/agent_cli.js";

const STD_FLAGS = ["action", "params"];

describe("parseAgentArgs", () => {
  it("parses --action <value> --params <value>", () => {
    const r = parseAgentArgs(
      ["--action", "search", "--params", '{"q":"foo"}'],
      { flags: STD_FLAGS },
    );
    expect(r.action).toBe("search");
    expect(r.params).toBe('{"q":"foo"}');
    expect(r.help).toBeUndefined();
  });

  it("parses --flag=value form", () => {
    const r = parseAgentArgs(
      ["--action=get_page", '--params={"id":"1"}'],
      { flags: STD_FLAGS },
    );
    expect(r.action).toBe("get_page");
    expect(r.params).toBe('{"id":"1"}');
  });

  it("recognises --help", () => {
    expect(parseAgentArgs(["--help"], { flags: STD_FLAGS }).help).toBe(true);
  });

  it("recognises -h", () => {
    expect(parseAgentArgs(["-h"], { flags: STD_FLAGS }).help).toBe(true);
  });

  it("throws on unknown --flag", () => {
    expect(() =>
      parseAgentArgs(["--bogus", "x"], { flags: STD_FLAGS }),
    ).toThrow(/unrecognized argument: --bogus/);
  });

  it("throws on positional argument", () => {
    expect(() => parseAgentArgs(["get_page"], { flags: STD_FLAGS })).toThrow(
      /unrecognized argument: get_page/,
    );
  });

  it("treats a missing trailing value as empty string", () => {
    const r = parseAgentArgs(["--action"], { flags: STD_FLAGS });
    expect(r.action).toBe("");
  });

  it("empty argv produces an empty result", () => {
    expect(parseAgentArgs([], { flags: STD_FLAGS })).toEqual({});
  });

  it("last value wins when the same flag appears twice", () => {
    const r = parseAgentArgs(
      ["--action", "first", "--action", "second"],
      { flags: STD_FLAGS },
    );
    expect(r.action).toBe("second");
  });

  it("accepts mixed --flag value and --flag=value forms in one invocation", () => {
    const r = parseAgentArgs(
      ["--action", "search", '--params={"q":"foo"}'],
      { flags: STD_FLAGS },
    );
    expect(r.action).toBe("search");
    expect(r.params).toBe('{"q":"foo"}');
  });
});
