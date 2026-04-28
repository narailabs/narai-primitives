import { describe, it, expect } from "vitest";
import { assertValidSecretSyntax, validateSecretsInTree } from "../../src/config/secrets.js";

describe("assertValidSecretSyntax", () => {
  it("accepts plain literals", () => {
    expect(() => assertValidSecretSyntax("hello")).not.toThrow();
    expect(() => assertValidSecretSyntax("")).not.toThrow();
    expect(() => assertValidSecretSyntax("postgres://localhost/db")).not.toThrow();
  });

  it("accepts the canonical env: form", () => {
    expect(() => assertValidSecretSyntax("env:PG_PASSWORD")).not.toThrow();
    expect(() => assertValidSecretSyntax("env:ANY_NAME")).not.toThrow();
  });

  it("accepts other recognized prefixes unchanged", () => {
    expect(() => assertValidSecretSyntax("keychain:db-prod")).not.toThrow();
    expect(() => assertValidSecretSyntax("file:./creds.json:db.password")).not.toThrow();
    expect(() => assertValidSecretSyntax("cloud:my-secret")).not.toThrow();
  });

  it("rejects env.NAME (dot form) with a clear message", () => {
    expect(() => assertValidSecretSyntax("env.PG_PASSWORD")).toThrow(/Use 'env:NAME'/);
    expect(() => assertValidSecretSyntax("env.PG_PASSWORD")).toThrow(/with a colon/);
  });

  it("includes the location in the error when given", () => {
    expect(() => assertValidSecretSyntax("env.X", "connectors.db.password")).toThrow(
      /at connectors\.db\.password/,
    );
  });
});

describe("validateSecretsInTree", () => {
  it("walks objects recursively", () => {
    const tree = {
      a: "ok",
      b: { c: "env:OK" },
    };
    expect(() => validateSecretsInTree(tree)).not.toThrow();
  });

  it("walks arrays and reports the index in the path", () => {
    const tree = { servers: ["good", "env:OK", "env.BAD"] };
    expect(() => validateSecretsInTree(tree)).toThrow(/servers\[2\]/);
  });

  it("reports a dotted path for nested errors", () => {
    const tree = {
      connectors: {
        db: {
          servers: {
            "app1-db": { password: "env.WRONG" },
          },
        },
      },
    };
    expect(() => validateSecretsInTree(tree)).toThrow(
      /connectors\.db\.servers\.app1-db\.password/,
    );
  });

  it("ignores non-string scalars", () => {
    const tree = { a: 42, b: true, c: null, d: undefined };
    expect(() => validateSecretsInTree(tree)).not.toThrow();
  });
});
