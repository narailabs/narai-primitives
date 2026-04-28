import { describe, expect, it, vi } from "vitest";
import { encodeTokens } from "../../../src/toolkit/usage/tokenize.js";

describe("encodeTokens", () => {
  it("heuristic returns Math.ceil(bytes/4)", async () => {
    const r = await encodeTokens("hello world", "heuristic");
    expect(r.count).toBe(Math.ceil(11 / 4));
    expect(r.method).toBe("heuristic");
  });

  it("heuristic for empty string is 0", async () => {
    const r = await encodeTokens("", "heuristic");
    expect(r.count).toBe(0);
    expect(r.method).toBe("heuristic");
  });

  it("unknown method falls back to heuristic", async () => {
    const r = await encodeTokens("abcd", "bogus-model" as "heuristic");
    expect(r.method).toBe("heuristic");
    expect(r.count).toBe(1);
  });

  it("gpt-4o returns a positive count when the tokenizer is available", async () => {
    const r = await encodeTokens("Hello, world!", "gpt-4o");
    // In dev env with gpt-tokenizer installed, real count; otherwise
    // fallback heuristic. Either way, must be > 0 for non-empty input.
    expect(r.count).toBeGreaterThan(0);
    expect(["gpt-4o", "heuristic"]).toContain(r.method);
  });
});
