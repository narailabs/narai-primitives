/**
 * Tests for the redact / redactAll helpers.
 */
import { describe, expect, it } from "vitest";
import { redact, redactAll } from "../src/redact.js";

describe("credential_providers/redact", () => {
  describe("redact", () => {
    it("replaces a single occurrence with the default placeholder", () => {
      expect(redact("hunter2xyz", "password=hunter2xyz")).toBe(
        "password=[REDACTED]",
      );
    });

    it("replaces every occurrence (global match)", () => {
      expect(redact("abcd", "abcd and abcd again")).toBe(
        "[REDACTED] and [REDACTED] again",
      );
    });

    it("escapes regex-special characters in the needle", () => {
      expect(redact("a.b+c", "x a.b+c y")).toBe("x [REDACTED] y");
    });

    it("does not treat regex metacharacters as wildcards", () => {
      // Without escaping, `a.b` would also match `aXb`. Verify it doesn't.
      expect(redact("a.b+", "aXb+ literal a.b+ tail")).toBe(
        "aXb+ literal [REDACTED] tail",
      );
    });

    it("leaves haystack unchanged when needle is below the length threshold", () => {
      expect(redact("key", "api-key=abc")).toBe("api-key=abc");
    });

    it("leaves haystack unchanged when needle is empty", () => {
      expect(redact("", "nothing should change")).toBe("nothing should change");
    });

    it("redacts a needle exactly at the length threshold", () => {
      // 4 chars is the minimum — should redact.
      expect(redact("abcd", "xx abcd yy")).toBe("xx [REDACTED] yy");
    });

    it("accepts a custom placeholder", () => {
      expect(redact("hunter2xyz", "password=hunter2xyz", "***")).toBe(
        "password=***",
      );
    });

    it("is case-sensitive", () => {
      expect(redact("Secret", "secret Secret SECRET")).toBe(
        "secret [REDACTED] SECRET",
      );
    });

    it("returns haystack unchanged when needle is absent", () => {
      expect(redact("absent-value", "nothing to see")).toBe("nothing to see");
    });
  });

  describe("redactAll", () => {
    it("redacts every needle in an array", () => {
      const out = redactAll(
        ["hunter2xyz", "tokenABCD"],
        "pw=hunter2xyz tok=tokenABCD",
      );
      expect(out).toBe("pw=[REDACTED] tok=[REDACTED]");
    });

    it("honours a custom placeholder for every needle", () => {
      const out = redactAll(["alpha1", "beta22"], "alpha1 and beta22", "<>");
      expect(out).toBe("<> and <>");
    });

    it("respects caller iteration order (overlap)", () => {
      // With needle "bbbb" applied first, the longer "aabbbbcc" no longer
      // matches as a substring of the rewritten haystack.
      const out = redactAll(["bbbb", "aabbbbcc"], "aabbbbcc");
      expect(out).toBe("aa[REDACTED]cc");
    });

    it("longest-first order redacts the wider span", () => {
      const out = redactAll(["aabbbbcc", "bbbb"], "aabbbbcc");
      expect(out).toBe("[REDACTED]");
    });

    it("honours the Iterable contract (Set input)", () => {
      const needles = new Set(["hunter2xyz", "tokenABCD"]);
      const out = redactAll(needles, "pw=hunter2xyz tok=tokenABCD");
      expect(out).toBe("pw=[REDACTED] tok=[REDACTED]");
    });

    it("honours the Iterable contract (generator input)", () => {
      function* gen(): Generator<string> {
        yield "hunter2xyz";
        yield "tokenABCD";
      }
      const out = redactAll(gen(), "pw=hunter2xyz tok=tokenABCD");
      expect(out).toBe("pw=[REDACTED] tok=[REDACTED]");
    });

    it("skips short needles but still processes the rest", () => {
      const out = redactAll(
        ["key", "hunter2xyz"],
        "api-key=abc pw=hunter2xyz",
      );
      expect(out).toBe("api-key=abc pw=[REDACTED]");
    });

    it("is a no-op on an empty iterable", () => {
      expect(redactAll([], "no changes")).toBe("no changes");
    });
  });
});
