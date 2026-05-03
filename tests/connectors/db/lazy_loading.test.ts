/**
 * Regression test: optional database driver SDK packages must only ever
 * be reached via dynamic `import()` — never via top-level static imports.
 *
 * The db connector relies on two layers of lazy loading:
 *
 *   1. `register.ts` dynamically imports each driver module
 *      (`./postgresql.js`, `./mongodb.js`, …) based on the connection
 *      URL scheme. Code paths that never touch a `postgres://` URL
 *      never load `postgresql.ts` at all.
 *
 *   2. Within each driver module, the optional SDK package
 *      (`pg`, `mongodb`, `mssql`, `oracledb`, `@aws-sdk/client-dynamodb`)
 *      is dynamically imported inside `connect()` on first use. Loading
 *      a driver module does not pull its SDK into memory.
 *
 * This invariant is what keeps the connector hub process small even
 * though `narai-primitives` declares all the SDKs in
 * `optionalDependencies`. If a future refactor promoted any of these
 * to a top-level static `import` the whole point of the lazy-loading
 * scaffolding is gone — every db consumer would pay tens of MB of
 * resident memory for SDKs they never call.
 *
 * Static analysis beats runtime checks here: ESM has no public
 * "loaded modules" registry to inspect, but the failure mode is purely
 * a top-level `import` statement being added — which a regex over the
 * source files catches deterministically.
 *
 * `better-sqlite3` is allowed at module top because it's a regular
 * (not optional) dependency of `narai-primitives`, and `sqlite.ts`
 * itself is lazy-imported by `register.ts` so the import only fires
 * when a `sqlite://` URL is actually opened.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVERS_DIR = path.resolve(
  HERE,
  "../../../src/connectors/db/lib/drivers",
);

/** Optional-dependency SDK packages that must not appear as top-level imports. */
const FORBIDDEN_TOP_LEVEL_IMPORTS = [
  /^pg(\/.*)?$/,
  /^mysql2(\/.*)?$/,
  /^mssql(\/.*)?$/,
  /^oracledb(\/.*)?$/,
  /^mongodb(\/.*)?$/,
  /^@aws-sdk\/client-dynamodb(\/.*)?$/,
];

/** Driver modules that gate one optional SDK each. sqlite is excluded —
 *  better-sqlite3 is a regular dependency. */
const LAZY_DRIVER_FILES = [
  "postgresql.ts",
  "mysql.ts",
  "sqlserver.ts",
  "oracle.ts",
  "mongodb.ts",
  "dynamodb.ts",
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
    // Match top-level `import ... from "x"` (no leading whitespace).
    // Includes `import type` since a type-only import of an SDK still
    // signals the boundary is leaking — the lazy contract is the only
    // load path we want.
    const match = line.match(/^import\s+(?:type\s+)?[^"']*["']([^"']+)["']/);
    if (match && match[1]) {
      out.push({ file, line: i + 1, spec: match[1] });
    }
  }
  return out;
}

describe("db connector: driver lazy-loading discipline", () => {
  it("no top-level static import targets an optional driver SDK", () => {
    const violations: TopLevelImport[] = [];
    for (const file of LAZY_DRIVER_FILES) {
      const full = path.join(DRIVERS_DIR, file);
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
      "Found top-level static imports of optional SDK packages in db drivers — " +
        "these must be reached via dynamic `import()` so loading the driver " +
        "module does not pull the SDK into memory. Violations:\n" +
        violations
          .map((v) => `  ${v.file}:${v.line} → ${v.spec}`)
          .join("\n"),
    ).toEqual([]);
  });

  it("each forbidden SDK appears at least once via dynamic `import()`", () => {
    // Sanity: a future refactor that removes all SDK references would
    // pass the first assertion vacuously. This guards against that by
    // confirming the dynamic-import pattern is actually in place per
    // driver.
    const checks: { file: string; sdk: RegExp }[] = [
      { file: "postgresql.ts", sdk: /["']pg["']/ },
      { file: "mysql.ts", sdk: /["']mysql2(?:\/[^"']+)?["']/ },
      { file: "sqlserver.ts", sdk: /["']mssql["']/ },
      { file: "oracle.ts", sdk: /["']oracledb["']/ },
      { file: "mongodb.ts", sdk: /["']mongodb["']/ },
      { file: "dynamodb.ts", sdk: /["']@aws-sdk\/client-dynamodb["']/ },
    ];
    for (const { file, sdk } of checks) {
      const source = fs.readFileSync(path.join(DRIVERS_DIR, file), "utf8");
      expect(source, `${file}: SDK reference missing entirely`).toMatch(sdk);
      expect(source, `${file}: missing await import() pattern`).toMatch(
        /await\s+import\s*\(/,
      );
    }
  });

  it("register.ts lazy-imports each driver module by URL scheme", () => {
    // This is the OUTER lazy layer: even loading a driver MODULE only
    // happens on demand, so importing the db connector entry doesn't
    // pull all 7 driver files (and therefore none of their SDKs)
    // into memory.
    const register = fs.readFileSync(
      path.resolve(DRIVERS_DIR, "register.ts"),
      "utf8",
    );
    const driverModules = [
      "./sqlite.js",
      "./postgresql.js",
      "./mysql.js",
      "./sqlserver.js",
      "./mongodb.js",
      "./dynamodb.js",
      "./oracle.js",
    ];
    for (const mod of driverModules) {
      const dynamicPattern = new RegExp(
        `await\\s+import\\s*\\(\\s*["']${mod.replace(/[.\/]/g, "\\$&")}["']`,
      );
      expect(register, `register.ts must dynamically import ${mod}`).toMatch(
        dynamicPattern,
      );
    }
    // No driver module should appear as a top-level import in register.ts
    // either — that would defeat the outer lazy layer.
    const topLevel = extractTopLevelImports("register.ts", register);
    const driverTopLevel = topLevel.filter((imp) =>
      driverModules.includes(imp.spec),
    );
    expect(
      driverTopLevel,
      "register.ts must not statically import driver modules",
    ).toEqual([]);
  });
});
