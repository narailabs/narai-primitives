import { describe, expect, it } from "vitest";
import { parseAction, parseStatus } from "../../../src/toolkit/usage/parse.js";

describe("parseAction", () => {
  it("extracts --action value from a typical Bash command", () => {
    const cmd = `npx @narai/github-agent-connector --action repo_info --params '{"owner":"x"}'`;
    expect(parseAction(cmd)).toBe("repo_info");
  });

  it("extracts --action when it is last on the line", () => {
    expect(parseAction(`foo --params '{}' --action get_file`)).toBe("get_file");
  });

  it("returns 'unknown' when --action is missing", () => {
    expect(parseAction("npx @narai/github-agent-connector --help")).toBe("unknown");
  });

  it("returns 'unknown' for empty command", () => {
    expect(parseAction("")).toBe("unknown");
  });

  it("allows hyphens and underscores in action names", () => {
    expect(parseAction("foo --action list-buckets")).toBe("list-buckets");
    expect(parseAction("foo --action query_logs")).toBe("query_logs");
  });
});

describe("parseStatus", () => {
  it("extracts status from a success envelope", () => {
    expect(parseStatus(JSON.stringify({ status: "success", data: {} }))).toBe("success");
  });

  it("extracts status from an error envelope", () => {
    expect(parseStatus(JSON.stringify({ status: "error", error_code: "X" }))).toBe("error");
  });

  it("returns 'unparseable' for non-JSON", () => {
    expect(parseStatus("not json")).toBe("unparseable");
  });

  it("returns 'unparseable' when JSON has no status field", () => {
    expect(parseStatus(JSON.stringify({ foo: "bar" }))).toBe("unparseable");
  });

  it("returns 'unparseable' for empty string", () => {
    expect(parseStatus("")).toBe("unparseable");
  });
});
