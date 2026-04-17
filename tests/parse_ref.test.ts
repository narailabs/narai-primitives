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
    // ":foo" has colon at index 0 — no provider to parse.
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
    // And the default resolver has no "customx" → null.
    expect(parseCredentialRef("customx:k")).toBeNull();
  });
});
