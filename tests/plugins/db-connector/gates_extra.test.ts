/**
 * Tests for the db-connector gate additions:
 *  - FIX 3: jdbc_url / db_uri_credentials are scanned on Write/Edit (applies_to),
 *    while source-code rules (import psycopg2, new Pool) stay Bash-only.
 *  - FIX 4: the opt-in gates.strict-bare.json denies a bare leading DML/DDL
 *    statement without firing inside grep/echo arguments.
 *
 * Both exercise the real exported applyGatesManifest engine against the
 * shipped JSON, so the preset data and the engine are tested together.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyGatesManifest } from "../../../plugin-hooks/dispatcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(__dirname, "..", "..", "..", "plugins", "db-connector");

function load(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN, name), "utf-8"));
}

function decide(
  manifest: unknown,
  text: string,
  scanTool: "Bash" | "Write" | "Edit",
): string | null {
  const decisions: { decision: string; reason: string }[] = [];
  applyGatesManifest(manifest, "db", text, new Set(), decisions, scanTool);
  if (decisions.length === 0) return null;
  const rank: Record<string, number> = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision]! - rank[a.decision]!);
  return decisions[0]!.decision;
}

describe("db gates.json — content scanning (FIX 3)", () => {
  const manifest = load("gates.json");

  it("denies a JDBC URL written to a file (Write)", () => {
    expect(decide(manifest, "db.url=jdbc:postgresql://h/db\nname=x", "Write")).toBe("deny");
  });

  it("denies a JDBC URL in an Edit's new text", () => {
    expect(decide(manifest, "jdbc:mysql://h/db", "Edit")).toBe("deny");
  });

  it("denies a credentialed DB URI written to a file", () => {
    expect(decide(manifest, "DATABASE_URL=postgres://user:pass@host:5432/db", "Write")).toBe("deny");
  });

  it("still denies a JDBC URL on Bash", () => {
    expect(decide(manifest, "java -jar app --url jdbc:postgresql://h/db", "Bash")).toBe("deny");
  });

  it("does NOT deny an import psycopg2 written to a .py file (Bash-only rule)", () => {
    expect(decide(manifest, "import psycopg2\nconn = psycopg2.connect()", "Write")).toBeNull();
  });

  it("does NOT deny a new Pool({host}) written to a .ts file (Bash-only rule)", () => {
    expect(decide(manifest, "const pool = new Pool({ host: 'db', database: 'x' })", "Write")).toBeNull();
  });
});

describe("db gates.strict-bare.json — bare leading DML (FIX 4)", () => {
  const manifest = load("gates.strict-bare.json");

  it.each([
    "INSERT INTO t VALUES(1)",
    "UPDATE users SET active=1",
    "DELETE FROM logs",
    "DROP TABLE foo",
    "TRUNCATE TABLE foo",
    "TRUNCATE foo",
    "drop table x",
  ])("denies bare %s", (cmd) => {
    expect(decide(manifest, cmd, "Bash")).toBe("deny");
  });

  it.each([
    "grep \"DELETE FROM\" app.log",
    "rg \"insert into\" src",
    "echo \"we should DROP TABLE temp later\"",
    "cat schema.sql",
    "git status",
  ])("does NOT deny benign %s", (cmd) => {
    expect(decide(manifest, cmd, "Bash")).toBeNull();
  });

  it("is not auto-loaded (separate filename, opt-in)", () => {
    expect(fs.existsSync(path.join(PLUGIN, "gates.strict-bare.json"))).toBe(true);
    // The dispatcher only auto-loads a file named exactly gates.json.
    expect(path.basename(path.join(PLUGIN, "gates.strict-bare.json"))).not.toBe("gates.json");
  });
});
