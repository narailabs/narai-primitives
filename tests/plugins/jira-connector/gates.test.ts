/**
 * gates.test.ts — pure unit tests for plugins/jira-connector/gates.json.
 *
 * Replicates the dispatcher's matching logic (regex per rule, per-segment
 * compound split, strictest decision wins) so we can verify every rule
 * without spawning a subprocess. Mirrors tests/plugins/git-connector/gates.test.ts.
 *
 * These rules are conservative illustrative examples: operators customize the
 * host and verbs in their own ~/.connectors/connectors/<slug>/gates.json.
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
  "jira-connector",
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

describe("gates.json — jira_state_changing_http (ask)", () => {
  it.each([
    "curl -X POST https://acme.atlassian.net/rest/api/3/issue",
    "curl -X PUT https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl -X DELETE https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl -X PATCH https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl --request POST https://acme.atlassian.net/rest/api/3/issue",
    "curl --request DELETE https://jira.example.com/rest/api/2/issue/AB-1",
    "curl https://acme.atlassian.net/rest/api/3/issue -X POST -d '{}'",
    "https -X POST https://acme.atlassian.net/rest/api/3/issue",
    "wget --request POST https://jira.internal/api -O -",
  ])("asks on %s", (cmd) => {
    expect(classify(cmd)).toEqual({
      name: "jira_state_changing_http",
      decision: "ask",
    });
  });

  it.each([
    "curl https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl -X GET https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl --request GET https://jira.example.com/rest/api/2/issue/AB-1",
    "curl -X POST https://example.com/webhook",
    "curl -X POST https://api.github.com/repos",
  ])("does not match %s", (cmd) => {
    expect(classify(cmd)).toBeNull();
  });

  // Documented limitation: the preset keys on an explicit -X/--request verb
  // flag, so HTTPie's positional-verb shorthand (e.g. `https POST <url>`) is
  // not matched. Operators who use that form should extend the pattern.
  it("does not match HTTPie positional-verb shorthand (documented limitation)", () => {
    expect(
      classify("https POST https://acme.atlassian.net/rest/api/3/issue"),
    ).toBeNull();
  });
});

describe("gates.json — jira manifest sanity", () => {
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
