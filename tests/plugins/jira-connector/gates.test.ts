/**
 * gates.test.ts — tests for plugins/jira-connector/gates.json.
 *
 * Drives the real exported applyGatesManifest engine against the shipped
 * manifest, so the declarative external_write rule and the engine are tested
 * together. These rules are conservative illustrative examples: operators add
 * their own host(s) in ~/.connectors/connectors/jira/gates.json.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyGatesManifest } from "../../../plugin-hooks/dispatcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATES_PATH = path.resolve(
  __dirname, "..", "..", "..", "plugins", "jira-connector", "gates.json",
);
const manifest = JSON.parse(fs.readFileSync(GATES_PATH, "utf-8"));

function decide(command: string): string | null {
  const decisions: { decision: string; reason: string }[] = [];
  applyGatesManifest(manifest, "jira", command, new Set<string>(), decisions, "Bash");
  if (decisions.length === 0) return null;
  const rank: Record<string, number> = { deny: 2, ask: 1, allow: 0 };
  decisions.sort((a, b) => rank[b.decision]! - rank[a.decision]!);
  return decisions[0]!.decision;
}

describe("jira gates — external_write (ask on writes to atlassian.net)", () => {
  it.each([
    "curl -X POST https://acme.atlassian.net/rest/api/3/issue",
    "curl -X PUT https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl -X DELETE https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl -X PATCH https://acme.atlassian.net/rest/api/3/issue/AB-1",
    "curl --request POST https://acme.atlassian.net/rest/api/3/issue",
    "curl https://acme.atlassian.net/rest/api/3/issue -X POST -d '{}'",
    "https POST https://acme.atlassian.net/rest/api/3/issue", // HTTPie, explicit scheme
    "https POST acme.atlassian.net/rest/api/3/issue", // HTTPie positional, scheme-less
    "wget --method=POST https://acme.atlassian.net/api",
  ])("asks on %s", (cmd) => {
    expect(decide(cmd)).toBe("ask");
  });

  it.each([
    "curl https://acme.atlassian.net/rest/api/3/issue/AB-1", // GET
    "curl -X GET https://acme.atlassian.net/rest/api/3/issue", // GET verb
    "curl -X POST https://example.com/webhook", // host not allowlisted
    "curl -X POST https://api.github.com/repos",
  ])("allows %s", (cmd) => {
    expect(decide(cmd)).toBeNull();
  });

  // Anchored host: these previously over-matched a bare `jira`/`atlassian.net`
  // substring and now correctly DO NOT fire.
  it.each([
    "curl -X POST https://evil.com/jira-notes", // path token
    "curl -X POST https://atlassian.net.evil.com/x", // suffix spoof
    "curl -X POST https://user:atlassian.net@evil.com/x", // userinfo spoof
    "curl -X POST https://evil-atlassian.net/x", // label-prefix spoof
    "curl --request DELETE https://jira.example.com/rest/api", // self-hosted host not in allowlist
  ])("does not over-match %s", (cmd) => {
    expect(decide(cmd)).toBeNull();
  });
});

describe("jira manifest sanity", () => {
  it("every rule is a valid external_write or pattern rule", () => {
    for (const r of manifest.rules) {
      expect(typeof r.name).toBe("string");
      expect(["deny", "ask", "allow"]).toContain(r.decision);
      expect(typeof r.reason).toBe("string");
      if (r.type === "external_write") {
        expect(Array.isArray(r.methods) && r.methods.length > 0).toBe(true);
        expect(Array.isArray(r.allowed_hosts)).toBe(true);
      } else {
        expect(typeof r.pattern).toBe("string");
        expect(() => new RegExp(r.pattern)).not.toThrow();
      }
    }
  });

  it("rule names are unique", () => {
    const names = manifest.rules.map((r: { name: string }) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
