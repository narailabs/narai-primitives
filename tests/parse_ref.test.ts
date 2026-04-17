import { describe, expect, it } from "vitest";
import { parseCredentialRef } from "../src/parse_ref.js";

describe("parseCredentialRef", () => {
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
});
