import { describe, it, expect } from "vitest";
import { parsePluginConfig } from "../../plugin-hooks/plugin-config.mjs";

describe("parsePluginConfig", () => {
  it("parses a minimal config", () => {
    const cfg = parsePluginConfig(JSON.stringify({ name: "jira" }));
    expect(cfg).toEqual({ name: "jira" });
  });

  it("parses with binPath", () => {
    const cfg = parsePluginConfig(
      JSON.stringify({
        name: "jira",
        binPath: "narai-primitives/dist/connectors/jira",
        kind: "connector",
      }),
    );
    expect(cfg.binPath).toBe("narai-primitives/dist/connectors/jira");
    expect(cfg.kind).toBe("connector");
  });

  it("rejects missing name", () => {
    expect(() => parsePluginConfig("{}")).toThrow(/name/);
  });

  it("rejects non-string name", () => {
    expect(() => parsePluginConfig(JSON.stringify({ name: 42 }))).toThrow(
      /name/,
    );
  });

  it("rejects empty-string name", () => {
    expect(() => parsePluginConfig(JSON.stringify({ name: "" }))).toThrow(
      /name/,
    );
  });

  it("rejects unknown kind", () => {
    expect(() =>
      parsePluginConfig(JSON.stringify({ name: "x", kind: "weird" })),
    ).toThrow(/kind/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parsePluginConfig("not json")).toThrow();
  });

  it("round-trips a valid enforcement posture", () => {
    expect(
      parsePluginConfig(JSON.stringify({ name: "x", enforcement: "fail_closed" }))
        .enforcement,
    ).toBe("fail_closed");
    expect(
      parsePluginConfig(JSON.stringify({ name: "x", enforcement: "fail_open" }))
        .enforcement,
    ).toBe("fail_open");
  });

  it("omits enforcement when absent", () => {
    expect(parsePluginConfig(JSON.stringify({ name: "x" })).enforcement)
      .toBeUndefined();
  });

  it("rejects an invalid enforcement value", () => {
    expect(() =>
      parsePluginConfig(JSON.stringify({ name: "x", enforcement: "nope" })),
    ).toThrow(/enforcement/);
  });
});
