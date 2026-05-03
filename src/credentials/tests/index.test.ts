/**
 * Tests for the provider registry + resolveSecret helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialResolver,
  KNOWN_PROVIDERS,
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
  resolveSecret,
  resolveSecrets,
  type CredentialProvider,
} from "../src/index.js";

function makeProvider(
  data: Record<string, string>,
  throwOn?: string,
): CredentialProvider {
  return {
    async getSecret(name: string): Promise<string | null> {
      if (throwOn !== undefined && name === throwOn) {
        throw new Error(`boom on ${name}`);
      }
      return data[name] ?? null;
    },
  };
}

describe("credential_providers/index", () => {
  beforeEach(() => {
    clearProviders();
  });

  afterEach(() => {
    clearProviders();
  });

  it("registers and retrieves providers", () => {
    const p = makeProvider({});
    registerProvider("stub", p);
    expect(getProvider("stub")).toBe(p);
    expect(listProviders()).toEqual(["stub"]);
  });

  it("clearProviders empties the registry", () => {
    registerProvider("a", makeProvider({}));
    registerProvider("b", makeProvider({}));
    clearProviders();
    expect(listProviders()).toEqual([]);
  });

  it("resolveSecret returns the primary provider hit", async () => {
    registerProvider("primary", makeProvider({ foo: "1" }));
    registerProvider("secondary", makeProvider({ foo: "2" }));
    const value = await resolveSecret("foo", { provider: "primary" });
    expect(value).toBe("1");
  });

  it("resolveSecret falls back through the chain", async () => {
    registerProvider("primary", makeProvider({}));
    registerProvider("secondary", makeProvider({ foo: "from-secondary" }));
    const value = await resolveSecret("foo", {
      provider: "primary",
      fallback: ["secondary"],
    });
    expect(value).toBe("from-secondary");
  });

  it("resolveSecret returns null when every provider misses", async () => {
    registerProvider("a", makeProvider({}));
    registerProvider("b", makeProvider({}));
    expect(
      await resolveSecret("foo", { provider: "a", fallback: ["b"] }),
    ).toBeNull();
  });

  it("resolveSecret ignores thrown errors and keeps searching", async () => {
    registerProvider("broken", makeProvider({}, "foo"));
    registerProvider("good", makeProvider({ foo: "value" }));
    const value = await resolveSecret("foo", {
      provider: "broken",
      fallback: ["good"],
    });
    expect(value).toBe("value");
  });

  it("resolveSecret throws AggregateError when every provider throws", async () => {
    registerProvider("a", makeProvider({}, "foo"));
    registerProvider("b", makeProvider({}, "foo"));
    const promise = resolveSecret("foo", {
      provider: "a",
      fallback: ["b"],
    });
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    try {
      await promise;
    } catch (err) {
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect((agg.errors[0] as Error).message).toMatch(/boom/);
      expect((agg.errors[1] as Error).message).toMatch(/boom/);
    }
  });

  it("resolveSecret suppresses errors if at least one provider returns", async () => {
    registerProvider("broken", makeProvider({}, "foo"));
    registerProvider("good", makeProvider({}));
    // `good` runs to completion (returns null), so the thrown error from
    // `broken` is swallowed and we get null.
    expect(
      await resolveSecret("foo", {
        provider: "broken",
        fallback: ["good"],
      }),
    ).toBeNull();
  });

  it("resolveSecret with no provider specified iterates the registry", async () => {
    registerProvider("a", makeProvider({}));
    registerProvider("b", makeProvider({ foo: "b-val" }));
    expect(await resolveSecret("foo")).toBe("b-val");
  });

  it("skips unknown provider names gracefully", async () => {
    registerProvider("good", makeProvider({ foo: "v" }));
    const value = await resolveSecret("foo", {
      provider: "missing",
      fallback: ["good"],
    });
    expect(value).toBe("v");
  });
});

describe("resolveSecrets (batch)", () => {
  beforeEach(() => {
    clearProviders();
  });

  afterEach(() => {
    clearProviders();
  });

  it("resolves multiple refs in parallel", async () => {
    registerProvider("envA", makeProvider({ DB_PASSWORD: "dbpw" }));
    registerProvider("envB", makeProvider({ TOKEN: "tkn" }));
    const out = await resolveSecrets({
      db: "envA:DB_PASSWORD",
      token: "envB:TOKEN",
    });
    expect(out).toEqual({ db: "dbpw", token: "tkn" });
  });

  it("returns null for misses when not strict", async () => {
    registerProvider("src", makeProvider({ present: "v" }));
    const out = await resolveSecrets({
      a: "src:present",
      b: "src:absent",
    });
    expect(out).toEqual({ a: "v", b: null });
  });

  it("throws under strict: true when any alias is null", async () => {
    registerProvider("src", makeProvider({ present: "v" }));
    await expect(
      resolveSecrets(
        { a: "src:present", b: "src:absent" },
        { strict: true },
      ),
    ).rejects.toThrow(/aliases returned null: b/);
  });

  it("AggregateError wraps per-alias errors with the alias name", async () => {
    registerProvider("broken", makeProvider({}, "boom-key"));
    registerProvider("good", makeProvider({ ok: "v" }));
    const promise = resolveSecrets({
      bad: "broken:boom-key",
      fine: "good:ok",
    });
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    try {
      await promise;
    } catch (err) {
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(1);
      expect((agg.errors[0] as Error).message).toMatch(/alias "bad" failed/);
      expect(agg.message).toMatch(/bad/);
    }
  });

  it("throws upfront for an invalid ref string (unknown provider prefix)", async () => {
    registerProvider("src", makeProvider({ ok: "v" }));
    await expect(
      resolveSecrets({ a: "nosuch:whatever", b: "src:ok" }),
    ).rejects.toThrow(/unknown credential provider/);
  });

  it("returns an empty object for empty specs", async () => {
    const out = await resolveSecrets({});
    expect(out).toEqual({});
  });

  it("preserves insertion order in the returned object", async () => {
    registerProvider("src", makeProvider({ a: "1", b: "2", c: "3" }));
    const out = await resolveSecrets({
      zeta: "src:a",
      alpha: "src:b",
      mu: "src:c",
    });
    expect(Object.keys(out)).toEqual(["zeta", "alpha", "mu"]);
  });
});

describe("CredentialResolver", () => {
  it("two instances do not share registry state", () => {
    const a = new CredentialResolver();
    const b = new CredentialResolver();
    const pA = { async getSecret() { return "from-a"; } };
    const pB = { async getSecret() { return "from-b"; } };
    a.register("stub", pA);
    b.register("stub", pB);
    expect(a.list()).toEqual(["stub"]);
    expect(b.list()).toEqual(["stub"]);
    expect(a.get("stub")).toBe(pA);
    expect(b.get("stub")).toBe(pB);
    a.clear();
    expect(a.list()).toEqual([]);
    expect(b.list()).toEqual(["stub"]);
  });

  it("resolveSecret runs against only its own registry", async () => {
    const a = new CredentialResolver();
    const b = new CredentialResolver();
    a.register("x", { async getSecret() { return "a-val"; } });
    b.register("x", { async getSecret() { return "b-val"; } });
    expect(await a.resolveSecret("anything")).toBe("a-val");
    expect(await b.resolveSecret("anything")).toBe("b-val");
  });

  describe("KNOWN_PROVIDERS", () => {
    it("contains every built-in short name and is frozen", () => {
      expect([...KNOWN_PROVIDERS]).toEqual([
        "env",
        "keychain",
        "file",
        "cloud",
      ]);
      expect(Object.isFrozen(KNOWN_PROVIDERS)).toBe(true);
    });
  });
});
