import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCredentialRef } from "../src/parse_ref.js";
import {
  CredentialResolver,
  clearProviders,
  registerProvider,
  type CredentialProvider,
} from "../src/index.js";

const stubProvider: CredentialProvider = {
  async getSecret() {
    return null;
  },
};

describe("parseCredentialRef", () => {
  beforeEach(() => {
    clearProviders();
  });

  afterEach(() => {
    clearProviders();
  });

  it("parses env references", () => {
    expect(parseCredentialRef("env:DB_PASSWORD")).toEqual({
      provider: "env_var",
      key: "DB_PASSWORD",
    });
  });

  it("parses env_var references (verbatim alias)", () => {
    expect(parseCredentialRef("env_var:DB_PASSWORD")).toEqual({
      provider: "env_var",
      key: "DB_PASSWORD",
    });
  });

  it("parses keychain references", () => {
    expect(parseCredentialRef("keychain:prod-db")).toEqual({
      provider: "keychain",
      key: "prod-db",
    });
  });

  it("parses cloud references", () => {
    expect(parseCredentialRef("cloud:secrets/db-prod")).toEqual({
      provider: "cloud_secrets",
      key: "secrets/db-prod",
    });
  });

  it("parses cloud_secrets references (verbatim alias)", () => {
    expect(parseCredentialRef("cloud_secrets:secrets/db-prod")).toEqual({
      provider: "cloud_secrets",
      key: "secrets/db-prod",
    });
  });

  it("keeps the file provider's nested colons intact", () => {
    expect(parseCredentialRef("file:creds.json:staging.password")).toEqual({
      provider: "file",
      key: "creds.json:staging.password",
    });
  });

  it("returns null for plain strings (no recognized prefix)", () => {
    expect(parseCredentialRef("hunter2")).toBeNull();
  });

  it("returns null for unknown providers", () => {
    expect(parseCredentialRef("hashicorp:app/db")).toBeNull();
  });

  it("returns null when the key is empty", () => {
    expect(parseCredentialRef("env:")).toBeNull();
  });

  it("returns null for leading-colon strings", () => {
    // ":foo" has colon at index 0 - no provider to parse.
    expect(parseCredentialRef(":foo")).toBeNull();
  });

  it("recognizes custom providers registered on the default resolver", () => {
    registerProvider("vault", stubProvider);
    expect(parseCredentialRef("vault:app/db")).toEqual({
      provider: "vault",
      key: "app/db",
    });
  });

  it("returns null for custom provider when not registered (non-strict)", () => {
    expect(parseCredentialRef("vault:app/db")).toBeNull();
  });

  it("throws for unknown provider in strict mode", () => {
    expect(() =>
      parseCredentialRef("vault:app/db", { strict: true }),
    ).toThrow(/unknown credential provider 'vault'/);
  });

  it("does not throw in strict mode when provider is registered", () => {
    registerProvider("vault", stubProvider);
    expect(parseCredentialRef("vault:app/db", { strict: true })).toEqual({
      provider: "vault",
      key: "app/db",
    });
  });

  it("does not throw in strict mode for built-in prefixes", () => {
    expect(parseCredentialRef("env:HOME", { strict: true })).toEqual({
      provider: "env_var",
      key: "HOME",
    });
  });

  it("uses a caller-supplied resolver when given", () => {
    const custom = new CredentialResolver();
    custom.register("customx", stubProvider);
    // Default resolver has nothing registered, but custom does.
    expect(
      parseCredentialRef("customx:k", { resolver: custom }),
    ).toEqual({ provider: "customx", key: "k" });
    // And the default resolver has no "customx" -> null.
    expect(parseCredentialRef("customx:k")).toBeNull();
  });

  // URI-form references - `scheme://rest`. Detection is syntactic
  // (presence of `://`). Non-file schemes take everything after `://`
  // verbatim; `file:` goes through `new URL` and folds the fragment
  // back into FileProvider's `path:dotted.key` convention.
  describe("URI form", () => {
    it("parses env:// URI", () => {
      expect(parseCredentialRef("env://DB_PASSWORD")).toEqual({
        provider: "env_var",
        key: "DB_PASSWORD",
      });
    });

    it("parses keychain:// URI", () => {
      expect(parseCredentialRef("keychain://prod-db")).toEqual({
        provider: "keychain",
        key: "prod-db",
      });
    });

    it("parses cloud:// URI", () => {
      expect(parseCredentialRef("cloud://my-secret")).toEqual({
        provider: "cloud_secrets",
        key: "my-secret",
      });
    });

    it("parses file:// URI with fragment into path:dotted.key", () => {
      expect(
        parseCredentialRef("file:///etc/creds.json#staging.password"),
      ).toEqual({
        provider: "file",
        key: "/etc/creds.json:staging.password",
      });
    });

    it("parses Windows file:// URI keeping the drive colon", () => {
      // Design call: keep the leading slash as URL produces it. The
      // FileProvider opens the absolute path `/C:/creds.json` fine on
      // Windows (Node normalizes it); the embedded `:user` carries the
      // dotted key exactly like the bare `file:...:key` form.
      expect(parseCredentialRef("file:///C:/creds.json#user")).toEqual({
        provider: "file",
        key: "/C:/creds.json:user",
      });
    });

    it("parses env_var:// verbatim (no alias expansion needed)", () => {
      expect(parseCredentialRef("env_var://DB_PASSWORD")).toEqual({
        provider: "env_var",
        key: "DB_PASSWORD",
      });
    });

    it("parses cloud_secrets:// verbatim", () => {
      expect(parseCredentialRef("cloud_secrets://my-secret")).toEqual({
        provider: "cloud_secrets",
        key: "my-secret",
      });
    });

    it("returns null for env:// with no key", () => {
      expect(parseCredentialRef("env://")).toBeNull();
    });

    it("supports custom registered providers via URI form", () => {
      registerProvider("vault", stubProvider);
      expect(parseCredentialRef("vault://app/db")).toEqual({
        provider: "vault",
        key: "app/db",
      });
    });

    it("returns null for unknown scheme (non-strict)", () => {
      // Typo-like: `envvar://` - close to a real scheme but not registered.
      expect(parseCredentialRef("envvar://X")).toBeNull();
    });

    it("throws for unknown scheme in strict mode", () => {
      expect(() =>
        parseCredentialRef("envvar://X", { strict: true }),
      ).toThrow(/unknown credential provider 'envvar'/);
    });

    it("treats the full post-:// string as the key for env://A/B", () => {
      // Design call: no special authority/path split. Everything after
      // `://` is the key verbatim. Harmless for env_var lookup (simply
      // misses) and useful for backends that accept slashes in names
      // (cloud paths, vault mounts, etc.).
      expect(parseCredentialRef("env://A/B")).toEqual({
        provider: "env_var",
        key: "A/B",
      });
    });

    it("still parses legacy bare env:DB_PASSWORD alongside URI form", () => {
      expect(parseCredentialRef("env:DB_PASSWORD")).toEqual({
        provider: "env_var",
        key: "DB_PASSWORD",
      });
    });
  });
});
