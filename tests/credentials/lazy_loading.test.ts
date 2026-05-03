/**
 * Regression test: cloud SDKs and native keyring bindings must only ever
 * be reached via dynamic `import()` — never via top-level static imports.
 *
 * Loading `narai-primitives/credentials` is a routine operation in long-lived
 * processes (the hub itself resolves config refs at startup). If a refactor
 * promoted any of these to a static `import`, every credentials consumer
 * would pay tens of MB of resident memory for SDKs they never call.
 *
 * Static analysis beats runtime checks here: under ESM there is no public
 * "loaded modules" registry, but the failure mode is purely a top-level
 * `import` statement being added — which a regex over the source files
 * catches deterministically.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_SRC = path.resolve(HERE, "../../src/credentials");

const FORBIDDEN_TOP_LEVEL_IMPORTS = [
  /^@aws-sdk\//,
  /^@google-cloud\//,
  /^@azure\//,
  /^@napi-rs\//,
];

const SOURCE_FILES = [
  "index.ts",
  "env_var.ts",
  "file.ts",
  "keychain.ts",
  "cloud_secrets.ts",
  "parse_ref.ts",
  "redact.ts",
];

interface TopLevelImport {
  file: string;
  line: number;
  spec: string;
}

function extractTopLevelImports(file: string, source: string): TopLevelImport[] {
  const out: TopLevelImport[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Top-level `import ... from "x"` statements only — no leading whitespace.
    // `import type` is also matched (we still want to forbid it; type-only is
    // erased at runtime, but a type import of an SDK signals the boundary
    // is leaking).
    const match = line.match(/^import\s+(?:type\s+)?[^"']*["']([^"']+)["']/);
    if (match && match[1]) {
      out.push({ file, line: i + 1, spec: match[1] });
    }
  }
  return out;
}

describe("credentials subpath: lazy-loading discipline", () => {
  it("no top-level import statement targets a cloud SDK or native binding", () => {
    const violations: TopLevelImport[] = [];
    for (const file of SOURCE_FILES) {
      const full = path.join(CREDENTIALS_SRC, file);
      const source = fs.readFileSync(full, "utf8");
      const imports = extractTopLevelImports(file, source);
      for (const imp of imports) {
        if (FORBIDDEN_TOP_LEVEL_IMPORTS.some((re) => re.test(imp.spec))) {
          violations.push(imp);
        }
      }
    }
    expect(
      violations,
      "Found top-level static imports of optional SDK/native packages — " +
        "these must be reached via dynamic `import()` so the credentials " +
        "subpath stays light-weight when SDKs aren't used. Violations:\n" +
        violations
          .map((v) => `  ${v.file}:${v.line} → ${v.spec}`)
          .join("\n"),
    ).toEqual([]);
  });

  it("each forbidden SDK appears at least once via dynamic `import()`", () => {
    // Sanity: confirm the dynamic-import pattern is actually present, so
    // a future "I removed all SDK references" regression doesn't quietly
    // pass the first assertion.
    const keychain = fs.readFileSync(
      path.join(CREDENTIALS_SRC, "keychain.ts"),
      "utf8",
    );
    const cloud = fs.readFileSync(
      path.join(CREDENTIALS_SRC, "cloud_secrets.ts"),
      "utf8",
    );

    expect(keychain).toMatch(/@napi-rs\/keyring/);
    expect(keychain).toMatch(/await\s+import\s*\(/);

    expect(cloud).toMatch(/@aws-sdk\/client-secrets-manager/);
    expect(cloud).toMatch(/@google-cloud\/secret-manager/);
    expect(cloud).toMatch(/@azure\/keyvault-secrets/);
    expect(cloud).toMatch(/await\s+import\s*\(/);
  });
});
