/**
 * gates.test.ts — pure unit tests for plugins/db-connector/gates.json.
 *
 * Replicates the dispatcher's matching logic (regex per rule, per-segment
 * compound split, strictest decision wins) so we can verify every rule
 * without spawning a subprocess. This preset hardens the first-token
 * blocklist in hooks/guardrails.json by catching DB-access vectors that
 * route around the sanctioned connector (driver imports, JDBC URLs,
 * in-process clients, and inline-exec raw DML).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATES_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "plugins",
  "db-connector",
  "gates.json",
);

interface Rule {
  name: string;
  decision: "deny" | "ask" | "allow";
  reason: string;
  pattern: string;
}

const manifest = JSON.parse(fs.readFileSync(GATES_PATH, "utf-8")) as {
  rules: Rule[];
};

const RANK: Record<string, number> = { deny: 2, ask: 1, allow: 0 };

function splitCompound(cmd: string): string[] {
  if (typeof cmd !== "string") return [];
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts
    .map((p) => stripPrefix(p.trim()))
    .filter((p) => p.length > 0);
}

function stripPrefix(s: string): string {
  let cur = s;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  return cur.replace(/^(sudo|nice|time)\s+/, "");
}

function classify(
  command: string,
  disabled = new Set<string>(),
): { name: string; decision: string } | null {
  const matches: { name: string; decision: string }[] = [];
  for (const rule of manifest.rules) {
    if (disabled.has(rule.name)) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern);
    } catch {
      continue;
    }
    for (const segment of splitCompound(command)) {
      if (re.test(segment)) {
        matches.push({ name: rule.name, decision: rule.decision });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => RANK[b.decision] - RANK[a.decision]);
  return matches[0];
}

describe("gates.json — python_db_driver_import (deny)", () => {
  it.each([
    'python3 -c "import psycopg2"',
    'python -c "import psycopg"',
    'python -c "import pymysql"',
    'python -c "import MySQLdb"',
    'python -c "import sqlite3"',
    'python -c "import pymongo"',
    'python -c "import pyodbc"',
    'python -c "import asyncpg"',
    'python -c "import sqlalchemy"',
    "python -c 'from sqlalchemy import create_engine'",
    "python -c 'from psycopg2 import connect'",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "python_db_driver_import",
      decision: "deny",
    });
  });

  it("does not fire on a non-db import", () => {
    expect(classify('python -c "import os"')).toBeNull();
  });
});

describe("gates.json — node_db_driver_require (deny)", () => {
  it.each([
    'node -e "require(\'pg\')"',
    'node -e "require(\'mysql\')"',
    'node -e "require(\'mysql2\')"',
    'node -e "require(\'mongodb\')"',
    'node -e "require(\'mssql\')"',
    'node -e "require(\'tedious\')"',
    'node -e "require(\'better-sqlite3\')"',
    'node -e "require(\'sqlite3\')"',
    'node -e "require(\'oracledb\')"',
    'node -e "require( \'pg\' )"',
    'node -e "require(\\"pg\\")"',
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "node_db_driver_require",
      decision: "deny",
    });
  });

  it("does not fire on a non-db require", () => {
    expect(classify('node -e "require(\'fs\')"')).toBeNull();
  });
});

describe("gates.json — jdbc_url (deny)", () => {
  it.each([
    "java -jar app --url jdbc:postgresql://h/db",
    "java -jar app --url jdbc:mysql://h/db",
    "java -jar app --url jdbc:mariadb://h/db",
    "java -jar app --url jdbc:sqlserver://h/db",
    "java -jar app --url jdbc:oracle://h/db",
    "java -jar app --url jdbc:sqlite://h/db",
    "java -jar app --url jdbc:mongodb://h/db",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)).toEqual({ name: "jdbc_url", decision: "deny" });
  });
});

describe("gates.json — node_db_client_construct (deny, scoped)", () => {
  it.each([
    'node --eval "const {Pool}=require(\'pg\'); new Pool({host:\'db\',database:\'x\'})"',
    'node -e "new Client({host:\'db\',port:5432})"',
    'node -e "new Pool({connectionString:\'postgres://h/db\'})"',
    'node -e "new Client({user:\'u\',password:\'p\',database:\'x\'})"',
  ])("denies %s", (cmd) => {
    expect(classify(cmd)?.decision).toBe("deny");
  });

  it("does not fire on a non-db new Client (AWS-style, no host/db key)", () => {
    expect(classify("node -e \"new Client({ region: 'us' })\"")).toBeNull();
  });
});

describe("gates.json — raw_dml_exec (deny, scoped to exec context)", () => {
  it.each([
    "python -c \"cur.execute('INSERT INTO t VALUES(1)')\"",
    "python -c \"cur.execute('UPDATE t SET x=1')\"",
    "python -c \"cur.execute('DELETE FROM t')\"",
    "python -c \"cur.execute('DROP TABLE t')\"",
    "python -c \"cur.execute('TRUNCATE TABLE t')\"",
    "python -c \"cur.execute('TRUNCATE t')\"",
  ])("denies %s", (cmd) => {
    expect(classify(cmd)?.decision).toBe("deny");
  });

  it("denies mixed-case DML in exec context (char-class case handling)", () => {
    expect(
      classify("python -c \"cur.execute('InSeRt InTo t VALUES(1)')\"")
        ?.decision,
    ).toBe("deny");
  });

  it("denies DML via node --eval", () => {
    expect(
      classify('node --eval "db.query(\'DELETE FROM users\')"')?.decision,
    ).toBe("deny");
  });
});

describe("gates.json — safe benign commands (must allow)", () => {
  it.each([
    "git status",
    "npm install",
    "ls -la",
    "cat schema.sql",
    'grep "DELETE FROM" app.log',
    'rg "insert into" src',
    'echo "we should DROP TABLE temp later"',
    'python -c "import os"',
    "node -e \"require('fs')\"",
    "node -e \"new Client({ region: 'us' })\"",
  ])("%s does not match any rule", (cmd) => {
    expect(classify(cmd)).toBeNull();
  });
});

describe("gates.json — compound commands", () => {
  it("strictest decision wins across a chain", () => {
    const d = classify('ls -la && python3 -c "import psycopg2"');
    expect(d?.decision).toBe("deny");
  });

  it("env prefix on a chained interpreter still classifies", () => {
    expect(
      classify("cd app && FOO=bar python3 -c \"import psycopg2\"")?.decision,
    ).toBe("deny");
  });
});

describe("gates.json — manifest sanity", () => {
  it("every rule has required fields with valid shape", () => {
    for (const r of manifest.rules) {
      expect(typeof r.name).toBe("string");
      expect(["deny", "ask", "allow"]).toContain(r.decision);
      expect(typeof r.reason).toBe("string");
      expect(typeof r.pattern).toBe("string");
      expect(() => new RegExp(r.pattern)).not.toThrow();
    }
  });

  it("rule names are unique", () => {
    const names = manifest.rules.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
