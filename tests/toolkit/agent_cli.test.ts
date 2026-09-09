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

  it("throws on unknown --flag, naming the accepted flags and not the rejected one", () => {
    // Asserts the INTENT, not the old wording. The message used to quote the
    // rejected name back, and a credential passed as an argument therefore
    // reached stdout and stderr through writeArgErrorEnvelope. `scrubSecrets`
    // is shape-based and cannot recognise a bare token, so the fix is to not
    // build it into the message at all.
    expect(() =>
      parseAgentArgs(["--bogus", "x"], { flags: STD_FLAGS }),
    ).toThrow(/unrecognized flag/);
    expect(() =>
      parseAgentArgs(["--bogus", "x"], { flags: STD_FLAGS }),
    ).toThrow(/--action/);
    expect(() =>
      parseAgentArgs(["--bogus", "x"], { flags: STD_FLAGS }),
    ).not.toThrow(/bogus/);
  });

  it("throws on a positional argument without echoing it", () => {
    const secret = "ghp_AAAABBBBCCCCDDDD";
    expect(() => parseAgentArgs([secret], { flags: STD_FLAGS })).toThrow(
      /unrecognized argument/,
    );
    expect(() => parseAgentArgs([secret], { flags: STD_FLAGS })).not.toThrow(
      new RegExp(secret),
    );
    // Our own flag names are the diagnostic half and must survive.
    expect(() => parseAgentArgs([secret], { flags: STD_FLAGS })).toThrow(
      /--action/,
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
